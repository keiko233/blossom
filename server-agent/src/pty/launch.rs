//! Local shell selection and the controlled environment for PTY sessions.
//!
//! The shell is an explicit absolute path from local configuration. Without
//! one, the first runnable entry of [`DEFAULT_SHELLS`] is used. The shell's
//! environment is rebuilt from an allowlist, so the agent's tokens and any
//! unrelated variables never reach an interactive shell.

use std::path::{Path, PathBuf};

use super::PtyError;

/// Tried in order when no shell is configured.
pub const DEFAULT_SHELLS: [&str; 2] = ["/bin/bash", "/bin/sh"];

/// Fixed search path for the shell. The agent's own `PATH` is not inherited.
pub const SHELL_SEARCH_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Locale and time-zone variables copied from the agent when they are set.
const INHERITED_VARIABLES: [&str; 4] = ["LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const MAX_PATH_BYTES: usize = 255;

/// Where and how local shells start. Built once from the agent's flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    pub shell: Option<PathBuf>,
    pub working_dir: PathBuf,
}

/// Clap value parser for `--pty-shell`.
pub fn parse_shell_path(value: &str) -> Result<PathBuf, String> {
    parse_absolute_path(value, "shell")
}

/// Clap value parser for `--pty-working-dir`.
pub fn parse_working_dir(value: &str) -> Result<PathBuf, String> {
    parse_absolute_path(value, "working directory")
}

fn parse_absolute_path(value: &str, what: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || value.len() > MAX_PATH_BYTES || value.contains('\0') {
        return Err(format!(
            "{what} must be a non-empty path of at most {MAX_PATH_BYTES} bytes"
        ));
    }
    if !path.is_absolute() {
        return Err(format!("{what} must be an absolute path"));
    }
    Ok(path.to_path_buf())
}

/// Picks the shell to spawn. An explicit path is authoritative: when it cannot
/// run, the defaults are not consulted, so a misconfiguration is reported
/// instead of silently starting a different shell.
pub fn resolve_shell(
    configured: Option<&Path>,
    is_runnable: impl Fn(&Path) -> bool,
) -> Result<PathBuf, PtyError> {
    if let Some(path) = configured {
        return if is_runnable(path) {
            Ok(path.to_path_buf())
        } else {
            Err(PtyError::ShellUnavailable(format!(
                "configured shell {} is not an executable file",
                path.display()
            )))
        };
    }
    DEFAULT_SHELLS
        .iter()
        .map(Path::new)
        .find(|path| is_runnable(path))
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            PtyError::ShellUnavailable(format!(
                "no executable shell found; tried {}",
                DEFAULT_SHELLS.join(", ")
            ))
        })
}

/// True for a regular file with at least one execute bit. Symlinks are followed.
/// This is a cheap pre-check; the spawn itself is the authoritative test.
pub fn is_runnable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

pub fn check_working_dir(path: &Path) -> Result<(), PtyError> {
    if path.is_dir() {
        Ok(())
    } else {
        Err(PtyError::ShellUnavailable(format!(
            "working directory {} does not exist or is not a directory",
            path.display()
        )))
    }
}

