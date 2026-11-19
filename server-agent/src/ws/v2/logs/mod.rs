//! Session-scoped binding between protocol v2 log frames and the retained
//! redacted buffer.
//!
//! Nothing here reads process output or formats a log line. Tail batches,
//! searches and context windows are built only from [`LogStore`] records that
//! were sanitized and redacted before insertion.
//!
//! The binding lives for one WebSocket connection. A reconnect cancels every
//! tail and request it held, so a late result can never answer the next
//! session. Work runs in separate tasks: the v2 loop keeps reading frames and
//! answering status while a search scans or a slow control plane drains a
//! tail batch.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::logs::{LogLevel, LogRecord, LogSource, LogStore};
use crate::ws::v2::codec::{
    self, LOGS_BATCH_MAX_RECORDS, LOGS_CONTEXT_MAX_LINES, LogErrorCode, LogGap, LogsBatch,
    LogsContext, LogsError, LogsGap, LogsSearch, LogsSubscribe, LogsUnsubscribe,
};

mod jobs;
mod tail;

/// Commands a session hands to its log worker. The queue is bounded so a
/// stalled worker backpressures requests instead of growing memory.
const COMMAND_QUEUE: usize = 64;
/// Outbound log frames waiting for the socket writer.
const REPLY_QUEUE: usize = 8;
/// Live tails one agent serves at once.
const MAX_SUBSCRIPTIONS: usize = 16;
/// Searches running at once. The store itself has the same global bound.
const MAX_SEARCHES: usize = 2;
/// Context lookups running at once.
const MAX_CONTEXTS: usize = 8;
/// How often an idle tail checks for new records.
const TAIL_POLL: Duration = Duration::from_millis(500);
/// Every search or context reply is produced or failed within this window.
const JOB_DEADLINE: Duration = Duration::from_secs(8);

/// One request from the control plane, already validated by the codec.
pub(crate) enum Command {
    Subscribe(LogsSubscribe),
    Unsubscribe(LogsUnsubscribe),
    Search(LogsSearch),
    CancelSearch(String),
    Context(LogsContext),
}

impl Command {
    /// The subscription id a rejection must name, when the command has one.
    fn subscription_id(&self) -> Option<&str> {
        match self {
            Self::Subscribe(request) => Some(&request.subscription_id),
            Self::Unsubscribe(request) => Some(&request.subscription_id),
            Self::Search(_) | Self::CancelSearch(_) | Self::Context(_) => None,
        }
    }

    /// The request id a rejection must name, when the command has one.
    fn request_id(&self) -> Option<&str> {
        match self {
            Self::Search(request) => Some(&request.request_id),
            Self::CancelSearch(request_id) => Some(request_id),
            Self::Context(request) => Some(&request.request_id),
            Self::Subscribe(_) | Self::Unsubscribe(_) => None,
        }
    }
}

/// The session's end of the log worker.
pub(crate) struct Session {
    replies: mpsc::Receiver<String>,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
    handle: Handle,
}

/// A cheap admission handle, so the code that reads incoming frames never
/// borrows the receiver owned by the select loop.
pub(crate) struct Handle {
    commands: mpsc::Sender<Command>,
}

impl Session {
    /// Starts the worker for one WebSocket connection. `cancel` is this
    /// connection's token, not the process-wide shutdown token.
    pub(crate) fn start(store: LogStore, cancel: CancellationToken) -> Self {
        let (commands, command_rx) = mpsc::channel(COMMAND_QUEUE);
        let (reply_tx, replies) = mpsc::channel(REPLY_QUEUE);
        let worker_cancel = cancel.child_token();
        let task = tokio::spawn(run_worker(store, command_rx, reply_tx, worker_cancel));
        Self {
            replies,
            cancel,
            task: Some(task),
            handle: Handle { commands },
        }
    }

    pub(crate) fn handle(&self) -> Handle {
        self.handle.clone()
    }

    /// The next frame to write, already encoded. `None` means the worker
    /// stopped, which ends the connection that owns it.
    pub(crate) async fn recv(&mut self) -> Option<String> {
        self.replies.recv().await
    }

