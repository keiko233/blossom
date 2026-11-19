//! Bounded assembly and digest verification of a v2 configuration snapshot.
//!
//! The body is the v3 configuration document, byte for byte. Chunks arrive in
//! order, and the assembler holds at most one snapshot at a time, never more
//! than the negotiated size. A chunk for an unknown request is ignored without
//! disturbing the snapshot in flight. Any other failure discards the partial
//! snapshot, and nothing reaches the apply path until the SHA-256 digest of the
//! complete body matches.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest as _, Sha256};

use super::codec::{
    ConfigIdentifier, Limits, MAX_SNAPSHOT_BYTES, SNAPSHOT_CHUNK_BYTES, SnapshotBegin,
    SnapshotChunk, SnapshotEnd,
};

/// The size bounds a snapshot must respect: the smaller of the compile-time
/// ceilings and the limits the control plane advertised in `welcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotLimits {
    chunk_bytes: usize,
    max_bytes: usize,
}

impl SnapshotLimits {
    pub fn negotiated(advertised: &Limits) -> Self {
        let chunk_bytes = usize::try_from(advertised.snapshot_chunk_bytes)
            .unwrap_or(usize::MAX)
            .clamp(1, SNAPSHOT_CHUNK_BYTES);
        let max_bytes = usize::try_from(advertised.max_snapshot_bytes)
            .unwrap_or(usize::MAX)
            .clamp(1, MAX_SNAPSHOT_BYTES);
        Self {
            chunk_bytes,
            max_bytes,
        }
    }
}

/// A transfer failure. The variants name what the contract's `config.ack`
/// reports at the `receive` stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    /// A chunk or end names a request that is not the one in flight.
    UnknownRequest,
    /// The announced size exceeds the negotiated limit.
    TooLarge { total_bytes: u64, limit: usize },
    /// `chunkCount` does not match `totalBytes` at the negotiated chunk size.
    ChunkCountMismatch { expected: u64, announced: u64 },
    /// A chunk arrived out of order or beyond the announced count.
    OutOfOrder { expected: u64, received: u64 },
    /// A chunk's decoded length is not the length its position requires.
    ChunkSize {
        index: u64,
        expected: usize,
        received: usize,
    },
    /// A chunk is not valid standard base64.
    InvalidBase64,
    /// `end` arrived before every announced chunk.
    Incomplete { received: u64, expected: u64 },
    /// The complete body does not hash to the announced digest.
    DigestMismatch,
}

impl SnapshotError {
    pub fn describe(&self) -> String {
        match self {
            Self::UnknownRequest => "snapshot chunk for an unknown request".to_string(),
            Self::TooLarge { total_bytes, limit } => {
                format!("snapshot of {total_bytes} bytes exceeds the {limit} byte limit")
            }
            Self::ChunkCountMismatch {
                expected,
                announced,
            } => {
                format!("snapshot announced {announced} chunks, expected {expected}")
            }
            Self::OutOfOrder { expected, received } => {
                format!("snapshot chunk {received} arrived, expected {expected}")
            }
            Self::ChunkSize {
                index,
                expected,
                received,
            } => format!("snapshot chunk {index} is {received} bytes, expected {expected}"),
            Self::InvalidBase64 => "snapshot chunk is not valid base64".to_string(),
            Self::Incomplete { received, expected } => {
                format!("snapshot ended after {received} of {expected} chunks")
            }
            Self::DigestMismatch => "snapshot digest does not match its body".to_string(),
        }
    }
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.describe())
    }
}

impl std::error::Error for SnapshotError {}

/// A complete body whose digest matched. Only this reaches the apply path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSnapshot {
    pub request_id: String,
    pub desired: ConfigIdentifier,
    pub body: Vec<u8>,
}

#[derive(Debug)]
struct Pending {
    request_id: String,
    desired: ConfigIdentifier,
    total_bytes: usize,
    chunk_count: u64,
    digest: String,
    next_index: u64,
    body: Vec<u8>,
}

/// Holds the snapshot currently being received.
#[derive(Debug)]
pub struct SnapshotAssembler {
    limits: SnapshotLimits,
    pending: Option<Pending>,
}

