//! Normalization and secret redaction for captured log text.
//!
//! Order matters. Escapes and control characters are removed first, so a
//! secret split by colour codes is still found. Redaction runs next, so a
//! secret is never cut in half by the length cap. The cap runs last.
//!
//! PEM private-key blocks span lines whose bodies carry no marker, so
//! [`PrivateKeyBlock`] follows them per ordered source. Each source keeps its
//! own state, so a block is dropped whole whatever the chunk boundaries.

use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};
use std::fmt::{self, Write as _};
use std::sync::Mutex;

use super::model::MAX_TEXT_BYTES;

pub(crate) const REDACTED: &str = "[REDACTED]";
const REDACTED_KEY: &str = "[REDACTED PRIVATE KEY]";
/// Bound on secret forms held at once, current and retired together. A
/// subscription contributes a handful of forms, and each apply registers every
/// credential in the active config plus the candidate, so this covers thousands
/// of subscriptions without the matcher outgrowing the retained log buffer. A
/// registration that would exceed it changes nothing.
pub(crate) const MAX_SECRET_FORMS: usize = 65_536;

/// Owner of one set of registered secrets. A scope is always replaced as a
/// whole, never appended to.
///
/// Adding a credential class means adding a variant here and calling
/// `LogStore::replace_secrets` with it before the value is first sent, logged
/// or written to a config, and again on every rotation or refresh. Never log
/// such a value by name or by content.
///
/// The OAuth scope is replaced as a whole on every refresh, so a previous
/// access token retires into the redacted history instead of being forgotten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum SecretScope {
    /// The per-server agent token and the optional GitHub token, fixed per process.
    Agent,
    /// The machine client secret and the current access token. Replaced on
    /// every token refresh and on credential rotation.
    OAuth,
    /// The loopback stats API secret of the endpoint the current config uses.
    StatsApi,
    /// Node credentials from the active config and the candidate being applied.
    NodeCredentials,
}

/// A registration would hold more secret forms than [`MAX_SECRET_FORMS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SecretRegistryFull;

impl fmt::Display for SecretRegistryFull {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("too many credentials to register for log redaction")
    }
}

impl std::error::Error for SecretRegistryFull {}

/// Forms of every registered secret, grouped by scope.
#[derive(Default)]
struct Registry {
    /// Sorted, deduplicated forms of each scope's current secrets.
    current: BTreeMap<SecretScope, Vec<String>>,
    /// Forms of replaced sets, oldest first. They stay redacted, so output from
    /// a process that is still shutting down remains masked until the bound
    /// pushes them out.
    retired: VecDeque<Vec<String>>,
    /// Total forms in `current` and `retired`, maintained incrementally so the
    /// bound check does not rescan every retired set on each rotation.
    total_forms: usize,
    /// `current`/`retired` changed since the automaton was built. Building is
    /// deferred to the next redaction, so a burst of registrations before any
    /// log line is captured (the common config-apply path) builds one automaton
    /// instead of one per set.
    dirty: bool,
    /// One automaton over every form in `current` and `retired`.
    automaton: Option<SecretMatcher>,
    /// The scope whose registration did not fit [`MAX_SECRET_FORMS`]. Capture
    /// fails closed until that scope is successfully replaced with a smaller
    /// set, because until then the oversized set may still be running.
    overflowed_scope: Option<SecretScope>,
}

impl Registry {
    fn refresh(&mut self) {
        if !self.dirty {
            return;
        }
        let mut all: Vec<String> = self
            .current
            .values()
            .chain(self.retired.iter())
            .flatten()
            .cloned()
            .collect();
        all.sort_unstable();
        all.dedup();
        // The matcher is built lazily so a config apply that registers several
        // scopes builds one automaton on next capture, not one per set.
        self.automaton = Some(SecretMatcher::new(&all));
        self.dirty = false;
    }
}

/// Holds the forms of every registered secret and replaces each one wherever
/// it appears in captured text.
#[derive(Default)]
pub(crate) struct SecretRedactor {
    registry: Mutex<Registry>,
}

