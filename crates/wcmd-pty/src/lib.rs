//! `wcmd-pty`: spawns shells in pseudo consoles (ConPTY on Windows) and finds shell profiles.

mod error;
mod host;
mod integration;
mod platform;
mod profiles;
mod session;

pub use error::PtyError;
pub use host::{ConsoleHost, console_host};
pub use integration::{SHELL_INTEGRATION_ENV, ShellIntegration, ShellKind};
pub use portable_pty::Child;
pub use profiles::{
    DEFAULT_PROFILE_ENV, Profile, default_profile_preferring, find_profile, installed_profiles,
};
pub use session::{PtySession, PtySize, PtyWriter, Spawned};
