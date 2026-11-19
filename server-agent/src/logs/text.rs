//! Normalization and secret redaction for captured log text.
//!
//! Order matters. Escapes and control characters are removed first, so a
//! secret split by colour codes is still found. Redaction runs next, so a
//! secret is never cut in half by the length cap. The cap runs last.

use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};
use std::fmt::{self, Write as _};
use std::sync::Mutex;

use super::model::MAX_TEXT_BYTES;

pub(crate) const REDACTED: &str = "[REDACTED]";
const REDACTED_KEY: &str = "[REDACTED PRIVATE KEY]";
/// Bound on secret forms held at once, current and retired together. A
/// credential contributes a handful of forms, so this covers hundreds of node
/// credentials. A registration that would exceed it changes nothing.
pub(crate) const MAX_SECRET_FORMS: usize = 4096;

/// Owner of one set of registered secrets. A scope is always replaced as a
/// whole, never appended to.
///
/// Adding a credential class, such as OAuth client secrets or access and
/// refresh tokens, means adding a variant here and calling
/// `LogStore::replace_secrets` with it before the value is first sent, logged
/// or written to a config. Never log such a value by name or by content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum SecretScope {
    /// The per-server agent token and the optional GitHub token, fixed per process.
    Agent,
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
    /// Every form in `current` and `retired`, longest first, so an overlapping
    /// longer secret is matched whole.
    all: Vec<String>,
}

impl Registry {
    fn total(&self) -> usize {
        let current: usize = self.current.values().map(Vec::len).sum();
        let retired: usize = self.retired.iter().map(Vec::len).sum();
        current + retired
    }

    fn rebuild(&mut self) {
        let mut all: Vec<String> = self
            .current
            .values()
            .chain(self.retired.iter())
            .flatten()
            .cloned()
            .collect();
        all.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        all.dedup();
        self.all = all;
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
    /// current sets alone do not fit, nothing changes and the call fails.
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

        let mut registry = self.registry.lock().map_err(|_| SecretRegistryFull)?;
        if registry.current.get(&scope) == Some(&forms) {
            return Ok(());
        }
        let others: usize = registry
            .current
            .iter()
            .filter(|(owner, _)| **owner != scope)
            .map(|(_, set)| set.len())
            .sum();
        if others + forms.len() > MAX_SECRET_FORMS {
            return Err(SecretRegistryFull);
        }
        if let Some(retired) = registry
            .current
            .insert(scope, forms)
            .filter(|set| !set.is_empty())
        {
            registry.retired.push_back(retired);
        }
        while registry.total() > MAX_SECRET_FORMS && registry.retired.pop_front().is_some() {}
        registry.rebuild();
        Ok(())
    }

    /// Replaces known secrets and `Bearer` tokens. If the registry cannot be
    /// read, everything is redacted rather than risking a leak.
    pub(crate) fn redact<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let Ok(registry) = self.registry.lock() else {
            return Cow::Borrowed(REDACTED);
        };
        if text.contains("PRIVATE KEY-----") {
            return Cow::Borrowed(REDACTED_KEY);
        }
        redact_bearer(replace_spans(text, &registry.all))
    }

    #[cfg(test)]
    fn form_count(&self) -> usize {
        self.registry.lock().map_or(0, |registry| registry.total())
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

/// Normalizes one captured line and returns `(text, truncated)`.
pub(crate) fn sanitize(raw: &str, redactor: &SecretRedactor) -> (String, bool) {
    let stripped = strip_controls(&strip_ansi(raw));
    let redacted = redactor.redact(&stripped);
    truncate(redacted.trim_end())
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

/// Masks every occurrence of every form in one pass over the original text.
/// Replacements are never rescanned, and overlapping matches collapse into one
/// mask.
fn replace_spans<'a>(text: &'a str, forms: &[String]) -> Cow<'a, str> {
    let mut spans: Vec<(usize, usize)> = forms
        .iter()
        .flat_map(|form| {
            text.match_indices(form.as_str())
                .map(|(start, found)| (start, start + found.len()))
        })
        .collect();
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
        for generation in 0..2_000 {
            let secret = format!("rotating-credential-{generation:06}-value");
            redactor
                .replace(SecretScope::NodeCredentials, [secret.as_str()])
                .unwrap();
            assert!(redactor.form_count() <= MAX_SECRET_FORMS);
        }
        // Re-registering an unchanged set adds nothing.
        let before = redactor.form_count();
        redactor
            .replace(
                SecretScope::NodeCredentials,
                ["rotating-credential-001999-value"],
            )
            .unwrap();
        assert_eq!(redactor.form_count(), before);
    }

    #[test]
    fn oversized_registration_fails_without_changing_the_registry() {
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
        let (text, _) = sanitize(&format!("still {TOKEN}"), &redactor);
        assert_eq!(text, "still [REDACTED]");
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