impl SecretRedactor {
    /// Makes `secrets` the complete set for `scope`. The set it replaces is
    /// retired rather than forgotten. When the new set would push the registry
    /// past [`MAX_SECRET_FORMS`], retired sets are dropped oldest first; if the
    /// current sets alone do not fit, nothing changes, the call fails, and
    /// capture fails closed until that scope is replaced with a smaller set.
    pub(crate) fn replace<I>(
        &self,
        scope: SecretScope,
        secrets: I,
    ) -> Result<(), SecretRegistryFull>
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
    {
        let mut forms: Vec<String> = secrets
            .into_iter()
            .flat_map(|secret| secret_forms(secret.as_ref()))
            .collect();
        forms.sort();
        forms.dedup();

        let new_len = forms.len();
        let mut registry = self.registry.lock().map_err(|_| SecretRegistryFull)?;
        let old_len = registry.current.get(&scope).map_or(0, Vec::len);
        if registry.current.get(&scope) == Some(&forms) {
            if registry.overflowed_scope == Some(scope) {
                registry.overflowed_scope = None;
            }
            return Ok(());
        }
        let others: usize = registry
            .current
            .iter()
            .filter(|(owner, _)| **owner != scope)
            .map(|(_, set)| set.len())
            .sum();
        if others + new_len > MAX_SECRET_FORMS {
            registry.overflowed_scope = Some(scope);
            return Err(SecretRegistryFull);
        }
        registry.total_forms = registry.total_forms - old_len + new_len;
        if let Some(retired) = registry
            .current
            .insert(scope, forms)
            .filter(|set| !set.is_empty())
        {
            registry.total_forms += retired.len();
            registry.retired.push_back(retired);
        }
        while registry.total_forms > MAX_SECRET_FORMS {
            let Some(pruned) = registry.retired.pop_front() else {
                break;
            };
            registry.total_forms -= pruned.len();
        }
        registry.dirty = true;
        if registry.overflowed_scope == Some(scope) {
            registry.overflowed_scope = None;
        }
        Ok(())
    }

    /// Replaces known secrets and `Bearer` tokens. While a scope's registration
    /// is still over the bound, or the registry cannot be read, everything is
    /// redacted rather than risking a leak.
    pub(crate) fn redact<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let Ok(mut registry) = self.registry.lock() else {
            return Cow::Borrowed(REDACTED);
        };
        if registry.overflowed_scope.is_some() {
            return Cow::Borrowed(REDACTED);
        }
        registry.refresh();
        match registry.automaton.as_ref() {
            Some(matcher) => redact_bearer(replace_spans(text, matcher)),
            // A registry with no registered forms has no matcher yet; nothing
            // but bearer tokens can leak. Any other state fails closed.
            None if registry.total_forms == 0 => redact_bearer(Cow::Borrowed(text)),
            None => Cow::Borrowed(REDACTED),
        }
    }

    #[cfg(test)]
    fn form_count(&self) -> usize {
        self.registry
            .lock()
            .map_or(0, |registry| registry.total_forms)
    }

    #[cfg(test)]
    fn overflowed(&self) -> bool {
        self.registry
            .lock()
            .is_ok_and(|registry| registry.overflowed_scope.is_some())
    }
}

/// The forms a secret takes in captured text: raw, normalized the way captured
/// lines are, form-encoded (`+` for a space), percent-encoded in either hex
/// case, and escaped as a JSON string body.
fn secret_forms(secret: &str) -> Vec<String> {
    let normalized = strip_controls(secret);
    let mut forms = Vec::new();
    for base in [secret, normalized.as_str()] {
        let lower = percent_encode(base, false);
        forms.push(base.to_owned());
        forms.push(lower.replace("%20", "+"));
        forms.push(percent_encode(base, true));
        forms.push(lower);
        if let Ok(json) = serde_json::to_string(base)
            && let Some(body) = json.get(1..json.len() - 1)
        {
            forms.push(body.to_owned());
        }
    }
    forms.retain(|form| !form.is_empty());
    forms.sort();
    forms.dedup();
    forms
}