    /// Cancels and joins the worker and every task it spawned.
    pub(crate) async fn shutdown(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take()
            && let Err(error) = task.await
        {
            warn!("log worker stopped with an error: {error}");
        }
    }
}

impl Handle {
    /// Queues one request without waiting on the worker. A full queue is
    /// reported as `busy` for requests that expect an answer; cancellation
    /// commands are delivered behind the queued work so a tail or scan still
    /// stops.
    pub(crate) fn admit(&self, command: Command) -> Result<(), LogsError> {
        match self.commands.try_send(command) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(command)) => Err(error_for(
                command,
                LogErrorCode::Unavailable,
                "the log worker is not running",
            )),
            Err(mpsc::error::TrySendError::Full(command)) => match command {
                Command::Unsubscribe(_) | Command::CancelSearch(_) => {
                    // A full queue must not drop the only frame that can stop
                    // a tail or scan. Deliver it behind the queued work
                    // without blocking the socket loop.
                    let commands = self.commands.clone();
                    tokio::spawn(async move {
                        let _ = commands.send(command).await;
                    });
                    Ok(())
                }
                command => Err(error_for(
                    command,
                    LogErrorCode::Busy,
                    "the log worker queue is full",
                )),
            },
        }
    }
}

impl Clone for Handle {
    fn clone(&self) -> Self {
        Self {
            commands: self.commands.clone(),
        }
    }
}

fn error_for(command: Command, code: LogErrorCode, message: &str) -> LogsError {
    LogsError {
        code,
        subscription_id: command.subscription_id().map(str::to_owned),
        request_id: command.request_id().map(str::to_owned),
        message: message.to_string(),
    }
}

/// One finished worker task. The id releases the capacity it held.
enum Finished {
    Tail(String),
    Search(String),
    Context(String),
}

struct Worker {
    store: LogStore,
    replies: mpsc::Sender<String>,
    tasks: JoinSet<Finished>,
    tails: HashMap<String, CancellationToken>,
    searches: HashMap<String, CancellationToken>,
    contexts: HashMap<String, CancellationToken>,
}

