//! N-05: where the main window was, `window.json` in the data folder, so it comes back on the
//! same monitor at the same place and size. The core alone reads and writes it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The window's outer rectangle in physical pixels. While maximized it stays the last normal
/// one, so un-maximizing goes back to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    /// The monitor the window was on.
    #[serde(default)]
    pub monitor: Option<MonitorRef>,
}

/// A monitor as the window last saw it: enough to find it again after a restart, or to tell
/// that it is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRef {
    /// The system's device name (`\\.\DISPLAY2` on Windows).
    pub name: String,
    /// The monitor's work area (the screen less the taskbar) in physical pixels.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// The monitor's scale factor in percent: 100 is 96 dpi, 150 is 144 dpi.
    pub scale_percent: u32,
}

#[derive(Debug, Clone)]
pub struct WindowFile {
    path: PathBuf,
}

impl WindowFile {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join("window.json"),
        }
    }

    /// The saved bounds; `None` when there are none or they don't parse (the window then opens
    /// centered).
    pub fn load(&self) -> Option<WindowBounds> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self, bounds: &WindowBounds) -> std::io::Result<()> {
        let text = serde_json::to_vec_pretty(bounds).map_err(std::io::Error::other)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        wcmd_config::fs::write_atomic(&self.path, &text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n05_window_bounds_round_trip() {
        let dir = std::env::temp_dir().join(format!("wcmd-window-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = WindowFile::in_dir(&dir);
        assert_eq!(file.load(), None);
        let bounds = WindowBounds {
            x: -1200,
            y: 40,
            width: 1100,
            height: 700,
            maximized: true,
            monitor: Some(MonitorRef {
                name: r"\\.\DISPLAY2".into(),
                x: -1920,
                y: 0,
                width: 1920,
                height: 1040,
                scale_percent: 150,
            }),
        };
        file.save(&bounds).unwrap();
        assert_eq!(file.load(), Some(bounds));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
