//! `portable-pty` adapter for the PTY manager.
//!
//! Each session has three dedicated OS threads: a blocking reader, a blocking
//! writer, and a child waiter. Tokio workers never perform PTY syscalls. The
//! reader and writer queues are bounded; a blocked consumer eventually stops
//! the shell instead of growing an unbounded buffer.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::launch::{
    LaunchConfig, check_working_dir, controlled_environment, is_runnable_file, resolve_shell,
};
use super::ports::{PtyFactory, PtyProcess, SpawnedPty};
use super::{PtyDimensions, PtyError, PtyEvent, Utf8Chunker};

const INBOUND_WRITES: usize = 64;
const READ_CHUNK_BYTES: usize = 8 * 1024;

pub struct PortablePtyFactory {
    events: mpsc::Sender<PtyEvent>,
    launch: LaunchConfig,
    user: String,
}

impl PortablePtyFactory {
    pub fn new(events: mpsc::Sender<PtyEvent>, launch: LaunchConfig, user: String) -> Self {
        Self {
            events,
            launch,
            user,
        }
    }
}

impl PtyFactory for PortablePtyFactory {
    fn spawn(&self, session_id: &str, dimensions: PtyDimensions) -> Result<SpawnedPty, PtyError> {
        // Validate the local configuration before allocating anything, so a
        // bad shell or directory is reported without a half-built PTY.
        check_working_dir(&self.launch.working_dir)?;
        let shell = resolve_shell(self.launch.shell.as_deref(), is_runnable_file)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(dimensions))
            .map_err(|error| PtyError::PtyAllocation(error.to_string()))?;

        let mut command = interactive_command(&shell, &self.launch.working_dir);
        command.env_clear();
        for (key, value) in controlled_environment(
            |key| std::env::var(key).ok(),
            &shell,
            &self.user,
            &self.launch.working_dir,
        ) {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| spawn_error(&shell, error))?;
        drop(pair.slave);

        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(PtyError::Spawn(error.to_string()));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(PtyError::Spawn(error.to_string()));
            }
        };
        let mut killer = child.clone_killer();
        let writer_queue = match spawn_writer(session_id, writer) {
            Ok(queue) => queue,
            Err(error) => {
                let _ = killer.kill();
                return Err(error);
            }
        };

        let read_events = self.events.clone();
        let read_session = session_id.to_string();
        let read_thread = thread::Builder::new()
            .name(format!("pty-read-{session_id}"))
            .spawn(move || {
                let mut chunker = Utf8Chunker::default();
                let mut buffer = [0u8; READ_CHUNK_BYTES];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            let data = chunker.feed(&buffer[..read]);
                            if data.is_empty() {
                                continue;
                            }
                            let event = PtyEvent::Data {
                                session_id: read_session.clone(),
                                data,
                            };
                            if read_events.blocking_send(event).is_err() {
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => {
                            warn!(
                                session = %read_session,
                                "pty reader stopped: {error}"
                            );
                            let _ = read_events.blocking_send(PtyEvent::ReadError {
                                session_id: read_session.clone(),
                            });
                            break;
                        }
                    }
                }
            });
        if let Err(error) = read_thread {
            let _ = killer.kill();
            return Err(PtyError::Spawn(format!(
                "could not start PTY reader: {error}"
            )));
        }

        let wait_events = self.events.clone();
        let wait_session = session_id.to_string();
        let mut wait_killer = child.clone_killer();
        let wait_thread = thread::Builder::new()
            .name(format!("pty-wait-{session_id}"))
            .spawn(move || match child.wait() {
                Ok(status) => {
                    debug!(session = %wait_session, "pty shell exited");
                    let _ = wait_events.blocking_send(PtyEvent::Exited {
                        session_id: wait_session,
                        code: Some(status.exit_code()),
                        signal: status.signal().map(str::to_owned),
                    });
                }
                Err(error) => {
                    warn!(
                        session = %wait_session,
                        "pty waiter stopped: {error}"
                    );
                    let _ = wait_events.blocking_send(PtyEvent::ReadError {
                        session_id: wait_session,
                    });
                }
            });
        if let Err(error) = wait_thread {
            let _ = wait_killer.kill();
            return Err(PtyError::Spawn(format!(
                "could not start PTY waiter: {error}"
            )));
        }

        // The reader owns a clone of the master fd and the writer owns the
        // original write handle; retaining the master here keeps `resize`
        // available for the session lifetime.
        let master = pair.master;
        Ok(SpawnedPty {
            process: Box::new(PortablePtyProcess {
                master,
                writer: writer_queue,
                killer,
            }),
            shell: shell.to_string_lossy().into_owned(),
        })
    }
}

