//! Supervises the sing-box child process via processkit.
//!
//! A background task owns the running process: it captures sing-box's stdout
//! and stderr into the retained log buffer and forwards them to `tracing`,
//! restarts it with backoff if it crashes, and shuts the whole process tree
//! down gracefully on replacement or agent exit.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use processkit::{CancellationToken, Command, ProcessEvent, RunningProcess};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::StreamExt;
use tracing::{debug, error, info, warn};

use crate::logs::{
    LogLevel, LogSource, LogStore, PrivateKeyBlock, SING_BOX_OUTPUT_TARGET, strip_ansi,
};

/// Grace period for a SIGTERM before processkit escalates to SIGKILL on shutdown.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Cap on reading buffered output after the child is reaped, so a lingering
/// pipe held by an escaped descendant cannot stall shutdown.
const OUTPUT_DRAIN: Duration = Duration::from_secs(2);
/// Restart backoff bounds after an unexpected sing-box exit.
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A process that ran at least this long before exiting is treated as healthy,
/// so its next restart starts from the minimum backoff. Shorter runs are a
/// crash loop and grow the backoff toward the ceiling.
const HEALTHY_UPTIME: Duration = Duration::from_secs(10);

enum Ctrl {
    /// Graceful stop; the ack fires once the tree is down.
    Shutdown(oneshot::Sender<()>),
}

pub struct SingBoxManager {
    ctrl_tx: mpsc::Sender<Ctrl>,
    task: tokio::task::JoinHandle<()>,
    state: Arc<AtomicU8>,
    last_error: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Starting = 0,
    Running = 1,
    Stopped = 2,
    CrashLoop = 3,
}

impl ProcessState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::CrashLoop => "crash_loop",
        }
    }
}

impl SingBoxManager {
    /// Resolves the sing-box binary, starts it against `config_path`, and spawns
    /// the supervisor. Returns once the first launch succeeds so startup errors
    /// (missing binary, bad initial config) surface immediately. Every line the
    /// child writes is also captured into the shared log buffer.
    pub async fn start(bin: PathBuf, config_path: PathBuf) -> Result<Self> {
        Self::start_with_logs(bin, config_path, LogStore::shared()).await
    }

    pub(crate) async fn start_with_logs(
        bin: PathBuf,
        config_path: PathBuf,
        logs: LogStore,
    ) -> Result<Self> {
        let proc = spawn_singbox(&bin, &config_path, &logs)
            .await
            .context("failed to start sing-box")?;
        info!("sing-box started (pid {:?})", proc.process.pid());

        let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let state = Arc::new(AtomicU8::new(ProcessState::Starting as u8));
        let last_error = Arc::new(Mutex::new(None));
        let task = tokio::spawn(supervise(
            proc,
            bin,
            config_path,
            ctrl_rx,
            state.clone(),
            last_error.clone(),
            logs,
        ));
        Ok(Self {
            ctrl_tx,
            task,
            state,
            last_error,
        })
    }