/// Builds the shell environment from an explicit allowlist. `inherited` reads
/// the agent's own environment; nothing else is copied.
pub fn controlled_environment(
    inherited: impl Fn(&str) -> Option<String>,
    shell: &Path,
    user: &str,
    working_dir: &Path,
) -> Vec<(&'static str, String)> {
    let home = inherited("HOME")
        .filter(|home| Path::new(home).is_absolute())
        .unwrap_or_else(|| working_dir.display().to_string());
    let mut environment = vec![
        ("TERM", "xterm-256color".to_owned()),
        ("COLORTERM", "truecolor".to_owned()),
        ("PATH", SHELL_SEARCH_PATH.to_owned()),
        ("SHELL", shell.display().to_string()),
        ("USER", user.to_owned()),
        ("LOGNAME", user.to_owned()),
        ("HOME", home),
    ];
    for key in INHERITED_VARIABLES {
        if let Some(value) = inherited(key).filter(|value| !value.contains('\0')) {
            environment.push((key, value));
        }
    }
    environment
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        DEFAULT_SHELLS, PtyError, SHELL_SEARCH_PATH, controlled_environment, parse_shell_path,
        parse_working_dir, resolve_shell,
    };

    #[test]
    fn shell_and_working_directory_must_be_absolute() {
        assert_eq!(parse_shell_path("/bin/zsh"), Ok(PathBuf::from("/bin/zsh")));
        assert!(parse_shell_path("bash").is_err());
        assert!(parse_shell_path("").is_err());
        assert!(parse_shell_path("/bin/\0sh").is_err());
        assert!(parse_shell_path(&format!("/{}", "a".repeat(300))).is_err());
        assert!(parse_working_dir("relative/dir").is_err());
        assert_eq!(parse_working_dir("/"), Ok(PathBuf::from("/")));
    }

    #[test]
    fn explicit_shell_is_authoritative() {
        let runnable = |path: &Path| path == Path::new("/opt/custom/sh");
        assert_eq!(
            resolve_shell(Some(Path::new("/opt/custom/sh")), runnable),
            Ok(PathBuf::from("/opt/custom/sh"))
        );
        // A broken configured shell must not fall back to /bin/bash silently.
        assert!(matches!(
            resolve_shell(Some(Path::new("/opt/missing")), |path| path == Path::new("/bin/bash")),
            Err(PtyError::ShellUnavailable(message)) if message.contains("/opt/missing")
        ));
    }

    #[test]
    fn default_shell_prefers_bash_then_sh() {
        assert_eq!(DEFAULT_SHELLS, ["/bin/bash", "/bin/sh"]);
        let only_sh = |path: &Path| path == Path::new("/bin/sh");
        assert_eq!(resolve_shell(None, only_sh), Ok(PathBuf::from("/bin/sh")));
        let both = |_: &Path| true;
        assert_eq!(resolve_shell(None, both), Ok(PathBuf::from("/bin/bash")));
        assert!(matches!(
            resolve_shell(None, |_| false),
            Err(PtyError::ShellUnavailable(message)) if message.contains("/bin/bash, /bin/sh")
        ));
    }

    #[test]
    fn environment_is_an_allowlist_and_never_carries_agent_secrets() {
        let agent_env = [
            ("AGENT_TOKEN", "secret-token"),
            ("GITHUB_TOKEN", "gh-secret"),
            ("PATH", "/home/evil/bin"),
            ("HOME", "/var/lib/blossom-agent"),
            ("LANG", "C.UTF-8"),
            ("TZ", "UTC"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
        ];
        let environment = controlled_environment(
            |key| {
                agent_env
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).to_owned())
            },
            Path::new("/bin/bash"),
            "blossom",
            Path::new("/"),
        );
        let lookup = |key: &str| {
            environment
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.as_str())
        };

        assert_eq!(lookup("PATH"), Some(SHELL_SEARCH_PATH));
        assert_eq!(lookup("HOME"), Some("/var/lib/blossom-agent"));
        assert_eq!(lookup("SHELL"), Some("/bin/bash"));
        assert_eq!(lookup("USER"), Some("blossom"));
        assert_eq!(lookup("TERM"), Some("xterm-256color"));
        assert_eq!(lookup("LANG"), Some("C.UTF-8"));
        assert_eq!(lookup("TZ"), Some("UTC"));
        for denied in ["AGENT_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"] {
            assert_eq!(lookup(denied), None, "{denied} must not reach the shell");
        }
        assert!(
            environment
                .iter()
                .all(|(_, value)| !value.contains("secret") && value != "/home/evil/bin")
        );
    }

    #[test]
    fn home_falls_back_to_the_working_directory() {
        let environment = controlled_environment(
            |_| None,
            Path::new("/bin/sh"),
            "uid-1000",
            Path::new("/srv/work"),
        );
        assert!(environment.contains(&("HOME", "/srv/work".to_owned())));
    }
}