/// Interactive, not login: `-i` keeps job control and prompts on a PTY, and
/// the working directory comes from local configuration.
fn interactive_command(shell: &Path, working_dir: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell);
    command.arg("-i");
    command.cwd(working_dir);
    command
}

/// Separates a missing or non-executable shell from other spawn failures so
/// the UI can point at the configuration rather than a generic error.
fn spawn_error(shell: &Path, error: anyhow::Error) -> PtyError {
    match error.downcast_ref::<std::io::Error>() {
        Some(io)
            if matches!(
                io.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            PtyError::ShellUnavailable(format!("{} cannot be executed: {io}", shell.display()))
        }
        _ => PtyError::Spawn(error.to_string()),
    }
}

fn spawn_writer(
    session_id: &str,
    mut writer: Box<dyn Write + Send>,
) -> Result<SyncSender<Vec<u8>>, PtyError> {
    let (sender, receiver) = sync_channel::<Vec<u8>>(INBOUND_WRITES);
    let thread_name = format!("pty-write-{session_id}");
    let session = session_id.to_string();
    thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            while let Ok(data) = receiver.recv() {
                if let Err(error) = writer.write_all(&data) {
                    warn!(session = %session, "pty writer stopped: {error}");
                    break;
                }
                if let Err(error) = writer.flush() {
                    warn!(session = %session, "pty writer flush failed: {error}");
                    break;
                }
            }
        })
        .map_err(|error| PtyError::Spawn(format!("could not start PTY writer: {error}")))?;
    Ok(sender)
}

