//! Normalization and secret redaction for captured log text.
//!
//! Order matters. Escapes and control characters are removed first, so a
//! secret split by colour codes is still found. Redaction runs next, so a
//! secret is never cut in half by the length cap. The cap runs last.

use std::borrow::Cow;
use std::fmt::Write as _;
use std::sync::Mutex;

use super::model::MAX_TEXT_BYTES;

pub(crate) const REDACTED: &str = "[REDACTED]";
const REDACTED_KEY: &str = "[REDACTED PRIVATE KEY]";

/// Normalizes one captured line and returns `(text, truncated)`.
pub(crate) fn sanitize(raw: &str, redactor: &SecretRedactor) -> (String, bool) {
    let stripped = strip_controls(&strip_ansi(raw));
    let redacted = redactor.redact(&stripped);
    truncate(redacted.trim_end())
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

/// Holds the byte forms of every registered secret and replaces each one
/// wherever it appears in captured text.
#[derive(Default)]
pub(crate) struct SecretRedactor {
    /// Longest forms first, so an overlapping longer secret is replaced whole.
    forms: Mutex<Vec<String>>,
}

impl SecretRedactor {
    /// Registers a secret in each form it commonly takes in a log: raw, in a
    /// URL query (percent-encoded), and inside a JSON string. Empty secrets
    /// are ignored.
    pub(crate) fn register(&self, secret: &str) {
        if secret.is_empty() {
            return;
        }
        let mut forms = secret_forms(secret);
        let Ok(mut known) = self.forms.lock() else {
            return;
        };
        known.append(&mut forms);
        known.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        known.dedup();
    }

    /// Replaces known secrets, `Bearer` tokens and PEM private-key headers.
    /// If the registry cannot be read, everything is redacted rather than
    /// risking a leak.
    pub(crate) fn redact<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let Ok(forms) = self.forms.lock() else {
            return Cow::Borrowed(REDACTED);
        };
        if text.contains("PRIVATE KEY-----") {
            return Cow::Borrowed(REDACTED_KEY);
        }
        let mut out = Cow::Borrowed(text);
        for form in forms.iter() {
            if out.contains(form.as_str()) {
                out = Cow::Owned(out.replace(form.as_str(), REDACTED));
            }
        }
        redact_bearer(out)
    }
}

fn secret_forms(secret: &str) -> Vec<String> {
    let mut forms = vec![secret.to_owned()];
    forms.push(percent_encode(secret, false));
    forms.push(percent_encode(secret, true));
    if let Ok(json) = serde_json::to_string(secret) {
        forms.push(json.trim_matches('"').to_owned());
    }
    forms.sort();
    forms.dedup();
    forms.retain(|form| !form.is_empty());
    forms
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
        redactor.register(TOKEN);
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
        redactor.register(secret);
        let json = serde_json::json!({ "password": secret }).to_string();
        assert!(json.contains("q\\\"u\\\\ote1"));
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
        redactor.register("abcdef");
        redactor.register("abcdefghij");
        let (text, _) = sanitize("x abcdefghij y", &redactor);
        assert_eq!(text, "x [REDACTED] y");
    }

    #[test]
    fn empty_secret_is_ignored() {
        let redactor = SecretRedactor::default();
        redactor.register("");
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