impl SnapshotAssembler {
    pub fn new(limits: SnapshotLimits) -> Self {
        Self {
            limits,
            pending: None,
        }
    }

    /// Starts a snapshot. A newer `begin` supersedes a partial one, because the
    /// control plane only sends the snapshot for the latest request.
    pub fn begin(&mut self, begin: &SnapshotBegin) -> Result<(), SnapshotError> {
        self.pending = None;
        let total_bytes = usize::try_from(begin.total_bytes).unwrap_or(usize::MAX);
        if total_bytes > self.limits.max_bytes {
            return Err(SnapshotError::TooLarge {
                total_bytes: begin.total_bytes,
                limit: self.limits.max_bytes,
            });
        }
        let expected = total_bytes.div_ceil(self.limits.chunk_bytes) as u64;
        if begin.chunk_count != expected {
            return Err(SnapshotError::ChunkCountMismatch {
                expected,
                announced: begin.chunk_count,
            });
        }
        self.pending = Some(Pending {
            request_id: begin.request_id.clone(),
            desired: begin.desired.clone(),
            total_bytes,
            chunk_count: begin.chunk_count,
            digest: begin.digest.clone(),
            next_index: 0,
            body: Vec::with_capacity(total_bytes),
        });
        Ok(())
    }

    /// Appends one in-order chunk. A failure for the snapshot in flight
    /// discards it; a chunk for another request leaves it untouched.
    pub fn chunk(&mut self, chunk: &SnapshotChunk) -> Result<(), SnapshotError> {
        let Some(pending) = self
            .pending
            .as_mut()
            .filter(|pending| pending.request_id == chunk.request_id)
        else {
            return Err(SnapshotError::UnknownRequest);
        };
        let result = Self::append(pending, self.limits.chunk_bytes, chunk);
        if result.is_err() {
            self.pending = None;
        }
        result
    }

    fn append(
        pending: &mut Pending,
        chunk_bytes: usize,
        chunk: &SnapshotChunk,
    ) -> Result<(), SnapshotError> {
        if chunk.index != pending.next_index || chunk.index >= pending.chunk_count {
            return Err(SnapshotError::OutOfOrder {
                expected: pending.next_index,
                received: chunk.index,
            });
        }
        let raw = STANDARD
            .decode(chunk.data.as_bytes())
            .map_err(|_| SnapshotError::InvalidBase64)?;
        let expected = expected_chunk_len(pending.total_bytes, chunk_bytes, chunk.index);
        if raw.len() != expected {
            return Err(SnapshotError::ChunkSize {
                index: chunk.index,
                expected,
                received: raw.len(),
            });
        }
        pending.body.extend_from_slice(&raw);
        pending.next_index += 1;
        Ok(())
    }

    /// Completes the snapshot in flight and verifies its digest.
    pub fn end(&mut self, end: &SnapshotEnd) -> Result<VerifiedSnapshot, SnapshotError> {
        let pending = match self.pending.take() {
            Some(pending) if pending.request_id == end.request_id => pending,
            other => {
                // A stray end must not discard the snapshot in flight.
                self.pending = other;
                return Err(SnapshotError::UnknownRequest);
            }
        };
        if pending.next_index != pending.chunk_count {
            return Err(SnapshotError::Incomplete {
                received: pending.next_index,
                expected: pending.chunk_count,
            });
        }
        if pending.body.len() != pending.total_bytes {
            return Err(SnapshotError::ChunkSize {
                index: pending.chunk_count.saturating_sub(1),
                expected: pending.total_bytes,
                received: pending.body.len(),
            });
        }
        let digest = hex::encode(Sha256::digest(&pending.body));
        if digest != pending.digest {
            return Err(SnapshotError::DigestMismatch);
        }
        Ok(VerifiedSnapshot {
            request_id: pending.request_id,
            desired: pending.desired,
            body: pending.body,
        })
    }

    /// Drops the partial snapshot: on disconnect, on a refusal from the control
    /// plane, or when the assembly deadline passes.
    pub fn discard(&mut self) {
        self.pending = None;
    }

