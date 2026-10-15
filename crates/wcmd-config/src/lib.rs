//! `wcmd-config`: the user's settings (N-07) and crash-safe whole-file writes ([`fs`]).

pub mod fs;
mod platform;
mod settings;

pub use settings::{
    AgentSettings, AppearanceSettings, CURRENT_VERSION, Cursor, FONT_SIZE_MAX, FONT_SIZE_MIN,
    Settings, SettingsFile, SettingsLoaded, SettingsReadOnly, TerminalSettings, Theme,
    WindowSettings,
};