struct PortablePtyProcess {
    master: Box<dyn MasterPty + Send>,
    writer: SyncSender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl PtyProcess for PortablePtyProcess {
    fn write(&mut self, data: &[u8]) -> Result<(), PtyError> {
        self.writer
            .try_send(data.to_vec())
            .map_err(|error| match error {
                TrySendError::Full(_) => PtyError::InputBackpressure,
                TrySendError::Disconnected(_) => PtyError::Closed,
            })
    }

    fn resize(&mut self, dimensions: PtyDimensions) -> Result<(), PtyError> {
        self.master
            .resize(pty_size(dimensions))
            .map_err(|error| PtyError::Io(error.to_string()))
    }

    fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for PortablePtyProcess {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}

fn pty_size(dimensions: PtyDimensions) -> PtySize {
    PtySize {
        rows: dimensions.rows,
        cols: dimensions.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use super::PortablePtyFactory;
    use crate::pty::launch::LaunchConfig;
    use crate::pty::{
        DEFAULT_MAX_SESSION, PtyDimensions, PtyError, PtyEvent, PtyExitReason, PtyLimits,
        PtyManager,
    };

    fn new_manager(
        shell: Option<&str>,
        working_dir: &str,
    ) -> (PtyManager, mpsc::Receiver<PtyEvent>) {
        let (sender, receiver) = mpsc::channel(64);
        let factory = PortablePtyFactory::new(
            sender,
            LaunchConfig {
                shell: shell.map(PathBuf::from),
                working_dir: PathBuf::from(working_dir),
            },
            "tester".to_owned(),
        );
        let manager = PtyManager::new(
            PtyLimits::new(true, 1, Duration::from_secs(60), DEFAULT_MAX_SESSION),
            "tester".to_owned(),
            Box::new(factory),
        );
        (manager, receiver)
    }

    /// Collects shell output until `needle` appears, failing on a timeout or an
    /// unexpected exit so a broken shell surfaces as a clear assertion.
    async fn read_until(events: &mut mpsc::Receiver<PtyEvent>, output: &mut String, needle: &str) {
        tokio::time::timeout(Duration::from_secs(15), async {
            while !output.contains(needle) {
                match events.recv().await {
                    Some(PtyEvent::Data { data, .. }) => output.push_str(&data),
                    other => panic!("waiting for {needle:?}, got {other:?}; output: {output:?}"),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; output: {output:?}"));
    }

    #[tokio::test]
    async fn interactive_shell_runs_input_resize_and_reports_exit_status() {
        let (mut manager, mut events) = new_manager(Some("/bin/sh"), "/");
        let started = manager
            .open("pty-1", PtyDimensions::clamped(80, 24))
            .expect("shell starts");
        assert_eq!(started.shell, "/bin/sh");
        assert_eq!(started.user, "tester");

        let mut output = String::new();
        manager
            .write("pty-1", b"echo blossom-$((6*7))\n")
            .expect("input accepted");
        read_until(&mut events, &mut output, "blossom-42").await;

        manager
            .resize("pty-1", PtyDimensions::clamped(100, 30))
            .expect("resize accepted");
        manager
            .write("pty-1", b"stty size\n")
            .expect("input accepted");
        read_until(&mut events, &mut output, "30 100").await;

        manager.write("pty-1", b"exit 3\n").expect("input accepted");
        let code = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match events.recv().await {
                    Some(PtyEvent::Exited { code, .. }) => return code,
                    // The shell may print a final prompt before it exits.
                    Some(PtyEvent::Data { .. }) => continue,
                    other => panic!("expected the shell to exit, got {other:?}"),
                }
            }
        })
        .await
        .expect("shell exits");
        assert_eq!(code, Some(3));
    }

    #[tokio::test]
    async fn default_shell_resolves_to_bash_or_sh() {
        let (mut manager, _events) = new_manager(None, "/");
        let started = manager
            .open("pty-default", PtyDimensions::clamped(80, 24))
            .expect("default shell starts");
        assert!(
            started.shell == "/bin/bash" || started.shell == "/bin/sh",
            "unexpected shell {}",
            started.shell
        );
    }

    #[tokio::test]
    async fn missing_or_non_executable_shell_is_reported_before_allocation() {
        let (mut manager, _events) = new_manager(Some("/nonexistent/blossom-shell"), "/");
        let error = manager
            .open("pty-missing", PtyDimensions::clamped(80, 24))
            .expect_err("missing shell must fail");
        assert!(matches!(error, PtyError::ShellUnavailable(_)), "{error:?}");
        assert_eq!(error.exit_reason(), PtyExitReason::ShellUnavailable);

        let plain =
            std::env::temp_dir().join(format!("blossom-pty-not-executable-{}", std::process::id()));
        std::fs::write(&plain, b"not a program").expect("write fixture");
        let (mut manager, _events) = new_manager(plain.to_str(), "/");
        let error = manager
            .open("pty-plain", PtyDimensions::clamped(80, 24))
            .expect_err("non-executable shell must fail");
        let _ = std::fs::remove_file(&plain);
        assert!(matches!(error, PtyError::ShellUnavailable(_)), "{error:?}");
    }

    #[tokio::test]
    async fn missing_working_directory_is_reported_as_a_shell_startup_failure() {
        let (mut manager, _events) = new_manager(Some("/bin/sh"), "/nonexistent/blossom-cwd");
        let error = manager
            .open("pty-cwd", PtyDimensions::clamped(80, 24))
            .expect_err("missing working directory must fail");
        assert!(matches!(error, PtyError::ShellUnavailable(_)), "{error:?}");
    }
}
