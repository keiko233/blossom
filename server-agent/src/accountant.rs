use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::stats::{ConnectionEvent, ConnectionEvents};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionEventType {
    New,
    Update,
    Closed,
}

impl ConnectionEventType {
    pub fn from_i32(value: i32) -> Self {
        match value {
            1 => Self::Update,
            2 => Self::Closed,
            _ => Self::New,
        }
    }
}

/// Per-connection accounting for the connection-event stream.
///
/// Semantics:
///
/// - UPDATE deltas are added to the user's reportable total as they arrive.
/// - NEW events normally snapshot a connection that has just been accepted;
///   its current totals are recorded as already accounted (the stream has
///   seen everything before them).
/// - CLOSED events carry no final delta, so the remaining
///   `total - accounted` is added and the connection is dropped.
/// - A `reset=true` message is a snapshot of sing-box's connection state
///   (the first message of every stream, and after every reconnect). Every
///   snapshot is reconciled by connection id: a known id contributes the
///   unaccounted remainder (`total - accounted`), an unknown id contributes
///   its full totals because they were produced while the agent was not
///   subscribed, and an id absent from the snapshot is dropped (it closed
///   while the stream was down; its final bytes are part of the documented
///   crash-loss window).
///
///   Decision: a fresh sing-box process needs no special branch. Its
///   snapshot ids are all unknown (their totals count in full as unaccounted
///   bytes — the new process's traffic has never been accounted) and the
///   previous process's ids are absent from the snapshot and therefore
///   dropped, which is equivalent to clearing the map. Connection ids are
///   UUIDs and are never reused across processes, and this agent always
///   starts its own sing-box process (at startup and on every config
///   apply), so a snapshot can only ever contain ids of the process this
///   agent launched. That rules out the one dangerous case — an agent
///   restart while an old sing-box keeps running — which would otherwise
///   double count pre-restart traffic.
///
/// A map entry is intentionally keyed by connection id and never merged
/// across ids: sing-box never reuses an id, and traffic that arrived under a
/// different id must not be double counted via stale entries.
#[derive(Default)]
pub struct ConnectionAccountant {
    tracked: HashMap<String, Accounted>,
    /// Ids whose final totals have already been paid, newest last. sing-box
    /// replays its last 1000 closed connections in every snapshot; without
    /// this memory a reconnect would pay them a second time.
    finalised: std::collections::VecDeque<String>,
    finalised_set: std::collections::HashSet<String>,
}

/// Larger than sing-box's own closed-connection history (1000) so a replayed
/// id is always still remembered.
const FINALISED_LIMIT: usize = 4096;

