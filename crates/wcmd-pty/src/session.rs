//! One shell process attached to a pseudo console.

use std::io::{Read, Write};
use std::path::Path;

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, native_pty_system};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::PtyError;
use crate::profiles::Profile;

/// Terminal size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    fn to_portable(self) -> portable_pty::PtySize {
        portable_pty::PtySize {
            rows: self.rows.max(1),
            cols: self.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// The parts of a freshly spawned shell, handed out separately so each can live on the
/// thread that needs it.
pub struct Spawned {
    /// Resize and kill.
    pub session: PtySession,
    /// The input side. Write from one dedicated thread so a full pipe never blocks callers.
    pub writer: PtyWriter,
    /// Blocking reader of the shell's output. Read it on a dedicated thread, never on the
    /// async runtime.
    pub reader: Box<dyn Read + Send>,
    /// Wait on this (on its own thread) to learn when the shell exits.
    pub child: Box<dyn Child + Send + Sync>,
}

impl std::fmt::Debug for Spawned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Spawned").finish_non_exhaustive()
    }
}

/// The control side of a shell session (resize, kill).
///
/// Dropping it closes the pseudo console, which ends the reader with EOF. On Windows the
/// reader does **not** see EOF when the shell exits; wait on [`Spawned::child`] instead.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl std::fmt::Debug for PtySession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtySession").finish_non_exhaustive()
    }
}

/// Whether an environment variable only marks a running agent *session* (Claude Code's
/// `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`…, Codex's sandbox and
/// thread markers). When WolfCmd itself was started from an agent's shell, passing these on
/// makes the agent in a new panel think it is a child session (no transcript is saved, which
/// also breaks summaries). The user's own settings (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`,
/// `CLAUDE_CODE_USE_*`, API base URLs…) are kept.
pub(crate) fn is_agent_session_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CLAUDECODE" | "CODEX_THREAD_ID" | "CODEX_SESSION_ID" | "GEMINI_CLI_SESSION_ID"
    ) || upper.starts_with("CODEX_SANDBOX")
    {
        return true;
    }
    upper.strip_prefix("CLAUDE_CODE_").is_some_and(|rest| {
        [
            "SESSION",
            "CHILD",
            "ENTRYPOINT",
            "SSE_PORT",
            "PARENT",
            "EXECPATH",
            "IDE_",
        ]
        .iter()
        .any(|marker| rest.contains(marker))
    })
}

impl PtySession {
    /// Starts `profile` in a new pseudo console of `size`, in `cwd` if given.
    pub fn spawn(
        profile: &Profile,
        size: PtySize,
        cwd: Option<&Path>,
    ) -> Result<Spawned, PtyError> {
        let open_error = |e: &dyn std::fmt::Display| PtyError::Open(e.to_string());
        let pair = native_pty_system()
            .openpty(size.to_portable())
            .map_err(|e| open_error(&format!("{e:#}")))?;

        let mut command = CommandBuilder::new(&profile.program);
        command.args(&profile.args);
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        // WolfCmd started from an agent's shell must not pass that session on.
        for key in std::env::vars_os()
            .filter_map(|(key, _)| key.into_string().ok())
            .filter(|key| is_agent_session_var(key))
        {
            command.env_remove(key);
        }
        // Tell TUIs (agents included) what they're talking to.
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "WolfCmd");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        // Set by shell integration (`ShellIntegration::apply`).
        for (key, value) in &profile.env {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| PtyError::Spawn {
                program: profile.program.clone(),
                message: format!("{e:#}"),
            })?;
        // The slave handle must be closed in this process, or the console never finishes.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| open_error(&format!("{e:#}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| open_error(&format!("{e:#}")))?;
        let killer = child.clone_killer();

        Ok(Spawned {
            session: Self {
                master: pair.master,
                killer,
            },
            writer: PtyWriter { writer },
            reader,
            child,
        })
    }

    pub fn resize(&self, size: PtySize) -> Result<(), PtyError> {
        self.master
            .resize(size.to_portable())
            .map_err(|e| PtyError::Resize(format!("{e:#}")))
    }

    /// Ends the shell process. The child waiter then reports the exit, which is the only
    /// reliable signal that it worked.
    pub fn kill(&mut self) {
        // portable-pty 0.9 inverts TerminateProcess's result on Windows: a successful kill
        // returns Err with a stale OS error, and a failed one returns Ok. Ignore it.
        if let Err(error) = self.killer.kill() {
            tracing::debug!(%error, "kill reported an error (unreliable on Windows)");
        }
    }
}

/// The input side of a shell session.
pub struct PtyWriter {
    writer: Box<dyn Write + Send>,
}

impl std::fmt::Debug for PtyWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyWriter").finish_non_exhaustive()
    }
}

impl PtyWriter {
    /// Writes input straight through, unbuffered. Blocks while the shell isn't
    /// reading, so call it from a dedicated thread.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), PtyError> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::is_agent_session_var;

    #[test]
    fn agent_session_markers_are_stripped_but_user_settings_stay() {
        for name in [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SSE_PORT",
            "CLAUDE_CODE_SESSION_ID",
            "claudecode",
            "CODEX_SANDBOX",
            "CODEX_SANDBOX_NETWORK_DISABLED",
            "CODEX_THREAD_ID",
        ] {
            assert!(is_agent_session_var(name), "{name}");
        }
        for name in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "CODEX_HOME",
            "OPENAI_BASE_URL",
            "PATH",
            "WOLFCMD_PIPE",
        ] {
            assert!(!is_agent_session_var(name), "{name}");
        }
    }
}