    /// The request whose snapshot is being received, if any.
    #[cfg(test)]
    pub fn in_flight(&self) -> Option<&str> {
        self.pending
            .as_ref()
            .map(|pending| pending.request_id.as_str())
    }
}

fn expected_chunk_len(total_bytes: usize, chunk_bytes: usize, index: u64) -> usize {
    let start = usize::try_from(index)
        .unwrap_or(usize::MAX)
        .saturating_mul(chunk_bytes);
    total_bytes.saturating_sub(start).min(chunk_bytes)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use sha2::{Digest as _, Sha256};

    use super::{SnapshotAssembler, SnapshotError, SnapshotLimits};
    use crate::ws::v2::codec::{
        ConfigIdentifier, Limits, SnapshotBegin, SnapshotChunk, SnapshotEnd,
    };

    const REVISION: &str =
        "7:sha256:48a9e1aa59f365863b57348ccd1701026c39652cfb74b8e2b039811611802ec6";

    fn limits(chunk_bytes: u64, max_bytes: u64) -> SnapshotLimits {
        SnapshotLimits::negotiated(&Limits {
            max_frame_bytes: 4 * 1024 * 1024,
            snapshot_chunk_bytes: chunk_bytes,
            max_snapshot_bytes: max_bytes,
        })
    }

    fn begin_for(request_id: &str, body: &[u8], chunk_bytes: usize) -> SnapshotBegin {
        SnapshotBegin {
            request_id: request_id.to_string(),
            desired: ConfigIdentifier::from_revision(REVISION).unwrap(),
            content_type: "application/json".to_string(),
            total_bytes: body.len() as u64,
            chunk_count: body.len().div_ceil(chunk_bytes) as u64,
            digest: hex::encode(Sha256::digest(body)),
        }
    }

    fn chunks_of(request_id: &str, body: &[u8], chunk_bytes: usize) -> Vec<SnapshotChunk> {
        body.chunks(chunk_bytes)
            .enumerate()
            .map(|(index, raw)| SnapshotChunk {
                request_id: request_id.to_string(),
                index: index as u64,
                data: STANDARD.encode(raw),
            })
            .collect()
    }

    fn end(request_id: &str) -> SnapshotEnd {
        SnapshotEnd {
            request_id: request_id.to_string(),
        }
    }

    #[test]
    fn assembles_a_multi_chunk_body_and_verifies_its_digest() {
        let body: Vec<u8> = (0..23).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-1", &body, 8)).unwrap();
        for chunk in chunks_of("snap-1", &body, 8) {
            assembler.chunk(&chunk).unwrap();
        }
        let verified = assembler.end(&end("snap-1")).unwrap();
        assert_eq!(verified.body, body);
        assert_eq!(verified.desired.desired_revision_seq, 7);
        assert!(assembler.in_flight().is_none());
    }

    #[test]
    fn a_digest_mismatch_discards_the_snapshot() {
        let body = b"{\"apiVersion\":3}".to_vec();
        let mut begin = begin_for("snap-2", &body, 8);
        begin.digest = "0".repeat(64);
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin).unwrap();
        for chunk in chunks_of("snap-2", &body, 8) {
            assembler.chunk(&chunk).unwrap();
        }
        assert_eq!(
            assembler.end(&end("snap-2")).unwrap_err(),
            SnapshotError::DigestMismatch
        );
        assert!(assembler.in_flight().is_none());
    }

    #[test]
    fn a_snapshot_above_the_advertised_limit_is_refused_before_any_chunk() {
        let body = vec![0u8; 100];
        let mut assembler = SnapshotAssembler::new(limits(8, 64));
        assert_eq!(
            assembler.begin(&begin_for("snap-3", &body, 8)).unwrap_err(),
            SnapshotError::TooLarge {
                total_bytes: 100,
                limit: 64
            }
        );
    }

    #[test]
    fn an_out_of_order_chunk_discards_the_partial_snapshot() {
        let body: Vec<u8> = (0..16).collect();
        let chunks = chunks_of("snap-4", &body, 8);
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-4", &body, 8)).unwrap();
        assert_eq!(
            assembler.chunk(&chunks[1]).unwrap_err(),
            SnapshotError::OutOfOrder {
                expected: 0,
                received: 1
            }
        );
        assert!(assembler.in_flight().is_none());
    }

    #[test]
    fn a_chunk_for_another_request_leaves_the_snapshot_in_flight() {
        let body: Vec<u8> = (0..16).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-5", &body, 8)).unwrap();
        let stray = chunks_of("other", &body, 8).remove(0);
        assert_eq!(
            assembler.chunk(&stray).unwrap_err(),
            SnapshotError::UnknownRequest
        );
        assert_eq!(assembler.in_flight(), Some("snap-5"));
        for chunk in chunks_of("snap-5", &body, 8) {
            assembler.chunk(&chunk).unwrap();
        }
        assert_eq!(assembler.end(&end("snap-5")).unwrap().body, body);
    }

    #[test]
    fn a_chunk_of_the_wrong_length_is_a_local_failure() {
        let body: Vec<u8> = (0..16).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-6", &body, 8)).unwrap();
        let short = SnapshotChunk {
            request_id: "snap-6".into(),
            index: 0,
            data: STANDARD.encode([1u8, 2, 3]),
        };
        assert_eq!(
            assembler.chunk(&short).unwrap_err(),
            SnapshotError::ChunkSize {
                index: 0,
                expected: 8,
                received: 3
            }
        );
    }

    #[test]
    fn invalid_base64_is_a_local_failure() {
        let body: Vec<u8> = (0..8).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-7", &body, 8)).unwrap();
        let bad = SnapshotChunk {
            request_id: "snap-7".into(),
            index: 0,
            data: "!!!!".into(),
        };
        assert_eq!(
            assembler.chunk(&bad).unwrap_err(),
            SnapshotError::InvalidBase64
        );
    }

    #[test]
    fn end_before_every_chunk_is_incomplete() {
        let body: Vec<u8> = (0..16).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-8", &body, 8)).unwrap();
        assembler.chunk(&chunks_of("snap-8", &body, 8)[0]).unwrap();
        assert_eq!(
            assembler.end(&end("snap-8")).unwrap_err(),
            SnapshotError::Incomplete {
                received: 1,
                expected: 2
            }
        );
    }

    #[test]
    fn a_newer_begin_supersedes_a_partial_snapshot() {
        let old: Vec<u8> = (0..16).collect();
        let new: Vec<u8> = (100..108).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("old", &old, 8)).unwrap();
        assembler.chunk(&chunks_of("old", &old, 8)[0]).unwrap();
        assembler.begin(&begin_for("new", &new, 8)).unwrap();
        assert_eq!(
            assembler.end(&end("old")).unwrap_err(),
            SnapshotError::UnknownRequest
        );
        for chunk in chunks_of("new", &new, 8) {
            assembler.chunk(&chunk).unwrap();
        }
        assert_eq!(assembler.end(&end("new")).unwrap().body, new);
    }

    #[test]
    fn discard_on_disconnect_drops_the_partial_body() {
        let body: Vec<u8> = (0..16).collect();
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assembler.begin(&begin_for("snap-9", &body, 8)).unwrap();
        assembler.chunk(&chunks_of("snap-9", &body, 8)[0]).unwrap();
        assembler.discard();
        assert_eq!(
            assembler
                .chunk(&chunks_of("snap-9", &body, 8)[1])
                .unwrap_err(),
            SnapshotError::UnknownRequest
        );
    }

    #[test]
    fn the_chunk_count_must_match_the_negotiated_chunk_size() {
        let body: Vec<u8> = (0..16).collect();
        let mut begin = begin_for("snap-10", &body, 8);
        begin.chunk_count = 4;
        let mut assembler = SnapshotAssembler::new(limits(8, 1024));
        assert_eq!(
            assembler.begin(&begin).unwrap_err(),
            SnapshotError::ChunkCountMismatch {
                expected: 2,
                announced: 4
            }
        );
    }
}
