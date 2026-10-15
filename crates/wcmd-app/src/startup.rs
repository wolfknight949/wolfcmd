//! N-01: startup timing and the window's first pixel.
//!
//! - [`mark_started`] notes when the process started, so the log can say how long each
//!   startup step took (`since_start_ms`), in debug and release builds alike.
//! - [`background_for`] is the window's color before the page paints anything, and what a
//!   resize uncovers before the page paints it again (N-03): the UI's `--wc-bg-subtle` token (the
//!   panel area, `packages/ui-kit/src/tokens/tokens.css`) for the theme setting (Auto: the
//!   system's). The page then keeps it in step with the theme (`core/app.ts`).

use std::sync::OnceLock;
use std::time::Instant;

use tauri::window::Color;

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Called first thing in `run()`; later calls keep the first time.
pub(crate) fn mark_started() {
    let _ = STARTED.get_or_init(Instant::now);
}

/// Milliseconds since [`mark_started`] (0 if it was never called).
pub(crate) fn since_start_ms() -> u64 {
    STARTED.get().map_or(0, |started| {
        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
    })
}

/// `--wc-bg-subtle` in the dark theme (also `backgroundColor` in `tauri.conf.json`).
pub(crate) const DARK_BACKGROUND: Color = Color(0x1f, 0x1e, 0x1d, 0xff);
/// `--wc-bg-subtle` in the light theme.
pub(crate) const LIGHT_BACKGROUND: Color = Color(0xf0, 0xed, 0xe7, 0xff);

/// The window's background for the theme setting (`Auto` follows the system's), so a
/// resize never uncovers a light frame around a dark page, or the other way round.
pub(crate) fn background_for(setting: wcmd_config::Theme, system: tauri::Theme) -> Color {
    let light = match setting {
        wcmd_config::Theme::Light => true,
        wcmd_config::Theme::Dark => false,
        wcmd_config::Theme::Auto => system == tauri::Theme::Light,
    };
    if light {
        LIGHT_BACKGROUND
    } else {
        DARK_BACKGROUND
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wcmd_config::Theme;

    #[test]
    fn n03_the_background_follows_the_theme_setting() {
        assert_eq!(
            background_for(Theme::Dark, tauri::Theme::Light),
            DARK_BACKGROUND
        );
        assert_eq!(
            background_for(Theme::Light, tauri::Theme::Dark),
            LIGHT_BACKGROUND
        );
        assert_eq!(
            background_for(Theme::Auto, tauri::Theme::Light),
            LIGHT_BACKGROUND
        );
        assert_eq!(
            background_for(Theme::Auto, tauri::Theme::Dark),
            DARK_BACKGROUND
        );
    }
}
