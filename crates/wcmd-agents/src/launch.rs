//! The line WolfCmd types into a panel's shell to start an agent (N-06): a new session, a
//! resumed one, or the agent's session picker, with Remote Control when it is on.
//!
//! The line is typed into a shell, so everything WolfCmd adds is one argument at a time,
//! quoted for that shell, or left out. Text that can't be quoted safely (newlines, quotes a
//! shell would mangle) never reaches the command line.

use crate::locate::{LaunchShell, Location};
use crate::registry::Agent;

/// How an agent panel starts its agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start<'a> {
    /// A new session. `session` is the ID WolfCmd chose for it (a UUID); the agent is told to
    /// use it when it can be (`session_id` in its entry), so a restored panel resumes exactly
    /// this session.
    New { session: Option<&'a str> },
    /// Back to a known session; without one (or an agent that can't resume by ID), the agent's
    /// own way to continue the latest one.
    Resume { session: Option<&'a str> },
    /// N-06: the agent's own list of earlier sessions (`resume_pick`), for a restored panel
    /// without a session when another panel of the agent already continues the latest one in
    /// the folder. An agent without a picker starts a new session.
    Pick,
}

impl Agent {
    /// The whole line to type to start the agent in a panel whose shell is `shell`:
    /// the command for `how`, started by its quoted full path when the agent is not on PATH,
    /// then WolfCmd's Remote Control arguments when `remote_control` (the session's name) is
    /// given. Each argument WolfCmd adds is quoted for `shell` or left out.
    pub fn start_line(
        &self,
        shell: LaunchShell,
        how: Start<'_>,
        remote_control: Option<&str>,
    ) -> String {
        self.start_line_at(self.locate().as_ref(), shell, how, remote_control)
    }

    /// [`Agent::start_line`] for an executable already found (or not).
    pub(crate) fn start_line_at(
        &self,
        location: Option<&Location>,
        shell: LaunchShell,
        how: Start<'_>,
        remote_control: Option<&str>,
    ) -> String {
        // One command: by its full path when needed, the new session's ID, Remote Control.
        let line = |command: &str, new_session: Option<&str>| {
            let mut line = Self::launch_line_at(location, command, shell);
            if let Some(session) = new_session {
                line = self.with_session_id(&line, session, shell);
            }
            match remote_control {
                Some(name) => self.with_remote_control(&line, name, shell),
                None => line,
            }
        };
        match how {
            Start::New { session } => line(&self.command, session),
            Start::Resume { session } => {
                let resumed = line(&self.resume_command(session), None);
                match session {
                    // N-06: a session the agent never saved can't be resumed: start it anew,
                    // with the same ID (refused by the agent when the session does exist).
                    Some(id) if self.resume_or_new && self.resumes(id) && self.takes_id(id) => {
                        or_else(&resumed, &line(&self.command, Some(id)), shell)
                    }
                    _ => resumed,
                }
            }
            Start::Pick => line(self.pick_command().unwrap_or(&self.command), None),
        }
    }
}

/// `second` run only when `first` fails (non-zero exit), as one line for `shell`. Windows
/// PowerShell 5.1 has no `||`; `$?` is false after a native command that failed, in 5.1 and 7.
fn or_else(first: &str, second: &str, shell: LaunchShell) -> String {
    match shell {
        LaunchShell::PowerShell => format!("{first}; if (-not $?) {{ {second} }}"),
        LaunchShell::Cmd | LaunchShell::Bash | LaunchShell::Other => format!("{first} || {second}"),
    }
}

/// `line` and `args`, each quoted for `shell`; `line` alone when there are none or one can't
/// be passed safely.
pub(crate) fn with_args(line: &str, args: &[String], shell: LaunchShell) -> String {
    match args
        .iter()
        .map(|arg| quote_arg(arg, shell))
        .collect::<Option<Vec<_>>>()
    {
        Some(args) if !args.is_empty() => format!("{line} {}", args.join(" ")),
        _ => line.to_owned(),
    }
}

/// Characters every shell takes as part of a bare word.
fn bare(arg: &str, shell: LaunchShell) -> bool {
    !arg.is_empty()
        && arg.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '-' | '_' | '.' | '/' | ':')
                || (c == '\\' && matches!(shell, LaunchShell::PowerShell | LaunchShell::Cmd))
        })
}