impl Worker {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>, cancel: CancellationToken) {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                command = commands.recv() => {
                    let Some(command) = command else {
                        break;
                    };
                    self.handle(command, &cancel).await;
                }
                finished = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    match finished {
                        Some(Ok(Finished::Tail(id))) => {
                            self.tails.remove(&id);
                        }
                        Some(Ok(Finished::Search(id))) => {
                            self.searches.remove(&id);
                        }
                        Some(Ok(Finished::Context(id))) => {
                            self.contexts.remove(&id);
                        }
                        Some(Err(error)) => warn!("a log worker task failed: {error}"),
                        None => {}
                    }
                }
            }
        }
        self.tails.values().for_each(CancellationToken::cancel);
        self.searches.values().for_each(CancellationToken::cancel);
        self.contexts.values().for_each(CancellationToken::cancel);
    }

    async fn handle(&mut self, command: Command, cancel: &CancellationToken) {
        match command {
            Command::Subscribe(request) => {
                if !self.tails.contains_key(&request.subscription_id)
                    && self.tails.len() >= MAX_SUBSCRIPTIONS
                {
                    let error = error_for(
                        Command::Subscribe(request),
                        LogErrorCode::Busy,
                        "too many live log tails",
                    );
                    emit(&self.replies, "logs.error", &error, cancel).await;
                    return;
                }
                let id = request.subscription_id.clone();
                if let Some(previous) = self.tails.remove(&id) {
                    previous.cancel();
                }
                let token = cancel.child_token();
                self.tails.insert(id.clone(), token.clone());
                let store = self.store.clone();
                let replies = self.replies.clone();
                self.tasks.spawn(async move {
                    tail::run(store, replies, token, request).await;
                    Finished::Tail(id)
                });
            }
            Command::Unsubscribe(request) => {
                if let Some(token) = self.tails.remove(&request.subscription_id) {
                    token.cancel();
                }
            }
            Command::Search(request) => {
                let id = request.request_id.clone();
                let duplicate = self.searches.contains_key(&id) || self.contexts.contains_key(&id);
                let capacity = self.searches.len() < MAX_SEARCHES;
                if duplicate || !capacity {
                    let (code, message) = if duplicate {
                        (LogErrorCode::InvalidRequest, "request id is in use")
                    } else {
                        (LogErrorCode::Busy, "too many concurrent log searches")
                    };
                    let error = error_for(Command::Search(request), code, message);
                    emit(&self.replies, "logs.error", &error, cancel).await;
                    return;
                }
                let token = cancel.child_token();
                self.searches.insert(id.clone(), token.clone());
                let store = self.store.clone();
                let replies = self.replies.clone();
                self.tasks.spawn(async move {
                    jobs::search(store, replies, token, request).await;
                    Finished::Search(id)
                });
            }
            Command::CancelSearch(id) => {
                if let Some(token) = self.searches.get(&id) {
                    token.cancel();
                }
            }
            Command::Context(request) => {
                let id = request.request_id.clone();
                let duplicate = self.searches.contains_key(&id) || self.contexts.contains_key(&id);
                let capacity = self.contexts.len() < MAX_CONTEXTS;
                if duplicate || !capacity {
                    let (code, message) = if duplicate {
                        (LogErrorCode::InvalidRequest, "request id is in use")
                    } else {
                        (LogErrorCode::Busy, "too many concurrent context lookups")
                    };
                    let error = error_for(Command::Context(request), code, message);
                    emit(&self.replies, "logs.error", &error, cancel).await;
                    return;
                }
                let token = cancel.child_token();
                self.contexts.insert(id.clone(), token.clone());
                let store = self.store.clone();
                let replies = self.replies.clone();
                self.tasks.spawn(async move {
                    jobs::context(store, replies, token, request).await;
                    Finished::Context(id)
                });
            }
        }
    }
}

async fn run_worker(
    store: LogStore,
    commands: mpsc::Receiver<Command>,
    replies: mpsc::Sender<String>,
    cancel: CancellationToken,
) {
    Worker {
        store,
        replies,
        tasks: JoinSet::new(),
        tails: HashMap::new(),
        searches: HashMap::new(),
        contexts: HashMap::new(),
    }
    .run(commands, cancel)
    .await;
}

/// Encodes and queues one result. Returns false when the connection is gone.
pub(super) async fn emit<P: Serialize>(
    replies: &mpsc::Sender<String>,
    message_type: &str,
    payload: &P,
    cancel: &CancellationToken,
) -> bool {
    let Ok(text) = codec::encode(message_type, payload, None) else {
        warn!(%message_type, "failed to encode a v2 log frame");
        return false;
    };
    tokio::select! {
        _ = cancel.cancelled() => false,
        sent = replies.send(text) => sent.is_ok(),
    }
}

pub(super) fn cursor(cursor: crate::logs::LogCursor) -> codec::LogCursor {
    codec::LogCursor {
        generation: codec::LogGeneration::new(cursor.generation),
        seq: cursor.seq,
    }
}

pub(super) fn search_cursor(cursor: crate::logs::SearchCursor) -> codec::LogSearchCursor {
    codec::LogSearchCursor {
        generation: codec::LogGeneration::new(cursor.generation),
        pinned_seq: cursor.pinned_seq,
        before: cursor.before,
        floor: cursor.floor,
    }
}

pub(super) fn record(record: &LogRecord) -> codec::LogRecord {
    codec::LogRecord {
        seq: record.seq,
        time: record.time,
        source: source(record.source),
        level: level(record.level),
        process_generation: record.process_generation,
        text: record.text.clone(),
        truncated: record.truncated,
    }
}