/// Durable form of the accountant, committed in the runtime checkpoint.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountantState {
    pub tracked: Vec<TrackedConnection>,
    /// Oldest first.
    pub finalised: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedConnection {
    pub id: String,
    pub user: String,
    pub uplink: u64,
    pub downlink: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Accounted {
    user: String,
    uplink: u64,
    downlink: u64,
}

impl ConnectionAccountant {
    pub fn new() -> Self {
        Self::default()
    }

    /// Processes one `ConnectionEvents` message, returning the per-user
    /// deltas it yields. Unknown/empty users, negative totals and negative
    /// deltas are ignored. Zero-value results produce no entry.
    pub fn apply(&mut self, message: &ConnectionEvents) -> HashMap<String, (u64, u64)> {
        let mut out: HashMap<String, (u64, u64)> = HashMap::new();
        if message.reset {
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for event in &message.events {
                let Some((user, totals)) = Self::snapshot_totals(event) else {
                    continue;
                };
                let closed = event
                    .connection
                    .as_ref()
                    .is_some_and(|connection| connection.closed_at != 0);
                if closed {
                    // Replayed history entry. Pay only what was never paid
                    // and remember the id so the next snapshot skips it.
                    if self.finalised_set.contains(&event.id) {
                        self.tracked.remove(&event.id);
                        continue;
                    }
                    let (uplink_delta, downlink_delta) = match self.tracked.remove(&event.id) {
                        Some(accounted) => (
                            totals.0.saturating_sub(accounted.uplink),
                            totals.1.saturating_sub(accounted.downlink),
                        ),
                        None => totals,
                    };
                    if uplink_delta > 0 || downlink_delta > 0 {
                        let (uplink, downlink) = out.entry(user).or_insert((0, 0));
                        *uplink = uplink.saturating_add(uplink_delta);
                        *downlink = downlink.saturating_add(downlink_delta);
                    }
                    self.mark_finalised(&event.id);
                    continue;
                }
                seen.insert(event.id.as_str());
                let known = self.tracked.remove(&event.id);
                let (uplink_delta, downlink_delta) = match known {
                    Some(accounted) => (
                        totals.0.saturating_sub(accounted.uplink),
                        totals.1.saturating_sub(accounted.downlink),
                    ),
                    None => totals,
                };
                if uplink_delta > 0 || downlink_delta > 0 {
                    let (uplink, downlink) = out.entry(user.clone()).or_insert((0, 0));
                    *uplink = uplink.saturating_add(uplink_delta);
                    *downlink = downlink.saturating_add(downlink_delta);
                }
                self.tracked.insert(
                    event.id.clone(),
                    Accounted {
                        user,
                        uplink: totals.0,
                        downlink: totals.1,
                    },
                );
            }
            // Ids absent from the snapshot closed while we were not
            // subscribed. Drop them; keeping them would let a later CLOSED
            // or stale UPDATE pay traffic twice.
            self.tracked.retain(|id, _| seen.contains(id.as_str()));
            return out;
        }
        for event in &message.events {
            match ConnectionEventType::from_i32(event.r#type) {
                ConnectionEventType::Update => {
                    let Some(tracked) = self.tracked.get_mut(&event.id) else {
                        continue;
                    };
                    let uplink = event.uplink_delta.max(0) as u64;
                    let downlink = event.downlink_delta.max(0) as u64;
                    if uplink == 0 && downlink == 0 {
                        continue;
                    }
                    let (up, down) = out.entry(tracked.user.clone()).or_insert((0, 0));
                    *up = up.saturating_add(uplink);
                    *down = down.saturating_add(downlink);
                    tracked.uplink = tracked.uplink.saturating_add(uplink);
                    tracked.downlink = tracked.downlink.saturating_add(downlink);
                }
                ConnectionEventType::Closed => {
                    let Some(tracked) = self.tracked.remove(&event.id) else {
                        continue;
                    };
                    self.mark_finalised(&event.id);
                    let Some(final_totals) = Self::connection_totals(event) else {
                        continue;
                    };
                    let remaining_uplink = final_totals.0.saturating_sub(tracked.uplink);
                    let remaining_downlink = final_totals.1.saturating_sub(tracked.downlink);
                    if remaining_uplink == 0 && remaining_downlink == 0 {
                        continue;
                    }
                    let (up, down) = out.entry(tracked.user.clone()).or_insert((0, 0));
                    *up = up.saturating_add(remaining_uplink);
                    *down = down.saturating_add(remaining_downlink);
                }
                ConnectionEventType::New => {
                    // Record as already accounted; the stream saw the
                    // connection from birth. Snapshot messages are handled
                    // above with the recovery rule instead.
                    if let Some((user, totals)) = Self::snapshot_totals(event) {
                        self.tracked.insert(
                            event.id.clone(),
                            Accounted {
                                user,
                                uplink: totals.0,
                                downlink: totals.1,
                            },
                        );
                    }
                }
            }
        }
        out
    }

    /// Rebuilds an accountant from a committed checkpoint. Duplicate and
    /// excess finalised ids are dropped, keeping the newest.
    pub fn from_state(state: AccountantState) -> Self {
        let mut accountant = Self::new();
        for connection in state.tracked {
            accountant.tracked.insert(
                connection.id,
                Accounted {
                    user: connection.user,
                    uplink: connection.uplink,
                    downlink: connection.downlink,
                },
            );
        }
        for id in &state.finalised {
            accountant.mark_finalised(id);
        }
        accountant
    }

    /// The accounted totals and finalised ids, in a deterministic order, for
    /// a checkpoint committed together with the deltas they produced.
    pub fn state(&self) -> AccountantState {
        let mut tracked: Vec<TrackedConnection> = self
            .tracked
            .iter()
            .map(|(id, accounted)| TrackedConnection {
                id: id.clone(),
                user: accounted.user.clone(),
                uplink: accounted.uplink,
                downlink: accounted.downlink,
            })
            .collect();
        tracked.sort_by(|a, b| a.id.cmp(&b.id));
        AccountantState {
            tracked,
            finalised: self.finalised.iter().cloned().collect(),
        }
    }

    /// Adopts a snapshot without paying for it: live totals become accounted
    /// and replayed closed ids become finalised. Used when the runtime may
    /// have served before and no trustworthy checkpoint says what was paid,
    /// so anything before this snapshot is an unobservable window rather than
    /// a historical recharge. Ids absent from the snapshot are dropped.
    pub fn baseline(&mut self, snapshot: &ConnectionEvents) {
        self.tracked.clear();
        for event in &snapshot.events {
            let Some((user, (uplink, downlink))) = Self::snapshot_totals(event) else {
                continue;
            };
            let closed = event
                .connection
                .as_ref()
                .is_some_and(|connection| connection.closed_at != 0);
            if closed {
                self.mark_finalised(&event.id);
                continue;
            }
            self.tracked.insert(
                event.id.clone(),
                Accounted {
                    user,
                    uplink,
                    downlink,
                },
            );
        }
    }

    fn mark_finalised(&mut self, id: &str) {
        if !self.finalised_set.insert(id.to_owned()) {
            return;
        }
        self.finalised.push_back(id.to_owned());
        while self.finalised.len() > FINALISED_LIMIT {
            if let Some(old) = self.finalised.pop_front() {
                self.finalised_set.remove(&old);
            }
        }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.tracked.is_empty()
    }

    fn snapshot_totals(event: &ConnectionEvent) -> Option<(String, (u64, u64))> {
        let connection = event.connection.as_ref()?;
        let user = connection.user.clone();
        if user.is_empty() {
            return None;
        }
        let uplink = connection.uplink_total.max(0) as u64;
        let downlink = connection.downlink_total.max(0) as u64;
        Some((user, (uplink, downlink)))
    }

    fn connection_totals(event: &ConnectionEvent) -> Option<(u64, u64)> {
        let connection = event.connection.as_ref()?;
        let uplink = connection.uplink_total.max(0) as u64;
        let downlink = connection.downlink_total.max(0) as u64;
        Some((uplink, downlink))
    }
}

#[cfg(test)]
mod tests {
    use super::{ConnectionAccountant, ConnectionEventType};
    use crate::stats::{Connection, ConnectionEvent, ConnectionEvents};

    fn connection(user: &str, uplink_total: i64, downlink_total: i64) -> Connection {
        Connection {
            user: user.to_string(),
            closed_at: 0,
            uplink_total,
            downlink_total,
        }
    }

    fn new_event_with_totals(
        id: &str,
        user: &str,
        uplink_total: i64,
        downlink_total: i64,
    ) -> ConnectionEvent {
        ConnectionEvent {
            r#type: ConnectionEventType::New as i32,
            id: id.to_string(),
            connection: Some(connection(user, uplink_total, downlink_total)),
            uplink_delta: 0,
            downlink_delta: 0,
            closed_at: 0,
        }
    }

    fn update_event(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
        ConnectionEvent {
            r#type: ConnectionEventType::Update as i32,
            id: id.to_string(),
            connection: Some(connection(user, 0, 0)),
            uplink_delta: uplink,
            downlink_delta: downlink,
            closed_at: 0,
        }
    }

    fn closed_event(id: &str, user: &str, uplink: i64, downlink: i64) -> ConnectionEvent {
        ConnectionEvent {
            r#type: ConnectionEventType::Closed as i32,
            id: id.to_string(),
            connection: Some(connection(user, uplink, downlink)),
            uplink_delta: 0,
            downlink_delta: 0,
            closed_at: 1,
        }
    }

    fn snapshot(events: Vec<ConnectionEvent>) -> ConnectionEvents {
        ConnectionEvents {
            events,
            reset: true,
        }
    }

    fn updates(events: Vec<ConnectionEvent>) -> ConnectionEvents {
        ConnectionEvents {
            events,
            reset: false,
        }
    }

    #[test]
    fn snapshot_of_a_fresh_instance_counts_unknown_ids_in_full() {
        let mut accountant = ConnectionAccountant::new();
        let deltas = accountant.apply(&snapshot(vec![
            new_event_with_totals("c1", "user-a", 100, 20),
            new_event_with_totals("c2", "user-b", 0, 5),
        ]));
        assert_eq!(deltas.get("user-a"), Some(&(100, 20)));
        assert_eq!(deltas.get("user-b"), Some(&(0, 5)));
    }

    #[test]
    fn update_deltas_reach_the_user() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));

        let deltas = accountant.apply(&updates(vec![update_event("c1", "user-a", 100, 50)]));

        assert_eq!(deltas.get("user-a"), Some(&(100, 50)));
    }

    #[test]
    fn closed_event_pays_the_unaccounted_remainder() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", 100, 40)]));

        // Final totals: 150 up / 100 down; 100/40 were already counted.
        let deltas = accountant.apply(&updates(vec![closed_event("c1", "user-a", 150, 100)]));

        assert_eq!(deltas.get("user-a"), Some(&(50, 60)));
        assert!(accountant.is_empty());
    }

    #[test]
    fn closed_without_metadata_is_a_no_op() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", 100, 40)]));

        let event = ConnectionEvent {
            r#type: ConnectionEventType::Closed as i32,
            id: "c1".to_string(),
            connection: None,
            uplink_delta: 0,
            downlink_delta: 0,
            closed_at: 1,
        };
        let deltas = accountant.apply(&updates(vec![event]));

        assert!(deltas.is_empty());
        assert!(accountant.is_empty());
    }

    #[test]
    fn unknown_users_are_ignored() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "", 10, 10)]));
        assert!(accountant.is_empty());
    }

    #[test]
    fn updates_for_unknown_ids_are_dropped() {
        let mut accountant = ConnectionAccountant::new();
        let deltas = accountant.apply(&updates(vec![update_event("ghost", "user-a", 99, 99)]));
        assert!(deltas.is_empty());
    }

    #[test]
    fn reconnect_to_same_instance_reconciles_known_and_unknown_ids() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", 100, 20)]));

        // c1 is still alive with totals 130/20 (30 up was not yet delivered);
        // c2 was created while the stream was down with totals 10/5.
        let deltas = accountant.apply(&snapshot(vec![
            new_event_with_totals("c1", "user-a", 130, 20),
            new_event_with_totals("c2", "user-b", 10, 5),
        ]));

        assert_eq!(deltas.get("user-a"), Some(&(30, 0)));
        assert_eq!(deltas.get("user-b"), Some(&(10, 5)));
    }

    #[test]
    fn reconnect_drops_ids_that_closed_while_disconnected() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));

        accountant.apply(&snapshot(vec![]));

        assert!(accountant.is_empty());
    }

    #[test]
    fn negative_totals_and_deltas_are_ignored() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));

        let deltas = accountant.apply(&updates(vec![update_event("c1", "user-a", -10, -20)]));
        assert!(deltas.is_empty());
    }

    #[test]
    fn saturating_addition_never_panics() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", i64::MAX, 0)]));

        let deltas = accountant.apply(&updates(vec![update_event("c1", "user-a", i64::MAX, 0)]));

        assert_eq!(deltas.get("user-a"), Some(&(i64::MAX as u64, 0)));
    }

    #[test]
    fn tracked_state_matches_snapshot_after_recovery() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", 30, 10)]));

        // A reconnect against totals 60/10 must count exactly the missing 30/0.
        let deltas = accountant.apply(&snapshot(vec![new_event_with_totals(
            "c1", "user-a", 60, 10,
        )]));
        assert_eq!(deltas.get("user-a"), Some(&(30, 0)));

        // A second snapshot with the same totals counts nothing.
        let deltas = accountant.apply(&snapshot(vec![new_event_with_totals(
            "c1", "user-a", 60, 10,
        )]));
        assert!(deltas.is_empty());
    }

    fn closed_snapshot_event(id: &str, user: &str, up: i64, down: i64) -> ConnectionEvent {
        let mut event = new_event_with_totals(id, user, up, down);
        event.connection.as_mut().unwrap().closed_at = 1;
        event
    }

    #[test]
    fn replayed_closed_history_is_not_paid_twice_after_reconnect() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", 100, 40)]));
        let paid = accountant.apply(&updates(vec![closed_event("c1", "user-a", 150, 100)]));
        assert_eq!(paid.get("user-a"), Some(&(50, 60)));

        // Reconnect: sing-box replays c1 from its closed history.
        let deltas = accountant.apply(&snapshot(vec![closed_snapshot_event(
            "c1", "user-a", 150, 100,
        )]));
        assert!(deltas.is_empty());
        assert!(accountant.is_empty());
    }

    #[test]
    fn connection_closed_during_the_gap_is_paid_once() {
        let mut accountant = ConnectionAccountant::new();
        accountant.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        accountant.apply(&updates(vec![update_event("c1", "user-a", 100, 0)]));

        // c1 closed while the stream was down; its history entry carries the
        // final totals. Only the unpaid remainder is added, and only once.
        let replay = || snapshot(vec![closed_snapshot_event("c1", "user-a", 130, 20)]);
        assert_eq!(accountant.apply(&replay()).get("user-a"), Some(&(30, 20)));
        assert!(accountant.apply(&replay()).is_empty());
        assert!(accountant.is_empty());
    }

    #[test]
    fn restored_state_reconciles_like_the_original() {
        let mut original = ConnectionAccountant::new();
        original.apply(&snapshot(vec![new_event_with_totals("c1", "user-a", 0, 0)]));
        original.apply(&updates(vec![update_event("c1", "user-a", 40, 10)]));
        original.apply(&snapshot(vec![
            new_event_with_totals("c1", "user-a", 40, 10),
            closed_snapshot_event("c0", "user-b", 7, 7),
        ]));

        let state = original.state();
        let mut restored = ConnectionAccountant::from_state(state.clone());
        assert_eq!(restored.state(), state);

        let next = || {
            snapshot(vec![
                new_event_with_totals("c1", "user-a", 55, 10),
                closed_snapshot_event("c0", "user-b", 7, 7),
            ])
        };
        assert_eq!(original.apply(&next()), restored.apply(&next()));
    }

    #[test]
    fn restored_finalised_ids_are_bounded_and_deduplicated() {
        let mut finalised: Vec<String> = (0..super::FINALISED_LIMIT + 10)
            .map(|index| format!("c{index}"))
            .collect();
        finalised.push("c20".to_owned());
        let restored = ConnectionAccountant::from_state(super::AccountantState {
            tracked: Vec::new(),
            finalised,
        });
        let state = restored.state();
        assert_eq!(state.finalised.len(), super::FINALISED_LIMIT);
        assert_eq!(state.finalised.first().map(String::as_str), Some("c10"));
    }

    #[test]
    fn baseline_pays_nothing_and_later_deltas_are_billed() {
        let mut accountant = ConnectionAccountant::new();
        accountant.baseline(&snapshot(vec![
            new_event_with_totals("live", "user-a", 500, 50),
            closed_snapshot_event("gone", "user-b", 9, 9),
        ]));

        // The same snapshot replayed after a stream reconnect pays nothing.
        let replay = accountant.apply(&snapshot(vec![
            new_event_with_totals("live", "user-a", 520, 50),
            closed_snapshot_event("gone", "user-b", 9, 9),
        ]));
        assert_eq!(replay.get("user-a"), Some(&(20, 0)));
        assert_eq!(replay.get("user-b"), None);
    }

    #[test]
    fn closed_history_of_a_fresh_instance_is_counted_in_full_once() {
        let mut accountant = ConnectionAccountant::new();
        let message = || snapshot(vec![closed_snapshot_event("old", "user-a", 10, 5)]);
        assert_eq!(accountant.apply(&message()).get("user-a"), Some(&(10, 5)));
        assert!(accountant.apply(&message()).is_empty());
    }
}
