/// Errors from PTY operations. `portable-pty` reports `anyhow` errors, which are kept as text.
#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("could not open a pseudo console: {0}")]
    Open(String),
    #[error("could not start `{program}`: {message}")]
    Spawn { program: String, message: String },
    #[error("could not resize the pseudo console: {0}")]
    Resize(String),
    #[error("could not write to the shell: {0}")]
    Write(#[from] std::io::Error),
}
