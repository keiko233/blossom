//! Supervises the sing-box child process via processkit.
//!
//! A background task owns the running process: it forwards sing-box's logs to
//! `tracing`, restarts it with backoff if it crashes, hot-reloads it on demand
//! via SIGHUP (sing-box re-reads the same config path in place — no restart,
//! sub-second window), and shuts the whole process tree down gracefully on exit.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use processkit::{Command, OutputEvent, RunningProcess};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::StreamExt;
use tracing::{debug, error, info, warn};

/// Grace period for a SIGTERM before processkit escalates to SIGKILL on shutdown.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Restart backoff bounds after an unexpected sing-box exit.
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A process that ran at least this long before exiting is treated as healthy,
/// so its next restart starts from the minimum backoff. Shorter runs are a
/// crash loop and grow the backoff toward the ceiling.
const HEALTHY_UPTIME: Duration = Duration::from_secs(10);

enum Ctrl {
    /// Hot-reload: SIGHUP the running sing-box so it re-reads its config file.
    Reload,
    /// Graceful stop; the ack fires once the tree is down.
    Shutdown(oneshot::Sender<()>),
}

pub struct SingBoxManager {
    ctrl_tx: mpsc::Sender<Ctrl>,
    task: tokio::task::JoinHandle<()>,
}

impl SingBoxManager {
    /// Resolves the sing-box binary, starts it against `config_path`, and spawns
    /// the supervisor. Returns once the first launch succeeds so startup errors
    /// (missing binary, bad initial config) surface immediately.
    pub async fn start(bin: PathBuf, config_path: PathBuf) -> Result<Self> {
        let proc = spawn_singbox(&bin, &config_path)
            .await
            .context("failed to start sing-box")?;
        info!("sing-box started (pid {:?})", proc.pid());

        let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let task = tokio::spawn(supervise(proc, bin, config_path, ctrl_rx));
        Ok(Self { ctrl_tx, task })
    }

    /// Requests an in-place config reload (SIGHUP). Fire-and-forget: the
    /// supervisor logs the outcome.
    pub async fn reload(&self) -> Result<()> {
        self.ctrl_tx
            .send(Ctrl::Reload)
            .await
            .map_err(|_| anyhow::anyhow!("supervisor is gone"))
    }

    /// Gracefully stops sing-box and its descendants, waiting for the tree to exit.
    pub async fn shutdown(self) {
        let (ack_tx, ack_rx) = oneshot::channel();
        if self.ctrl_tx.send(Ctrl::Shutdown(ack_tx)).await.is_ok() {
            let _ = ack_rx.await;
        }
        // Supervisor returns after shutdown; join it so drop doesn't cancel mid-stop.
        let _ = self.task.await;
    }
}

/// Locates the sing-box binary: explicit override, then `./sing-box`, then PATH.
pub fn resolve_binary(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(path) = explicit {
        return path;
    }
    let local = std::env::current_dir()
        .map(|d| d.join("sing-box"))
        .unwrap_or_default();
    if local.exists() {
        return local;
    }
    PathBuf::from("sing-box")
}