pub(super) fn gap(gap: crate::logs::LogGap) -> LogGap {
    use crate::logs::GapReason;
    LogGap {
        reason: match gap.reason {
            GapReason::Restarted => codec::LogGapReason::Restarted,
            GapReason::Overwritten => codec::LogGapReason::Overwritten,
        },
        from_seq: gap.from_seq,
        to_seq: gap.to_seq,
    }
}

pub(super) fn source(source: LogSource) -> codec::LogSource {
    match source {
        LogSource::Agent => codec::LogSource::Agent,
        LogSource::SingBox => codec::LogSource::SingBox,
    }
}

pub(super) fn level(level: LogLevel) -> codec::LogsLevel {
    match level {
        LogLevel::Trace => codec::LogsLevel::Trace,
        LogLevel::Debug => codec::LogsLevel::Debug,
        LogLevel::Info => codec::LogsLevel::Info,
        LogLevel::Warn => codec::LogsLevel::Warn,
        LogLevel::Error => codec::LogsLevel::Error,
    }
}

pub(super) fn error_payload(
    code: LogErrorCode,
    subscription_id: Option<&str>,
    request_id: Option<&str>,
    message: impl Into<String>,
) -> LogsError {
    LogsError {
        code,
        subscription_id: subscription_id.map(str::to_owned),
        request_id: request_id.map(str::to_owned),
        message: message.into(),
    }
}

/// Emits a `logs.error` that names exactly one id. The `LogErrorCode` and
/// string are always a valid contract payload, so encoding cannot fail here.
pub(super) async fn emit_error(
    replies: &mpsc::Sender<String>,
    cancel: &CancellationToken,
    code: LogErrorCode,
    subscription_id: Option<&str>,
    request_id: Option<&str>,
    message: &str,
) {
    let payload = error_payload(code, subscription_id, request_id, message);
    let _ = emit(replies, "logs.error", &payload, cancel).await;
}

/// Emits `logs.gap` for one subscription.
pub(super) async fn emit_gap(
    replies: &mpsc::Sender<String>,
    cancel: &CancellationToken,
    subscription_id: &str,
    generation: u64,
    gap: LogGap,
) -> bool {
    let payload = LogsGap {
        subscription_id: subscription_id.to_string(),
        generation: codec::LogGeneration::new(generation),
        gap,
    };
    emit(replies, "logs.gap", &payload, cancel).await
}

/// Emits one `logs.batch`.
pub(super) async fn emit_batch(
    replies: &mpsc::Sender<String>,
    cancel: &CancellationToken,
    batch: LogsBatch,
) -> bool {
    emit(replies, "logs.batch", &batch, cancel).await
}

/// A tail's filter, copied out of the wire type.
pub(super) fn filter(value: &codec::LogFilter) -> (Option<LogSource>, Option<LogLevel>) {
    let source = value.source.map(|source| match source {
        codec::LogSource::Agent => LogSource::Agent,
        codec::LogSource::SingBox => LogSource::SingBox,
    });
    let level = value.min_level.map(|level| match level {
        codec::LogsLevel::Trace => LogLevel::Trace,
        codec::LogsLevel::Debug => LogLevel::Debug,
        codec::LogsLevel::Info => LogLevel::Info,
        codec::LogsLevel::Warn => LogLevel::Warn,
        codec::LogsLevel::Error => LogLevel::Error,
    });
    (source, level)
}

pub(super) fn matches(
    record: &LogRecord,
    source: Option<LogSource>,
    min: Option<LogLevel>,
) -> bool {
    source.is_none_or(|source| record.source == source) && min.is_none_or(|min| record.level >= min)
}

/// The batch record limit as a usable count. The codec already bounded it.
pub(super) fn batch_limit(limit: u64) -> usize {
    usize::try_from(limit)
        .unwrap_or(LOGS_BATCH_MAX_RECORDS)
        .min(LOGS_BATCH_MAX_RECORDS)
}

pub(super) fn context_limit(value: u64) -> usize {
    usize::try_from(value)
        .unwrap_or(LOGS_CONTEXT_MAX_LINES)
        .min(LOGS_CONTEXT_MAX_LINES)
}

#[cfg(test)]
mod tests;