/// `arg` as one argument for `shell`, or `None` when it can't be passed safely: control
/// characters (a newline would run the line), and for Windows PowerShell a `"` (5.1 splits
/// native arguments on it) or for Command Prompt `"`, `%` and `!` (expanded even inside
/// quotes). Nothing in a quoted argument is ever run or expanded.
pub(crate) fn quote_arg(arg: &str, shell: LaunchShell) -> Option<String> {
    if arg.chars().any(char::is_control) {
        return None;
    }
    if bare(arg, shell) {
        return Some(arg.to_owned());
    }
    match shell {
        LaunchShell::PowerShell => {
            if arg.contains('"') || arg.ends_with('\\') {
                return None;
            }
            let mut out = String::from("'");
            for c in arg.chars() {
                // PowerShell also ends a string at typographic single quotes.
                if matches!(c, '\'' | '\u{2018}'..='\u{201B}') {
                    out.push(c);
                }
                out.push(c);
            }
            out.push('\'');
            Some(out)
        }
        LaunchShell::Cmd => {
            if arg.contains(['"', '%', '!']) || arg.ends_with('\\') {
                return None;
            }
            Some(format!("\"{arg}\""))
        }
        LaunchShell::Bash | LaunchShell::Other => Some(format!("'{}'", arg.replace('\'', r"'\''"))),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::registry::{agent_from, builtin, builtin_agents};

    const ID: &str = "3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21";

    fn line(agent: &str, how: Start<'_>, remote: Option<&str>) -> String {
        // Not found anywhere: typed by name, whatever is installed on this machine.
        builtin(agent).start_line_at(None, LaunchShell::PowerShell, how, remote)
    }

    #[test]
    fn n06_a_new_session_gets_the_id_when_the_agent_takes_one() {
        assert_eq!(
            line("claude-code", Start::New { session: Some(ID) }, None),
            format!("claude --session-id {ID}")
        );
        assert_eq!(
            line("claude-code", Start::New { session: None }, None),
            "claude"
        );
        // An agent that can't be given an ID starts plainly.
        assert_eq!(
            line("codex", Start::New { session: Some(ID) }, None),
            "codex"
        );
        // An ID that isn't plain is never typed.
        assert_eq!(
            line(
                "claude-code",
                Start::New {
                    session: Some("x; rm -rf ~")
                },
                None
            ),
            "claude"
        );
    }

    #[test]
    fn n06_a_restored_panel_resumes_its_session_or_continues() {
        // Claude Code may not have saved the session yet: then it starts with the same ID.
        assert_eq!(
            line("claude-code", Start::Resume { session: Some(ID) }, None),
            format!("claude --resume {ID}; if (-not $?) {{ claude --session-id {ID} }}")
        );
        assert_eq!(
            line("claude-code", Start::Resume { session: None }, None),
            "claude --continue"
        );
        assert_eq!(
            line(
                "claude-code",
                Start::Resume {
                    session: Some("a b")
                },
                None
            ),
            "claude --continue"
        );
        // Codex has no ID of its own to give: it resumes the latest session in the folder.
        assert_eq!(
            line("codex", Start::Resume { session: None }, None),
            "codex resume --last"
        );
        assert_eq!(
            line("gemini", Start::Resume { session: Some(ID) }, None),
            "gemini"
        );
    }

    #[test]
    fn n06_a_never_saved_session_starts_anew_with_its_id_in_every_shell() {
        let claude = builtin("claude-code");
        assert!(claude.resume_or_new);
        let restore =
            |shell| claude.start_line_at(None, shell, Start::Resume { session: Some(ID) }, None);
        assert_eq!(
            restore(LaunchShell::Bash),
            format!("claude --resume {ID} || claude --session-id {ID}")
        );
        assert_eq!(
            restore(LaunchShell::Other),
            format!("claude --resume {ID} || claude --session-id {ID}")
        );
        // No session, or one that can't be typed: the fallback alone.
        let fallback = |session| {
            claude.start_line_at(None, LaunchShell::Bash, Start::Resume { session }, None)
        };
        assert_eq!(fallback(None), "claude --continue");
        assert_eq!(fallback(Some("x; rm")), "claude --continue");
        // Only agents that say so, and only when they can be given the ID.
        let x = agent_from(
            r#"id = "x"
name = "X"
order = 90
command = "x"
detect = ["x"]
resume = "x --resume {session_id}"
resume_or_new = true"#,
        );
        assert_eq!(
            x.start_line_at(
                None,
                LaunchShell::Bash,
                Start::Resume { session: Some(ID) },
                None
            ),
            format!("x --resume {ID}")
        );
        for agent in builtin_agents() {
            if agent.resume_or_new {
                assert!(
                    !agent.session_id.is_empty() && agent.resume.is_some(),
                    "{}",
                    agent.id
                );
            }
        }
    }

    #[test]
    fn n06_a_second_panel_without_a_session_opens_the_agents_picker() {
        assert_eq!(line("claude-code", Start::Pick, None), "claude --resume");
        assert_eq!(line("codex", Start::Pick, None), "codex resume");
        // No picker: a new session, never a guess.
        assert_eq!(line("gemini", Start::Pick, None), "gemini");
    }

    #[test]
    fn n06_remote_control_comes_last_on_all_three() {
        let name = Some("wolfcmd · main");
        assert_eq!(
            line("claude-code", Start::New { session: Some(ID) }, name),
            format!("claude --session-id {ID} --remote-control 'wolfcmd · main'")
        );
        assert_eq!(
            line("claude-code", Start::Resume { session: Some(ID) }, name),
            format!(
                "claude --resume {ID} --remote-control 'wolfcmd · main'; if (-not $?) {{ claude \
                 --session-id {ID} --remote-control 'wolfcmd · main' }}"
            )
        );
        assert_eq!(
            line("claude-code", Start::Pick, name),
            "claude --resume --remote-control 'wolfcmd · main'"
        );
        // Not on: nothing added. An agent without the option: its line stays.
        assert_eq!(
            line("claude-code", Start::Resume { session: None }, None),
            "claude --continue"
        );
        assert_eq!(line("codex", Start::New { session: None }, name), "codex");
    }

    #[test]
    fn n06_an_agent_outside_path_starts_by_its_quoted_full_path() {
        let claude = builtin("claude-code");
        let path = PathBuf::from(r"C:\Users\Jane Doe\AppData\Local\claude.exe");
        let found = Location::File(path);
        let start = |shell, how, remote| claude.start_line_at(Some(&found), shell, how, remote);
        assert_eq!(
            start(
                LaunchShell::PowerShell,
                Start::New { session: Some(ID) },
                Some("w")
            ),
            format!(
                r"& 'C:\Users\Jane Doe\AppData\Local\claude.exe' --session-id {ID} --remote-control w"
            )
        );
        let exe = r#""C:\Users\Jane Doe\AppData\Local\claude.exe""#;
        assert_eq!(
            start(LaunchShell::Cmd, Start::Resume { session: Some(ID) }, None),
            format!("{exe} --resume {ID} || {exe} --session-id {ID}")
        );
        // On PATH: by name.
        assert_eq!(
            claude.start_line_at(
                Some(&Location::OnPath),
                LaunchShell::Bash,
                Start::New { session: None },
                None
            ),
            "claude"
        );
    }

    #[test]
    fn quoting_refuses_what_a_shell_would_run() {
        assert_eq!(quote_arg("a\nb", LaunchShell::Bash), None);
        assert_eq!(quote_arg("a\x1b[201~", LaunchShell::PowerShell), None);
        assert_eq!(quote_arg("a\"b c", LaunchShell::PowerShell), None);
        assert_eq!(quote_arg("%PATH%", LaunchShell::Cmd), None);
        assert_eq!(quote_arg(r"C:\x y\", LaunchShell::Cmd), None);
        assert_eq!(
            quote_arg("plain-word", LaunchShell::Cmd).as_deref(),
            Some("plain-word")
        );
        assert_eq!(
            quote_arg("a b", LaunchShell::Cmd).as_deref(),
            Some("\"a b\"")
        );
        assert_eq!(
            quote_arg(r"C:\x", LaunchShell::Bash).as_deref(),
            Some(r"'C:\x'")
        );
        assert_eq!(
            quote_arg("it's", LaunchShell::PowerShell).as_deref(),
            Some("'it''s'")
        );
    }
}