async fn spawn_singbox(bin: &Path, config_path: &Path) -> Result<RunningProcess> {
    let config = config_path
        .to_str()
        .context("config path is not valid UTF-8")?;
    Command::new(bin)
        .args(["run", "-c", config])
        .start()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// The supervisor loop. Owns the process for its whole lifetime; each iteration
/// runs one sing-box until it exits or is told to stop, then restarts on crash.
async fn supervise(
    proc: RunningProcess,
    bin: PathBuf,
    config_path: PathBuf,
    mut ctrl_rx: mpsc::Receiver<Ctrl>,
) {
    let mut current = proc;
    // Grows across quick crashes, resets after a healthy run. Persisted here (not
    // inside the restart helper) so a fast crash loop actually backs off — each
    // process starts fine and only dies later, so per-restart state would never grow.
    let mut backoff = BACKOFF_MIN;

    loop {
        let started = Instant::now();
        match run_one(current, &mut ctrl_rx).await {
            RunOutcome::Stopped => {
                info!("sing-box stopped");
                return;
            }
            RunOutcome::Exited => {}
        }

        if started.elapsed() >= HEALTHY_UPTIME {
            // Ran long enough to count as healthy; treat this as a one-off exit.
            backoff = BACKOFF_MIN;
            warn!("sing-box exited after a healthy run; restarting in {backoff:?}");
        } else {
            warn!("sing-box crashed after {:?}; restarting in {backoff:?}", started.elapsed());
        }

        match restart(&bin, &config_path, backoff, &mut ctrl_rx).await {
            Some(next) => current = next,
            // Told to shut down while backing off, or the channel closed.
            None => return,
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Waits out `backoff`, then spawns sing-box, retrying the spawn itself with
/// growing delay if it fails. Stays responsive to a shutdown request throughout;
/// returns `None` if asked to stop (or the control channel closed) first.
async fn restart(
    bin: &Path,
    config_path: &Path,
    backoff: Duration,
    ctrl_rx: &mut mpsc::Receiver<Ctrl>,
) -> Option<RunningProcess> {
    let mut delay = backoff;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(Ctrl::Shutdown(ack)) => {
                    let _ = ack.send(());
                    return None;
                }
                // Ignore reloads while there is no process to signal.
                Some(Ctrl::Reload) => continue,
                None => return None,
            },
        }

        match spawn_singbox(bin, config_path).await {
            Ok(proc) => {
                info!("sing-box restarted (pid {:?})", proc.pid());
                return Some(proc);
            }
            Err(e) => {
                delay = (delay * 2).min(BACKOFF_MAX);
                error!("restart attempt failed: {e}; retrying in {delay:?}");
            }
        }
    }
}

enum RunOutcome {
    /// Told to shut down; tree is already stopped.
    Stopped,
    /// The process exited on its own (crash) — caller should restart.
    Exited,
}

/// Pumps one process's output to tracing until it exits or a shutdown/reload
/// control arrives. Reload sends SIGHUP and keeps running; shutdown stops it.
async fn run_one(mut proc: RunningProcess, ctrl_rx: &mut mpsc::Receiver<Ctrl>) -> RunOutcome {
    let pid = proc.pid();
    let mut events = match proc.output_events() {
        Ok(events) => events,
        Err(e) => {
            error!("failed to read sing-box output: {e}");
            return RunOutcome::Exited;
        }
    };

    loop {
        tokio::select! {
            event = events.next() => match event {
                Some(event) => forward_log(event),
                // Both streams closed: the process has exited.
                None => return RunOutcome::Exited,
            },
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(Ctrl::Reload) => reload_process(pid),
                Some(Ctrl::Shutdown(ack)) => {
                    drop(events);
                    if let Err(e) = proc.shutdown(SHUTDOWN_GRACE).await {
                        error!("error during sing-box shutdown: {e}");
                    }
                    let _ = ack.send(());
                    return RunOutcome::Stopped;
                }
                // Control channel dropped without an explicit shutdown: stop.
                None => {
                    drop(events);
                    let _ = proc.shutdown(SHUTDOWN_GRACE).await;
                    return RunOutcome::Stopped;
                }
            },
        }
    }
}

/// Sends SIGHUP so sing-box hot-reloads its config file in place. On non-Unix
/// there is no SIGHUP; the supervisor would need a stop+start, but the agent
/// targets Unix hosts, so this is a hard error there.
fn reload_process(pid: Option<u32>) {
    let Some(pid) = pid else {
        error!("cannot reload: sing-box pid unknown");
        return;
    };

    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        match kill(Pid::from_raw(pid as i32), Signal::SIGHUP) {
            Ok(()) => info!("sent SIGHUP to sing-box (pid {pid}); config reloaded in place"),
            Err(e) => error!("failed to send SIGHUP to sing-box: {e}"),
        }
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        error!("SIGHUP reload is only supported on Unix");
    }
}

/// Maps a sing-box log line onto a tracing level by its embedded level tag,
/// mirroring the level sing-box itself assigns.
///
/// sing-box colours its own output with ANSI escapes. Those are stripped here:
/// `tracing`'s formatter escapes control bytes in a message (so a raw ESC would
/// print as a literal `\x1b[36m`), and the level colour is re-applied by our own
/// subscriber anyway — so the embedded codes are pure noise.
fn forward_log(event: OutputEvent) {
    let Some(raw) = event.text() else {
        return;
    };
    let line = strip_ansi(raw.trim_end());
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if line.contains("ERROR") || line.contains("FATAL") {
        error!("sing-box: {line}");
    } else if line.contains("WARN") {
        warn!("sing-box: {line}");
    } else if line.contains("DEBUG") || line.contains("TRACE") {
        debug!("sing-box: {line}");
    } else {
        info!("sing-box: {line}");
    }
}

/// Removes ANSI escape sequences (CSI `ESC [ … final`, plus stray lone ESCs).
/// Returns the input unchanged when it holds no ESC, avoiding an allocation on
/// the common path.
fn strip_ansi(input: &str) -> std::borrow::Cow<'_, str> {
    if !input.contains('\x1b') {
        return std::borrow::Cow::Borrowed(input);
    }
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // Skip a CSI sequence: `ESC [` then params/intermediates up to a final
        // byte in 0x40..=0x7e. A bare ESC (no `[`) just drops the ESC itself.
        if chars.clone().next() == Some('[') {
            chars.next();
            for f in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&f) {
                    break;
                }
            }
        }
    }
    std::borrow::Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn strips_color_codes() {
        let input = "+0800 19:49:27 \x1b[36mINFO\x1b[0m v2ray-api: grpc server started";
        assert_eq!(
            strip_ansi(input),
            "+0800 19:49:27 INFO v2ray-api: grpc server started"
        );
    }

    #[test]
    fn leaves_plain_text_borrowed() {
        assert!(matches!(
            strip_ansi("no escapes here"),
            std::borrow::Cow::Borrowed(_)
        ));
    }
}
