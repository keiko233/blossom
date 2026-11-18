//! `portable-pty` adapter for the PTY manager.
//!
//! Each session has three dedicated OS threads: a blocking reader, a blocking
//! writer, and a child waiter. Tokio workers never perform PTY syscalls. The
//! reader and writer queues are bounded; a blocked consumer eventually stops
//! the shell instead of growing an unbounded buffer.

use std::io::{Read, Write};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::ports::{PtyFactory, PtyProcess};
use super::{PtyDimensions, PtyError, PtyEvent, Utf8Chunker};

const INBOUND_WRITES: usize = 64;
const READ_CHUNK_BYTES: usize = 8 * 1024;

pub struct PortablePtyFactory {
    events: mpsc::Sender<PtyEvent>,
}

impl PortablePtyFactory {
    pub fn new(events: mpsc::Sender<PtyEvent>) -> Self {
        Self { events }
    }
}

impl PtyFactory for PortablePtyFactory {
    fn spawn(
        &self,
        session_id: &str,
        dimensions: PtyDimensions,
    ) -> Result<Box<dyn PtyProcess>, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(dimensions))
            .map_err(|error| PtyError::Spawn(error.to_string()))?;

        let mut command = CommandBuilder::new_default_prog();
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // The shell must not inherit control-plane credentials that happen to
        // live in the agent's process environment.
        for key in ["AGENT_TOKEN", "AGENT_GITHUB_TOKEN", "GITHUB_TOKEN"] {
            command.env_remove(key);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        let mut killer = child.clone_killer();
        let writer_queue = spawn_writer(session_id, writer)?;

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
        Ok(Box::new(PortablePtyProcess {
            master,
            writer: writer_queue,
            killer,
        }))
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