    pub fn state(&self) -> ProcessState {
        match self.state.load(Ordering::Relaxed) {
            0 => ProcessState::Starting,
            1 => ProcessState::Running,
            3 => ProcessState::CrashLoop,
            _ => ProcessState::Stopped,
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok()?.clone()
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

struct ManagedProcess {
    process: RunningProcess,
    cancel: CancellationToken,
    /// Sing-box run number, recorded on each captured line.
    generation: u64,
}

async fn spawn_singbox(bin: &Path, config_path: &Path, logs: &LogStore) -> Result<ManagedProcess> {
    let config = config_path
        .to_str()
        .context("config path is not valid UTF-8")?;
    let cancel = CancellationToken::new();
    let process = Command::new(bin)
        .args(["run", "-c", config])
        .cancel_on(cancel.clone())
        .cancel_grace(SHUTDOWN_GRACE)
        .start()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(ManagedProcess {
        process,
        cancel,
        generation: logs.begin_process_generation(),
    })
}

/// Validates a candidate with the exact sing-box binary that will run it.
/// `check` decodes and constructs the service graph without touching the live
/// process. Output is bounded before it can be reported upstream.
pub async fn check_config(bin: &Path, config_path: &Path) -> Result<()> {
    check_config_with_logs(bin, config_path, &LogStore::shared()).await
}

async fn check_config_with_logs(bin: &Path, config_path: &Path, logs: &LogStore) -> Result<()> {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(bin)
            .args(["check", "-c"])
            .arg(config_path)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("sing-box check timed out")?
    .context("failed to execute sing-box check")?;
    if output.status.success() {
        return Ok(());
    }
    let mut message = String::from_utf8_lossy(&output.stderr).into_owned();
    if message.trim().is_empty() {
        message = String::from_utf8_lossy(&output.stdout).into_owned();
    }
    // Redact before capping: a cut could leave a credential's prefix behind.
    let message = strip_ansi(message.trim());
    let message = logs.redact_message(&message);
    let message: String = message.chars().take(4096).collect();
    Err(anyhow::anyhow!(message))
}

pub async fn singbox_version(bin: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(bin)
            .arg("version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find_map(|line| line.strip_prefix("sing-box version "))
        .map(str::to_owned)
}

/// The supervisor loop. Owns the process for its whole lifetime; each iteration
/// runs one sing-box until it exits or is told to stop, then restarts on crash.
async fn supervise(
    proc: ManagedProcess,
    bin: PathBuf,
    config_path: PathBuf,
    mut ctrl_rx: mpsc::Receiver<Ctrl>,
    state: Arc<AtomicU8>,
    last_error: Arc<Mutex<Option<String>>>,
    logs: LogStore,
) {
    let mut current = proc;
    // Grows across quick crashes, resets after a healthy run. Persisted here (not
    // inside the restart helper) so a fast crash loop actually backs off — each
    // process starts fine and only dies later, so per-restart state would never grow.
    let mut backoff = BACKOFF_MIN;

    loop {
        let started = Instant::now();
        match run_one(current, &mut ctrl_rx, &state, &last_error, &logs).await {
            RunOutcome::Stopped => {
                state.store(ProcessState::Stopped as u8, Ordering::Relaxed);
                info!("sing-box stopped");
                return;
            }
            RunOutcome::Exited => {}
        }

        state.store(ProcessState::CrashLoop as u8, Ordering::Relaxed);

        if started.elapsed() >= HEALTHY_UPTIME {
            // Ran long enough to count as healthy; treat this as a one-off exit.
            backoff = BACKOFF_MIN;
            warn!("sing-box exited after a healthy run; restarting in {backoff:?}");
        } else {
            warn!(
                "sing-box crashed after {:?}; restarting in {backoff:?}",
                started.elapsed()
            );
        }

        match restart(&bin, &config_path, backoff, &mut ctrl_rx, &logs).await {
            Some(next) => current = next,
            // Told to shut down while backing off, or the channel closed.
            None => return,
        }
        state.store(ProcessState::Starting as u8, Ordering::Relaxed);
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
    logs: &LogStore,
) -> Option<ManagedProcess> {
    let mut delay = backoff;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(Ctrl::Shutdown(ack)) => {
                    let _ = ack.send(());
                    return None;
                }
                None => return None,
            },
        }

        match spawn_singbox(bin, config_path, logs).await {
            Ok(proc) => {
                info!("sing-box restarted (pid {:?})", proc.process.pid());
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

/// Pumps one process's output to tracing until it exits or a shutdown control
/// arrives.
async fn run_one(
    proc: ManagedProcess,
    ctrl_rx: &mut mpsc::Receiver<Ctrl>,
    state: &Arc<AtomicU8>,
    last_error: &Arc<Mutex<Option<String>>>,
    logs: &LogStore,
) -> RunOutcome {
    let ManagedProcess {
        mut process,
        cancel,
        generation,
    } = proc;
    let mut events = match process.events() {
        Ok(events) => events,
        Err(e) => {
            error!("failed to read sing-box output: {e}");
            return RunOutcome::Exited;
        }
    };
    let finish = process.finish();
    tokio::pin!(finish);
    let mut healthy_timer = Box::pin(tokio::time::sleep(HEALTHY_UPTIME));
    let mut marked_healthy = false;
    // One block state per run: stdout and stderr share the sing-box source, and
    // a new run or an ended stream never inherits an open key block.
    let mut key_block = PrivateKeyBlock::default();

    loop {
        tokio::select! {
            _ = &mut healthy_timer, if !marked_healthy => {
                state.store(ProcessState::Running as u8, Ordering::Relaxed);
                marked_healthy = true;
            }
            result = &mut finish => {
                if let Err(e) = result {
                    error!("failed to wait for sing-box: {e}");
                }
                drain_output(&mut events, logs, generation, &mut key_block, last_error).await;
                return RunOutcome::Exited;
            }
            event = events.next() => match event {
                Some(event) => {
                    record_output(event, logs, generation, &mut key_block, last_error);
                },
                // Both streams closed: the process has exited.
                None => return RunOutcome::Exited,
            },
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(Ctrl::Shutdown(ack)) => {
                    cancel.cancel();
                    let _ = finish.await;
                    // Final lines emitted while shutting down are still
                    // captured and redacted before the buffers close.
                    drain_output(&mut events, logs, generation, &mut key_block, last_error).await;
                    let _ = ack.send(());
                    return RunOutcome::Stopped;
                }
                // Control channel dropped without an explicit shutdown: stop.
                None => {
                    cancel.cancel();
                    let _ = finish.await;
                    drain_output(&mut events, logs, generation, &mut key_block, last_error).await;
                    return RunOutcome::Stopped;
                }
            },
        }
    }
}

/// Drains every remaining line after the child has been reaped, so shutdown
/// and exit output is captured with the same redaction as live output.
async fn drain_output<S>(
    events: &mut S,
    logs: &LogStore,
    generation: u64,
    key_block: &mut PrivateKeyBlock,
    last_error: &Arc<Mutex<Option<String>>>,
) where
    S: tokio_stream::Stream<Item = ProcessEvent> + Unpin,
{
    let drain = async {
        while let Some(event) = events.next().await {
            record_output(event, logs, generation, key_block, last_error);
        }
    };
    if tokio::time::timeout(OUTPUT_DRAIN, drain).await.is_err() {
        debug!("sing-box output stayed open after exit; stopped draining");
    }
}

fn record_output(
    event: ProcessEvent,
    logs: &LogStore,
    generation: u64,
    key_block: &mut PrivateKeyBlock,
    last_error: &Arc<Mutex<Option<String>>>,
) {
    if let Some(message) = forward_log(event, logs, generation, key_block)
        && let Ok(mut slot) = last_error.lock()
    {
        *slot = Some(message);
    }
}

/// Captures one line of sing-box output and forwards it to local logging.
///
/// sing-box colours its own output with ANSI escapes, which are stripped first:
/// `tracing`'s formatter would otherwise print the raw escapes, and our own
/// subscriber applies level colour anyway. The level comes from the tag sing-box
/// embeds in the line, mirroring the level sing-box itself assigns. The buffer
/// records the line with its real source and process run, so the tracing layer
/// skips it under [`SING_BOX_OUTPUT_TARGET`] to avoid a second copy.
fn forward_log(
    event: ProcessEvent,
    logs: &LogStore,
    generation: u64,
    key_block: &mut PrivateKeyBlock,
) -> Option<String> {
    let raw = match &event {
        ProcessEvent::Stdout(line) | ProcessEvent::Stderr(line) => line.text(),
        _ => return None,
    };
    let line = strip_ansi(raw.trim_end());
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let level = singbox_level(line);
    // The buffer and `last_error` (reported upstream) get the sanitized text.
    // Local output below keeps the line as sing-box wrote it.
    let stored = logs.record_line(key_block, LogSource::SingBox, level, generation, line);
    match level {
        LogLevel::Error => {
            error!(target: SING_BOX_OUTPUT_TARGET, "sing-box: {line}");
            stored
        }
        LogLevel::Warn => {
            warn!(target: SING_BOX_OUTPUT_TARGET, "sing-box: {line}");
            None
        }
        LogLevel::Debug | LogLevel::Trace => {
            debug!(target: SING_BOX_OUTPUT_TARGET, "sing-box: {line}");
            None
        }
        LogLevel::Info => {
            info!(target: SING_BOX_OUTPUT_TARGET, "sing-box: {line}");
            None
        }
    }
}

/// Reads the level tag sing-box writes into a line.
fn singbox_level(line: &str) -> LogLevel {
    if line.contains("ERROR") || line.contains("FATAL") {
        LogLevel::Error
    } else if line.contains("WARN") {
        LogLevel::Warn
    } else if line.contains("DEBUG") || line.contains("TRACE") {
        LogLevel::Debug
    } else {
        LogLevel::Info
    }
}

#[cfg(test)]
mod tests {
    use super::{Duration, SingBoxManager, check_config, check_config_with_logs, strip_ansi};
    use crate::logs::{LogStore, SecretScope};

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_observes_output_and_process_exit() {
        use super::*;

        let cancel = CancellationToken::new();
        let process = Command::new("sh")
            .args(["-c", "echo 'ERROR expected failure' >&2; exit 1"])
            .cancel_on(cancel.clone())
            .cancel_grace(SHUTDOWN_GRACE)
            .start()
            .await
            .unwrap();
        let (_tx, mut rx) = mpsc::channel(1);
        let state = Arc::new(AtomicU8::new(0));
        let last_error = Arc::new(Mutex::new(None));
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            run_one(
                ManagedProcess {
                    process,
                    cancel,
                    generation: 1,
                },
                &mut rx,
                &state,
                &last_error,
                &LogStore::default(),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, RunOutcome::Exited));
        assert!(
            last_error
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .contains("expected failure")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_stops_on_shutdown() {
        use super::*;

        let cancel = CancellationToken::new();
        let process = Command::new("sh")
            .args(["-c", "exec sleep 60"])
            .cancel_on(cancel.clone())
            .cancel_grace(SHUTDOWN_GRACE)
            .start()
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::channel(1);
        let (ack, received) = oneshot::channel();
        tx.send(Ctrl::Shutdown(ack)).await.unwrap();
        let state = Arc::new(AtomicU8::new(0));
        let last_error = Arc::new(Mutex::new(None));
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            run_one(
                ManagedProcess {
                    process,
                    cancel,
                    generation: 1,
                },
                &mut rx,
                &state,
                &last_error,
                &LogStore::default(),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, RunOutcome::Stopped));
        received.await.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_output_is_captured_and_redacted() {
        use crate::logs::{LogStore, SecretScope};

        const SECRET: &str = concat!("shutdown", "-credential-", "7731");
        let dir = scratch_dir("drain");
        let pid_file = dir.join("pid");
        let bin = fake_singbox(
            &dir,
            &format!(
                "trap 'echo \"ERROR shutdown {SECRET}\"; exit 0' TERM\n\
                 echo $$ > '{}'\n\
                 echo 'INFO ready'\n\
                 while :; do sleep 1; done",
                pid_file.display()
            ),
        );
        let logs = LogStore::default();
        logs.replace_secrets(SecretScope::NodeCredentials, [SECRET])
            .unwrap();
        let manager = SingBoxManager::start_with_logs(bin, dir.join("config.json"), logs.clone())
            .await
            .unwrap();
        wait_until(|| {
            pid_file.exists()
                && logs
                    .resume(None, 100)
                    .unwrap()
                    .records
                    .iter()
                    .any(|record| record.text == "INFO ready")
        })
        .await;

        manager.shutdown().await;

        let texts: Vec<String> = logs
            .resume(None, 100)
            .unwrap()
            .records
            .into_iter()
            .map(|record| record.text.clone())
            .collect();
        assert!(
            texts.iter().any(|text| text == "ERROR shutdown [REDACTED]"),
            "{texts:?}"
        );
        assert!(texts.iter().all(|text| !text.contains(SECRET)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Writes an executable stand-in for sing-box into a fresh directory.
    #[cfg(target_os = "linux")]
    fn fake_singbox(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let bin = dir.join("fake-sing-box");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        bin
    }

    #[cfg(target_os = "linux")]
    fn scratch_dir(name: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("blossom-{name}-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Polls until `ready` holds, failing the test after five seconds.
    #[cfg(target_os = "linux")]
    async fn wait_until(mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !ready() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("condition not reached in time");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn supervised_output_is_captured_by_source_and_shuts_down_cleanly() {
        use crate::logs::{LogLevel, LogSource, LogStore, SecretScope};

        let dir = scratch_dir("supervise");
        let pid_file = dir.join("pid");
        let bin = fake_singbox(
            &dir,
            &format!(
                "echo 'INFO sing-box ready'\n\
                 echo 'ERROR listener failed secret=hunter2-secret-token' >&2\n\
                 echo $$ > '{}'\n\
                 exec sleep 60",
                pid_file.display()
            ),
        );
        let logs = LogStore::default();
        logs.replace_secrets(SecretScope::Agent, ["hunter2-secret-token"])
            .unwrap();
        let manager = SingBoxManager::start_with_logs(bin, dir.join("config.json"), logs.clone())
            .await
            .unwrap();

        let captured = || logs.resume(None, 100).unwrap().records;
        wait_until(|| captured().len() == 2 && pid_file.exists()).await;
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let live = std::path::PathBuf::from(format!("/proc/{pid}"));
        assert!(
            live.exists(),
            "sing-box child should be running before shutdown"
        );

        let records = captured();
        assert_eq!(records.len(), 2, "each child line is captured exactly once");
        let shapes: Vec<_> = records
            .iter()
            .map(|r| (r.source, r.level, r.process_generation, r.text.as_str()))
            .collect();
        assert!(shapes.contains(&(LogSource::SingBox, LogLevel::Info, 1, "INFO sing-box ready")));
        assert!(shapes.contains(&(
            LogSource::SingBox,
            LogLevel::Error,
            1,
            "ERROR listener failed secret=[REDACTED]"
        )));

        manager.shutdown().await;
        assert!(!live.exists(), "sing-box child survived shutdown");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn check_config_errors_are_redacted_before_retention() {
        use crate::logs::{LogStore, SecretScope};

        const SECRET: &str = "synthetic-check-credential";
        let dir = scratch_dir("check-redact");
        let bin = fake_singbox(
            &dir,
            &format!("echo \"FATAL invalid credential {SECRET}\" >&2\nexit 1"),
        );
        let logs = LogStore::default();
        logs.replace_secrets(SecretScope::NodeCredentials, [SECRET])
            .unwrap();
        let error = check_config_with_logs(&bin, &dir.join("config.json"), &logs)
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains(SECRET), "{error}");
        assert!(error.contains("[REDACTED]"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn high_volume_child_output_is_bounded_and_never_stalls_the_child() {
        use crate::logs::{LogCursor, LogSource, LogStore};

        let dir = scratch_dir("volume");
        let done_file = dir.join("done");
        let bin = fake_singbox(
            &dir,
            &format!(
                "i=0\nwhile [ $i -lt 5000 ]; do echo \"INFO line $i\"; i=$((i+1)); done\n\
                 touch '{}'\nexec sleep 60",
                done_file.display()
            ),
        );
        let logs = LogStore::default();
        let manager = SingBoxManager::start_with_logs(bin, dir.join("config.json"), logs.clone())
            .await
            .unwrap();

        // The child reaches its final statement only if its pipe kept draining.
        wait_until(|| done_file.exists()).await;
        wait_until(|| {
            logs.resume(None, 1)
                .unwrap()
                .records
                .first()
                .is_some_and(|r| r.text == "INFO line 4999")
        })
        .await;
        // Replay the whole buffer in bounded batches. Nothing is evicted at this
        // volume, so every line is retained exactly once and in order.
        let generation = logs.generation().unwrap();
        let mut cursor = LogCursor { generation, seq: 0 };
        let mut replayed = Vec::new();
        loop {
            let batch = logs.resume(Some(cursor), 500).unwrap();
            assert_eq!(batch.gap, None);
            replayed.extend(batch.records.iter().map(|r| r.text.clone()));
            cursor = batch.next;
            if !batch.has_more {
                break;
            }
        }
        assert_eq!(replayed.len(), 5000);
        assert_eq!(replayed.first().map(String::as_str), Some("INFO line 0"));
        assert_eq!(replayed.last().map(String::as_str), Some("INFO line 4999"));
        assert!(
            logs.resume(None, 1)
                .unwrap()
                .records
                .iter()
                .all(|r| r.source == LogSource::SingBox)
        );
        manager.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

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

    #[cfg(unix)]
    #[tokio::test]
    async fn check_config_returns_bounded_singbox_error() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("blossom-check-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-sing-box");
        let config = dir.join("candidate.json");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho 'ERROR decode config: inbounds[1].tls: invalid' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&config, "{}").unwrap();

        let error = check_config(&bin, &config).await.unwrap_err().to_string();
        assert!(error.contains("inbounds[1].tls"));
        assert!(error.len() <= 4096);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Runs `script` under `sh -c` as one supervised run into `logs` and returns
    /// the run's last error line.
    #[cfg(unix)]
    async fn run_script(script: &str, logs: &LogStore, generation: u64) -> Option<String> {
        use super::*;

        let cancel = CancellationToken::new();
        let process = Command::new("sh")
            .args(["-c", script])
            .cancel_on(cancel.clone())
            .cancel_grace(SHUTDOWN_GRACE)
            .start()
            .await
            .unwrap();
        let (_tx, mut rx) = mpsc::channel(1);
        let state = Arc::new(AtomicU8::new(0));
        let last_error = Arc::new(Mutex::new(None));
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            run_one(
                ManagedProcess {
                    process,
                    cancel,
                    generation,
                },
                &mut rx,
                &state,
                &last_error,
                logs,
            ),
        )
        .await
        .unwrap();
        assert!(matches!(outcome, RunOutcome::Exited));
        last_error.lock().unwrap().clone()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn key_blocks_and_node_credentials_stay_out_of_the_buffer() {
        let logs = LogStore::default();
        logs.replace_secrets(SecretScope::NodeCredentials, ["node-pass-7731"])
            .unwrap();
        // The key lines share one stdout stream, so their order is fixed. The
        // stderr line may land inside the open block and be dropped with it,
        // so it is checked only in the form it may take.
        let script = "echo '-----BEGIN OPENSSH PRIVATE KEY-----'\n\
                      echo 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'\n\
                      echo '-----END OPENSSH PRIVATE KEY-----'\n\
                      echo 'ERROR after the key'\n\
                      echo 'ERROR outbound rejected password=node-pass-7731' >&2\n\
                      exit 1";
        let last_error = run_script(script, &logs, 1).await;

        let texts: Vec<String> = logs
            .resume(None, 100)
            .unwrap()
            .records
            .into_iter()
            .map(|record| record.text.clone())
            .collect();
        assert!(texts.iter().all(|text| !text.contains("b3Bl")));
        assert!(texts.iter().all(|text| !text.contains("node-pass-7731")));
        assert_eq!(
            texts
                .iter()
                .filter(|text| text.as_str() == "[REDACTED PRIVATE KEY]")
                .count(),
            1
        );
        assert!(texts.iter().any(|text| text == "ERROR after the key"));
        for text in texts
            .iter()
            .filter(|text| text.contains("outbound rejected"))
        {
            assert_eq!(text, "ERROR outbound rejected password=[REDACTED]");
        }
        assert!(last_error.is_some_and(|text| !text.contains("node-pass-7731")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_new_run_never_inherits_an_open_key_block() {
        let logs = LogStore::default();
        run_script(
            "echo '-----BEGIN PRIVATE KEY-----'\necho 'MIIEvQIBADAN'\nexit 1",
            &logs,
            1,
        )
        .await;
        run_script("echo 'ERROR recovered after restart'\nexit 1", &logs, 2).await;

        let texts: Vec<String> = logs
            .resume(None, 100)
            .unwrap()
            .records
            .into_iter()
            .map(|record| record.text.clone())
            .collect();
        assert_eq!(
            texts,
            vec![
                "[REDACTED PRIVATE KEY]".to_owned(),
                "ERROR recovered after restart".to_owned()
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn check_config_redacts_credentials_before_the_length_cap() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let secret = "check-node-credential";
        let logs = LogStore::default();
        logs.replace_secrets(SecretScope::NodeCredentials, [secret])
            .unwrap();
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("blossom-check-redact-{suffix}"));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-sing-box");
        let config = dir.join("candidate.json");
        // The secret starts at byte 4080, so a cap applied first would leave its
        // prefix in the message.
        std::fs::write(
            &bin,
            format!("#!/bin/sh\nprintf 'ERROR decode %4066s {secret}\\n' '' >&2\nexit 1\n"),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&config, "{}").unwrap();

        let error = super::check_config_with_logs(&bin, &config, &logs)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("[REDACTED]"));
        assert!(!error.contains("check-node-cred"));
        assert!(error.chars().count() <= 4096);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