/// Removes ANSI escape sequences (CSI `ESC [ … final`, plus stray lone ESCs).
/// Returns the input unchanged when it holds no ESC, avoiding an allocation on
/// the common path.
pub(crate) fn strip_ansi(input: &str) -> Cow<'_, str> {
    if !input.contains('\x1b') {
        return Cow::Borrowed(input);
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
    Cow::Owned(out)
}

/// Drops control characters, which can rewrite the terminal line they land
/// on, and bidirectional overrides, which can make a line read differently
/// than it is stored. Tabs become spaces so columns still line up.
fn strip_controls(input: &str) -> String {
    input
        .chars()
        .filter_map(|c| match c {
            '\t' => Some(' '),
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => None,
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

/// Follows PEM private-key blocks through the lines of one ordered source.
///
/// A key header opens a block and its `END` line closes it. Every line between
/// them is dropped, body included, because body lines carry no marker of their
/// own. Owners create a fresh value for each source or supervised run, so a
/// block cut short by a process exit or restart never carries over.
#[derive(Debug, Default)]
pub(crate) struct PrivateKeyBlock {
    open: bool,
}

fn is_key_marker(line: &str) -> bool {
    line.contains("PRIVATE KEY-----") || line.contains("PRIVATE KEY BLOCK-----")
}

fn is_key_end(line: &str) -> bool {
    is_key_marker(line) && line.contains("-----END ")
}

/// True when `line` starts a private-key block. That is a complete key header
/// without its `END` on the same line, or a `BEGIN` fragment whose closing
/// dashes have not arrived. The fragment rule fails closed, so a header split
/// across lines still drops its body.
fn starts_block(line: &str) -> bool {
    if is_key_end(line) {
        return false;
    }
    match line.split_once("-----BEGIN") {
        Some((_, tail)) => is_key_marker(line) || !tail.contains("-----"),
        None => false,
    }
}

/// Normalizes one line from an ordered source and returns `(text, truncated)`,
/// or `None` when the line belongs to a private-key block and is dropped.
///
/// A marker line is replaced whole, and redaction runs before truncation, so a
/// secret is never cut in half. A poisoned registry redacts the whole line.
pub(crate) fn sanitize_line(
    raw: &str,
    redactor: &SecretRedactor,
    block: &mut PrivateKeyBlock,
) -> Option<(String, bool)> {
    let stripped = strip_controls(&strip_ansi(raw));
    if block.open {
        block.open = !is_key_end(&stripped);
        return None;
    }
    if is_key_marker(&stripped) || starts_block(&stripped) {
        block.open = starts_block(&stripped);
        return Some((REDACTED_KEY.to_owned(), false));
    }
    let redacted = redactor.redact(&stripped);
    Some(truncate(redacted.trim_end()))
}

/// Redacts a multi-line message that leaves the process as text rather than as
/// a log record, such as a sing-box check error. Each line goes through
/// [`sanitize_line`] in order with one block state, so a private-key body is
/// dropped as it would be in the buffer. Each line is capped as it is in the
/// buffer; the message as a whole is not, so a caller that caps does so after
/// redaction.
pub(crate) fn redact_message(text: &str, redactor: &SecretRedactor) -> String {
    let mut block = PrivateKeyBlock::default();
    text.split('\n')
        .filter_map(|line| sanitize_line(line, redactor, &mut block))
        .map(|(kept, _)| kept)
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate(text: &str) -> (String, bool) {
    if text.len() <= MAX_TEXT_BYTES {
        return (text.to_owned(), false);
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

/// Percent-encodes every byte outside the RFC 3986 unreserved set.
fn percent_encode(input: &str, upper: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else if upper {
            let _ = write!(out, "%{byte:02X}");
        } else {
            let _ = write!(out, "%{byte:02x}");
        }
    }
    out
}

/// Sentinel for "no terminal form" in the matcher's output links.
const NO_MATCH: u32 = u32::MAX;

/// Byte-level Aho-Corasick automaton over the registered secret forms.
///
/// It is implemented here instead of pulled in as a crate so the agent keeps
/// an empty dependency surface and `cargo test --locked` stays fully offline.
/// Edges are stored once, sorted by byte within each node, and looked up with
/// a binary search; that keeps one automaton over tens of thousands of forms
/// small enough to sit beside the retained log ring. Matches are collected
/// with the overlap-preserving scan, which is what the previous per-form
/// `match_indices` loop did.
#[derive(Debug)]
struct SecretMatcher {
    /// `(byte, child node)` sorted by byte within each node's range.
    edges: Vec<(u8, u32)>,
    /// Start index of each node's edge range in `edges`; `node_count + 1` entries.
    starts: Vec<u32>,
    /// Failure link: the longest proper suffix state.
    fail: Vec<u32>,
    /// Nearest terminal node on the failure chain, including the node itself.
    output: Vec<u32>,
    /// Form length per terminal node; zero for nodes that only prefix a form.
    pattern_len: Vec<u32>,
}

impl SecretMatcher {
    fn new(patterns: &[String]) -> Self {
        // Binary-searchable children during construction; flattened afterwards.
        let mut nodes: Vec<Vec<(u8, u32)>> = vec![Vec::new()];
        let mut pattern_len: Vec<u32> = vec![0];
        for pattern in patterns {
            if pattern.is_empty() {
                continue;
            }
            let mut node = 0u32;
            for &byte in pattern.as_bytes() {
                let found =
                    nodes[node as usize].binary_search_by_key(&byte, |&(candidate, _)| candidate);
                match found {
                    Ok(index) => node = nodes[node as usize][index].1,
                    Err(index) => {
                        let child = nodes.len() as u32;
                        nodes[node as usize].insert(index, (byte, child));
                        nodes.push(Vec::new());
                        pattern_len.push(0);
                        node = child;
                    }
                }
            }
            pattern_len[node as usize] = pattern.len() as u32;
        }

        let node_count = nodes.len();
        let mut fail = vec![0u32; node_count];
        let mut output = vec![NO_MATCH; node_count];
        let mut queue: Vec<u32> = Vec::with_capacity(node_count);
        for &(_, child) in &nodes[0] {
            queue.push(child);
            if pattern_len[child as usize] > 0 {
                output[child as usize] = child;
            }
        }

        let mut head = 0;
        while head < queue.len() {
            let node = queue[head] as usize;
            head += 1;
            for &(byte, child) in &nodes[node] {
                let mut fallback = fail[node];
                while fallback != 0
                    && nodes[fallback as usize]
                        .binary_search_by_key(&byte, |&(candidate, _)| candidate)
                        .is_err()
                {
                    fallback = fail[fallback as usize];
                }
                let target = nodes[fallback as usize]
                    .binary_search_by_key(&byte, |&(candidate, _)| candidate)
                    .ok()
                    .map_or(0, |index| nodes[fallback as usize][index].1);
                fail[child as usize] = target;
                output[child as usize] = if pattern_len[child as usize] > 0 {
                    child
                } else {
                    output[target as usize]
                };
                queue.push(child);
            }
        }

        let mut starts = Vec::with_capacity(node_count + 1);
        let mut edges = Vec::new();
        for children in nodes {
            starts.push(edges.len() as u32);
            edges.extend(children);
        }
        starts.push(edges.len() as u32);
        Self {
            edges,
            starts,
            fail,
            output,
            pattern_len,
        }
    }

    fn child(&self, node: u32, byte: u8) -> Option<u32> {
        let start = self.starts[node as usize] as usize;
        let end = self.starts[node as usize + 1] as usize;
        self.edges[start..end]
            .binary_search_by_key(&byte, |&(candidate, _)| candidate)
            .ok()
            .map(|index| self.edges[start + index].1)
    }

    /// Every match ``(start, end)`` in `text`, including overlapping ones.
    fn spans(&self, text: &str) -> Vec<(usize, usize)> {
        let mut spans = Vec::new();
        let mut node = 0u32;
        for (index, &byte) in text.as_bytes().iter().enumerate() {
            loop {
                if let Some(next) = self.child(node, byte) {
                    node = next;
                    break;
                }
                if node == 0 {
                    break;
                }
                node = self.fail[node as usize];
            }
            let mut matched = self.output[node as usize];
            while matched != NO_MATCH {
                let len = self.pattern_len[matched as usize] as usize;
                spans.push((index + 1 - len, index + 1));
                matched = self.output[self.fail[matched as usize] as usize];
            }
        }
        spans
    }
}

/// Masks every occurrence of every registered form with one automaton pass over
/// the original text. Replacements are never rescanned, and overlapping matches
/// collapse into one mask.
fn replace_spans<'a>(text: &'a str, matcher: &SecretMatcher) -> Cow<'a, str> {
    let mut spans = matcher.spans(text);
    if spans.is_empty() {
        return Cow::Borrowed(text);
    }
    spans.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut index = 0;
    while let Some(&(start, mut end)) = spans.get(index) {
        index += 1;
        while let Some(&(next_start, next_end)) = spans.get(index) {
            if next_start > end {
                break;
            }
            end = end.max(next_end);
            index += 1;
        }
        out.push_str(&text[cursor..start]);
        out.push_str(REDACTED);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    Cow::Owned(out)
}

/// Masks the token after any `Bearer ` (ASCII case-insensitive), whether or
/// not it is a registered secret.
fn redact_bearer(text: Cow<'_, str>) -> Cow<'_, str> {
    const PREFIX: &str = "bearer ";
    let lower = text.to_ascii_lowercase();
    if !lower.contains(PREFIX) {
        return text;
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find(PREFIX) {
        let start = cursor + found + PREFIX.len();
        let token_len = bytes[start..]
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(byte))
            .count();
        out.push_str(&text[cursor..start]);
        if token_len > 0 {
            out.push_str(REDACTED);
        }
        cursor = start + token_len;
    }
    out.push_str(&text[cursor..]);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "agt_9f8e7d6c5b4a3210+/=";
    const OPENSSH_KEY: [&str; 4] = [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
        "QyNTUxOQAAACDUm9ub2tleWJvZHlsaW5lZm9ybXVsdGlsaW5lcHJvb2YAAAAA",
        "-----END OPENSSH PRIVATE KEY-----",
    ];

    /// Normalizes one line as a fresh source would.
    fn sanitize(raw: &str, redactor: &SecretRedactor) -> (String, bool) {
        sanitize_line(raw, redactor, &mut PrivateKeyBlock::default())
            .expect("a fresh block keeps the line")
    }

    /// Feeds `lines` through one block state, as one ordered source would.
    fn run(lines: &[&str], redactor: &SecretRedactor) -> Vec<String> {
        let mut block = PrivateKeyBlock::default();
        lines
            .iter()
            .filter_map(|line| sanitize_line(line, redactor, &mut block))
            .map(|(text, _)| text)
            .collect()
    }

    #[test]
    fn private_key_block_is_dropped_line_by_line() {
        let mut lines = OPENSSH_KEY.to_vec();
        lines.push("after the key");
        assert_eq!(
            run(&lines, &SecretRedactor::default()),
            vec![REDACTED_KEY, "after the key"]
        );
    }

    #[test]
    fn stray_end_marker_is_masked_without_opening_a_block() {
        let lines = ["-----END PRIVATE KEY-----", "plain line"];
        assert_eq!(
            run(&lines, &SecretRedactor::default()),
            vec![REDACTED_KEY, "plain line"]
        );
    }

    #[test]
    fn block_opened_and_closed_on_one_line_leaves_nothing_open() {
        let lines = [
            "-----BEGIN PRIVATE KEY-----MIIEvQIBADAN-----END PRIVATE KEY-----",
            "plain line",
        ];
        assert_eq!(
            run(&lines, &SecretRedactor::default()),
            vec![REDACTED_KEY, "plain line"]
        );
    }

    #[test]
    fn json_escaped_block_on_one_line_is_masked_whole() {
        let pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----";
        let line = serde_json::json!({ "outbound": { "private_key": pem } }).to_string();
        assert!(line.contains("\\n"));
        assert_eq!(
            run(&[line.as_str(), "next line"], &SecretRedactor::default()),
            vec![REDACTED_KEY, "next line"]
        );
    }

    #[test]
    fn header_split_across_lines_still_drops_its_body() {
        let redactor = SecretRedactor::default();
        let split = ["-----BEGIN OPENSSH", "PRIVATE KEY-----", "b3BlbnNzaC1rZXk"];
        let lines: Vec<&str> = split
            .iter()
            .copied()
            .chain(["-----END OPENSSH PRIVATE KEY-----", "after"])
            .collect();
        assert_eq!(run(&lines, &redactor), vec![REDACTED_KEY, "after"]);

        let tail_split = [
            "-----BEGIN PRIVATE KEY",
            "-----",
            "MIIEvQIBADAN",
            "-----END PRIVATE KEY-----",
            "after",
        ];
        assert_eq!(run(&tail_split, &redactor), vec![REDACTED_KEY, "after"]);
    }

    #[test]
    fn complete_certificate_header_is_not_treated_as_a_key() {
        let lines = [
            "-----BEGIN CERTIFICATE-----",
            "MIIBszCCAVmgAwIBAgIUCert",
            "-----END CERTIFICATE-----",
        ];
        assert_eq!(run(&lines, &SecretRedactor::default()), lines.to_vec());
    }

    #[test]
    fn duplicate_header_inside_a_block_does_not_close_it() {
        let lines = [
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "MIIEvQIBADAN",
            "-----END PRIVATE KEY-----",
            "after",
        ];
        assert_eq!(
            run(&lines, &SecretRedactor::default()),
            vec![REDACTED_KEY, "after"]
        );
    }

    #[test]
    fn unterminated_block_drops_the_rest_of_its_source() {
        let lines = [
            "-----BEGIN PRIVATE KEY-----",
            "MIIEvQIBADAN",
            "still body",
            "no end marker",
        ];
        assert_eq!(run(&lines, &SecretRedactor::default()), vec![REDACTED_KEY]);
    }

    #[test]
    fn a_fresh_source_is_not_affected_by_another_sources_open_block() {
        let redactor = SecretRedactor::default();
        let mut stdout = PrivateKeyBlock::default();
        assert!(sanitize_line("-----BEGIN PRIVATE KEY-----", &redactor, &mut stdout).is_some());
        assert!(sanitize_line("MIIEvQ", &redactor, &mut stdout).is_none());
        let mut stderr = PrivateKeyBlock::default();
        assert_eq!(
            sanitize_line("ERROR still reported", &redactor, &mut stderr),
            Some(("ERROR still reported".to_owned(), false))
        );
    }

    #[test]
    fn secrets_outside_key_blocks_are_still_redacted() {
        let redactor = SecretRedactor::default();
        redactor
            .replace(SecretScope::NodeCredentials, ["node-pass-7731"])
            .unwrap();
        let lines = [
            "password=node-pass-7731",
            "-----BEGIN PRIVATE KEY-----",
            "node-pass-7731 inside body",
            "-----END PRIVATE KEY-----",
            "again node-pass-7731",
        ];
        assert_eq!(
            run(&lines, &redactor),
            vec!["password=[REDACTED]", REDACTED_KEY, "again [REDACTED]"]
        );
    }

    #[test]
    fn redact_message_drops_key_bodies_and_keeps_other_lines() {
        let redactor = SecretRedactor::default();
        redactor
            .replace(SecretScope::NodeCredentials, ["node-pass-9"])
            .unwrap();
        let message = "decode failed: password=node-pass-9\n\
                       -----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n\
                       inbounds[2] invalid";
        assert_eq!(
            redact_message(message, &redactor),
            "decode failed: password=[REDACTED]\n[REDACTED PRIVATE KEY]\ninbounds[2] invalid"
        );
    }

    fn redactor() -> SecretRedactor {
        let redactor = SecretRedactor::default();
        redactor.replace(SecretScope::Agent, [TOKEN]).unwrap();
        redactor
    }

    #[test]
    fn redacts_raw_secret_in_plain_text() {
        let (text, truncated) = sanitize(&format!("connecting with {TOKEN} now"), &redactor());
        assert_eq!(text, "connecting with [REDACTED] now");
        assert!(!truncated);
    }

    #[test]
    fn redacts_secret_in_percent_encoded_url_query() {
        let encoded = percent_encode(TOKEN, false);
        assert!(encoded.contains("%2b"));
        let (text, _) = sanitize(
            &format!("GET /api/agent/ws?token={encoded} 401"),
            &redactor(),
        );
        assert_eq!(text, "GET /api/agent/ws?token=[REDACTED] 401");
        let upper = percent_encode(TOKEN, true);
        let (text, _) = sanitize(&format!("query {upper}"), &redactor());
        assert_eq!(text, "query [REDACTED]");
    }

    #[test]
    fn redacts_secret_in_its_json_escaped_form() {
        let secret = "q\"u\\ote1";
        let redactor = SecretRedactor::default();
        redactor.replace(SecretScope::Agent, [secret]).unwrap();
        let json = serde_json::json!({ "password": secret }).to_string();
        assert!(json.contains("q\\\"u\\\\ote1"));
        let (text, _) = sanitize(&json, &redactor);
        assert_eq!(text, r#"{"password":"[REDACTED]"}"#);
    }

    #[test]
    fn secret_ending_in_a_quote_keeps_its_json_form() {
        let secret = "tok\"";
        let redactor = SecretRedactor::default();
        redactor.replace(SecretScope::Agent, [secret]).unwrap();
        let json = serde_json::json!({ "password": secret }).to_string();
        assert_eq!(json, r#"{"password":"tok\""}"#);
        let (text, _) = sanitize(&json, &redactor);
        assert_eq!(text, r#"{"password":"[REDACTED]"}"#);
    }

    #[test]
    fn redacts_secret_split_by_colour_codes() {
        let coloured = "agt_9f8e\x1b[36m7d6c5b4a3210+/=\x1b[0m";
        let (text, _) = sanitize(coloured, &redactor());
        assert_eq!(text, "[REDACTED]");
    }

    #[test]
    fn redacts_every_duplicate_occurrence_of_a_secret() {
        let line = format!("{TOKEN} then {TOKEN} and again {TOKEN}");
        let (text, _) = sanitize(&line, &redactor());
        assert_eq!(text, "[REDACTED] then [REDACTED] and again [REDACTED]");
    }

    #[test]
    fn form_encoded_space_and_tab_forms_are_masked() {
        let redactor = SecretRedactor::default();
        redactor
            .replace(SecretScope::NodeCredentials, ["pass word", "a\tb-secret"])
            .unwrap();
        let (text, _) = sanitize("?p=pass+word&q=a b-secret", &redactor);
        assert_eq!(text, "?p=[REDACTED]&q=[REDACTED]");
    }

    #[test]
    fn redacts_bearer_tokens_even_when_unregistered() {
        let (text, _) = sanitize(
            "Authorization: bearer abc.DEF-123_x~y+z/==",
            &SecretRedactor::default(),
        );
        assert_eq!(text, "Authorization: bearer [REDACTED]");
        let (text, _) = sanitize("Bearer  leftover", &SecretRedactor::default());
        assert_eq!(text, "Bearer  leftover");
    }

    #[test]
    fn redacts_pem_private_key_headers() {
        let (text, _) = sanitize("-----BEGIN EC PRIVATE KEY-----", &SecretRedactor::default());
        assert_eq!(text, REDACTED_KEY);
    }

    #[test]
    fn longer_overlapping_secret_is_replaced_whole() {
        let redactor = SecretRedactor::default();
        redactor
            .replace(SecretScope::Agent, ["abcdef", "abcdefghij"])
            .unwrap();
        let (text, _) = sanitize("x abcdefghij y", &redactor);
        assert_eq!(text, "x [REDACTED] y");
    }

    #[test]
    fn replaced_secret_stays_redacted_as_a_retired_form() {
        let redactor = SecretRedactor::default();
        redactor
            .replace(SecretScope::NodeCredentials, ["old-node-pass"])
            .unwrap();
        redactor
            .replace(SecretScope::NodeCredentials, ["new-node-pass"])
            .unwrap();
        let (text, _) = sanitize("still old-node-pass and new-node-pass", &redactor);
        assert_eq!(text, "still [REDACTED] and [REDACTED]");
    }

    #[test]
    fn rotation_keeps_the_registry_bounded() {
        let redactor = SecretRedactor::default();
        for generation in 0..6_000 {
            let secret = format!("rotating-credential-{generation:06}-value");
            redactor
                .replace(SecretScope::NodeCredentials, [secret.as_str()])
                .unwrap();
            assert!(redactor.form_count() <= MAX_SECRET_FORMS);
        }
        // Both ends of the rotation history fit under the raised bound, so they
        // stay masked until enough rotations retire them.
        let (text, _) = sanitize("rotating-credential-000000-value", &redactor);
        assert_eq!(text, REDACTED);
        let (text, _) = sanitize("rotating-credential-005999-value", &redactor);
        assert_eq!(text, REDACTED);
        // Re-registering an unchanged set adds nothing.
        let before = redactor.form_count();
        redactor
            .replace(
                SecretScope::NodeCredentials,
                ["rotating-credential-005999-value"],
            )
            .unwrap();
        assert_eq!(redactor.form_count(), before);
    }

    #[test]
    fn retired_forms_are_dropped_oldest_first_once_the_bound_is_reached() {
        let redactor = SecretRedactor::default();
        let many: Vec<String> = (0..MAX_SECRET_FORMS)
            .map(|n| format!("retired-credential-{n:05}"))
            .collect();
        redactor
            .replace(SecretScope::NodeCredentials, &many)
            .unwrap();
        assert_eq!(redactor.form_count(), MAX_SECRET_FORMS);

        redactor
            .replace(SecretScope::NodeCredentials, ["final-credential"])
            .unwrap();
        assert!(redactor.form_count() <= MAX_SECRET_FORMS);
        // The retired generation no longer fits beside the new set, so the
        // oldest forms are pushed out (here: the whole retired generation).
        let (text, _) = sanitize("retired-credential-00000", &redactor);
        assert_eq!(text, "retired-credential-00000");
        let (text, _) = sanitize("final-credential", &redactor);
        assert_eq!(text, REDACTED);
    }

    #[test]
    fn oversized_registration_keeps_the_registry_and_fails_closed() {
        let redactor = SecretRedactor::default();
        redactor.replace(SecretScope::Agent, [TOKEN]).unwrap();
        let before = redactor.form_count();
        let many: Vec<String> = (0..MAX_SECRET_FORMS)
            .map(|n| format!("bulk-credential-{n:05}"))
            .collect();
        assert_eq!(
            redactor.replace(SecretScope::NodeCredentials, &many),
            Err(SecretRegistryFull)
        );
        assert_eq!(redactor.form_count(), before);
        assert!(redactor.overflowed());
        let (text, _) = sanitize(&format!("still {TOKEN}"), &redactor);
        assert_eq!(text, REDACTED);
        assert_eq!(
            redact_message(&format!("plain\nwith {TOKEN}"), &redactor),
            format!("{REDACTED}\n{REDACTED}")
        );
    }

    #[test]
    fn empty_secret_is_ignored() {
        let redactor = SecretRedactor::default();
        redactor.replace(SecretScope::Agent, [""]).unwrap();
        let (text, _) = sanitize("plain", &redactor);
        assert_eq!(text, "plain");
    }

    #[test]
    fn strips_controls_and_bidi_overrides_and_expands_tabs() {
        let (text, _) = sanitize("a\rb\x07c\td\u{202e}ef\u{7f}", &SecretRedactor::default());
        assert_eq!(text, "abc def");
    }

    #[test]
    fn caps_length_on_a_char_boundary() {
        let line = "é".repeat(MAX_TEXT_BYTES);
        let (text, truncated) = sanitize(&line, &SecretRedactor::default());
        assert!(truncated);
        assert!(text.len() <= MAX_TEXT_BYTES);
        assert!(text.chars().all(|c| c == 'é'));
    }

    #[test]
    fn strip_ansi_leaves_plain_text_borrowed() {
        assert!(matches!(strip_ansi("no escapes here"), Cow::Borrowed(_)));
        assert_eq!(
            strip_ansi("+0800 \x1b[36mINFO\x1b[0m msg"),
            "+0800 INFO msg"
        );
    }
}
