//! The main window comes back where it was: on the same monitor, at the same
//! place and size in that monitor's coordinates, maximized or not.
//!
//! What is saved (`wcmd_state::WindowBounds`): the window's outer rectangle in physical
//! pixels, whether it is maximized, and the monitor it is on (device name, work area, scale).
//! While maximized the saved rectangle stays the last *normal* one, so un-maximizing goes
//! back to it, the `GetWindowPlacement` / `SetWindowPlacement` behavior; it is carried over to
//! another monitor when the maximized window is moved there (`rehome`).
//!
//! Restoring is a pure decision, `restore_plan(saved, displays) -> Plan`, tested without a
//! window:
//! - the monitor is found by identity (name and work area; then the name alone, e.g. a changed
//!   resolution; then the work area alone, e.g. a renamed device);
//! - the rectangle keeps its offset from the monitor's work-area origin and its logical size,
//!   so it is rescaled when the monitor's scale changed (Per-Monitor v2 DPI);
//! - it is nudged fully on screen (a few pixels of overhang stay: a snapped window's invisible
//!   borders), and a window the monitor cannot hold shrinks to its work area;
//! - a missing monitor sends the window to the primary one, centered;
//! - bounds saved without a monitor have no monitor: the monitor under their title bar is used.
//!
//! Win32 calls (`platform::window_rect` / `place_window`) read and set the outer rectangle:
//! Tauri's `set_size` adds a caption height this frameless window doesn't have, so a round
//! trip through it grew the window. The position is set before the size: moving onto a monitor
//! with another DPI makes Windows rescale the window, and the size set afterwards wins.
//! Maximizing waits for `reveal`, since maximizing a hidden window shows it before its first
//! frame; the window is placed on the target monitor first, so it maximizes there.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Monitor;
use tauri::{Manager as _, WebviewWindow, WindowEvent};
use wcmd_state::{MonitorRef, WindowBounds};

use crate::platform;
use crate::state::StateService;

/// Smallest visible width of a legacy window's title bar that counts as "on screen".
const MIN_VISIBLE: i64 = 100;
/// How far (physical pixels) a window may overhang its monitor's work area: the invisible
/// resize borders Windows gives a snapped or maximized window.
const EDGE_SLACK: i64 = 16;

/// Set when the restored window should open maximized; consumed by `ipc::app::reveal`.
#[derive(Debug, Default)]
pub(crate) struct RestoreMaximized(AtomicBool);

impl RestoreMaximized {
    pub(crate) fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rect {
    pub(crate) x: i64,
    pub(crate) y: i64,
    pub(crate) width: i64,
    pub(crate) height: i64,
}

/// A monitor that is connected now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Display {
    pub(crate) monitor: MonitorRef,
    pub(crate) primary: bool,
}

/// Where a restored window ended up, for the log and the tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Landing {
    /// On the monitor it was saved on (or the one under its legacy title bar).
    Found,
    /// Its monitor is gone: centered on the primary one.
    Fallback,
}

/// What to do with the window at launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Plan {
    /// The outer rectangle in physical screen pixels.
    pub(crate) rect: Rect,
    pub(crate) maximized: bool,
    pub(crate) landing: Landing,
}

fn work_area(monitor: &MonitorRef) -> Rect {
    Rect {
        x: monitor.x.into(),
        y: monitor.y.into(),
        width: monitor.width.into(),
        height: monitor.height.into(),
    }
}

fn rect_of(bounds: &WindowBounds) -> Rect {
    Rect {
        x: bounds.x.into(),
        y: bounds.y.into(),
        width: bounds.width.into(),
        height: bounds.height.into(),
    }
}

/// `value` in the pixels of `to` when it was measured in those of `from` (the same logical
/// size on another scale). Unchanged without a source monitor.
fn scaled(value: i64, from: Option<&MonitorRef>, to: &MonitorRef) -> i64 {
    match from {
        Some(from) if from.scale_percent > 0 && to.scale_percent > 0 => {
            value * i64::from(to.scale_percent) / i64::from(from.scale_percent)
        }
        _ => value,
    }
}

/// One axis of `fit_within`: a position that overhangs the work area by no more than `slack`
/// stays, any other is moved fully inside.
fn fit_axis(pos: i64, len: i64, start: i64, extent: i64, slack: i64) -> i64 {
    let hard_max = start + extent - len;
    if pos >= start - slack && pos <= hard_max + slack {
        pos
    } else {
        pos.clamp(start, hard_max.max(start))
    }
}

/// `rect` shrunk to fit `area` and moved fully inside it; an overhang of up to `slack` on
/// each side (a snapped window's invisible borders) is left alone.
fn fit_within(rect: Rect, area: Rect, slack: i64) -> Rect {
    let area_width = area.width.max(1);
    let area_height = area.height.max(1);
    let size = |len: i64, extent: i64| {
        if len <= extent + 2 * slack {
            len.max(1)
        } else {
            extent
        }
    };
    let width = size(rect.width, area_width);
    let height = size(rect.height, area_height);
    Rect {
        x: fit_axis(rect.x, width, area.x, area_width, slack),
        y: fit_axis(rect.y, height, area.y, area_height, slack),
        width,
        height,
    }
}

/// `saved`, measured on monitor `from` (`None`: its coordinates are already screen
/// coordinates), as it sits on monitor `to`: the same offset from the work-area origin, the
/// same logical size, nudged on screen.
fn fit(saved: Rect, from: Option<&MonitorRef>, to: &MonitorRef) -> Rect {
    let area = work_area(to);
    let (origin_x, origin_y) = from.map_or((area.x, area.y), |f| (f.x.into(), f.y.into()));
    let moved = Rect {
        x: area.x + scaled(saved.x - origin_x, from, to),
        y: area.y + scaled(saved.y - origin_y, from, to),
        width: scaled(saved.width, from, to),
        height: scaled(saved.height, from, to),
    };
    fit_within(moved, area, EDGE_SLACK)
}

/// The size of `saved` (rescaled, shrunk to the work area), centered on `to`.
fn centered(saved: Rect, from: Option<&MonitorRef>, to: &MonitorRef) -> Rect {
    let area = work_area(to);
    let size = fit_within(
        Rect {
            x: area.x,
            y: area.y,
            width: scaled(saved.width, from, to),
            height: scaled(saved.height, from, to),
        },
        area,
        0,
    );
    Rect {
        x: area.x + (area.width.max(1) - size.width) / 2,
        y: area.y + (area.height.max(1) - size.height) / 2,
        ..size
    }
}

/// The connected monitor `saved` describes: same name and work area, else the same name (its
/// resolution or the arrangement changed), else the same work area (the device was renamed).
fn find_display<'a>(saved: &MonitorRef, displays: &'a [Display]) -> Option<&'a Display> {
    let same_name = |d: &&Display| !saved.name.is_empty() && d.monitor.name == saved.name;
    let same_area = |d: &&Display| work_area(&d.monitor) == work_area(saved);
    displays
        .iter()
        .find(|d| same_name(d) && same_area(d))
        .or_else(|| displays.iter().find(same_name))
        .or_else(|| displays.iter().find(same_area))
}

/// Bounds saved without a monitor have none: the one showing the most of the window's title bar, if
/// enough of it is visible.
fn display_under(rect: Rect, displays: &[Display]) -> Option<&Display> {
    let bar = Rect {
        height: 40.min(rect.height),
        ..rect
    };
    displays
        .iter()
        .filter_map(|d| {
            let m = work_area(&d.monitor);
            let w = (bar.x + bar.width).min(m.x + m.width) - bar.x.max(m.x);
            let h = (bar.y + bar.height).min(m.y + m.height) - bar.y.max(m.y);
            (w >= MIN_VISIBLE && h > 0).then_some((d, w))
        })
        .max_by_key(|&(_, w)| w)
        .map(|(d, _)| d)
}

/// Where the window goes at launch. `None` only when no monitor is connected.
pub(crate) fn restore_plan(saved: &WindowBounds, displays: &[Display]) -> Option<Plan> {
    let rect = rect_of(saved);
    let found = match &saved.monitor {
        Some(monitor) => find_display(monitor, displays),
        None => display_under(rect, displays),
    };
    let (rect, landing) = if let Some(display) = found {
        (
            fit(rect, saved.monitor.as_ref(), &display.monitor),
            Landing::Found,
        )
    } else {
        let target = displays
            .iter()
            .find(|d| d.primary)
            .or_else(|| displays.first())?;
        (
            centered(rect, saved.monitor.as_ref(), &target.monitor),
            Landing::Fallback,
        )
    };
    Some(Plan {
        rect,
        maximized: saved.maximized,
        landing,
    })
}

/// The normal rectangle of a window that was maximized on another monitor and is now
/// maximized on `to`: the same place and logical size on the new monitor, so un-maximizing
/// there lands where Windows would put it.
pub(crate) fn rehome(saved: &WindowBounds, to: &MonitorRef) -> Rect {
    fit(rect_of(saved), saved.monitor.as_ref(), to)
}

// The value is clamped to 25..=1000 first, so the cast cannot truncate or change sign.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn scale_percent(scale: f64) -> u32 {
    (scale * 100.0).round().clamp(25.0, 1000.0) as u32
}

fn monitor_ref(monitor: &Monitor) -> MonitorRef {
    let area = monitor.work_area();
    MonitorRef {
        name: monitor.name().cloned().unwrap_or_default(),
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
        scale_percent: scale_percent(monitor.scale_factor()),
    }
}

fn connected_displays(window: &WebviewWindow) -> tauri::Result<Vec<Display>> {
    let primary = window.primary_monitor()?.map(|m| monitor_ref(&m));
    Ok(window
        .available_monitors()?
        .iter()
        .map(|m| {
            let monitor = monitor_ref(m);
            Display {
                primary: primary.as_ref() == Some(&monitor),
                monitor,
            }
        })
        .collect())
}

/// Applies saved bounds to the (still hidden) window.
pub(crate) fn restore(window: &WebviewWindow, bounds: &WindowBounds) -> tauri::Result<()> {
    let displays = connected_displays(window)?;
    let Some(plan) = restore_plan(bounds, &displays) else {
        return Ok(());
    };
    platform::place_window(window, plan.rect)?;
    if plan.maximized {
        window
            .state::<RestoreMaximized>()
            .0
            .store(true, Ordering::SeqCst);
    }
    tracing::debug!(
        rect = ?plan.rect,
        maximized = plan.maximized,
        landing = ?plan.landing,
        "window bounds restored"
    );
    Ok(())
}

/// Saves the bounds whenever the window moves, resizes or (un)maximizes.
pub(crate) fn track(window: &WebviewWindow, workspaces: Arc<StateService>) {
    let tracked = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        if let Some(bounds) = current(&tracked, workspaces.window()) {
            workspaces.set_window(bounds);
        }
    });
}

fn bounds_of(rect: Rect, maximized: bool, monitor: Option<MonitorRef>) -> Option<WindowBounds> {
    Some(WindowBounds {
        x: i32::try_from(rect.x).ok()?,
        y: i32::try_from(rect.y).ok()?,
        width: u32::try_from(rect.width).ok()?,
        height: u32::try_from(rect.height).ok()?,
        maximized,
        monitor,
    })
}

fn current(window: &WebviewWindow, previous: Option<WindowBounds>) -> Option<WindowBounds> {
    if window.is_minimized().ok()? || !window.is_visible().ok()? {
        return None;
    }
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| monitor_ref(&m));
    if window.is_maximized().ok()? {
        // Keep the normal bounds to return to; the flag changes, and so does the monitor when
        // the maximized window was moved to another one.
        let previous = previous?;
        let rect = match &monitor {
            Some(now) if previous.monitor.as_ref() != Some(now) => rehome(&previous, now),
            _ => rect_of(&previous),
        };
        return bounds_of(rect, true, monitor.or(previous.monitor));
    }
    let rect = platform::window_rect(window).ok()?;
    bounds_of(rect, false, monitor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(name: &str, area: (i32, i32, u32, u32), scale_percent: u32) -> MonitorRef {
        MonitorRef {
            name: name.to_owned(),
            x: area.0,
            y: area.1,
            width: area.2,
            height: area.3,
            scale_percent,
        }
    }

    fn left() -> MonitorRef {
        monitor(r"\\.\DISPLAY2", (-1920, 0, 1920, 1040), 100)
    }

    fn main_monitor() -> MonitorRef {
        monitor(r"\\.\DISPLAY1", (0, 0, 2560, 1400), 100)
    }

    fn both() -> Vec<Display> {
        vec![
            Display {
                monitor: left(),
                primary: false,
            },
            Display {
                monitor: main_monitor(),
                primary: true,
            },
        ]
    }

    fn only_main() -> Vec<Display> {
        vec![Display {
            monitor: main_monitor(),
            primary: true,
        }]
    }

    fn saved(rect: (i32, i32, u32, u32), on: Option<MonitorRef>, maximized: bool) -> WindowBounds {
        WindowBounds {
            x: rect.0,
            y: rect.1,
            width: rect.2,
            height: rect.3,
            maximized,
            monitor: on,
        }
    }

    fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn the_window_returns_to_its_monitor_at_the_same_place() {
        let plan = restore_plan(
            &saved((-1500, 100, 1200, 800), Some(left()), false),
            &both(),
        );
        assert_eq!(
            plan,
            Some(Plan {
                rect: rect(-1500, 100, 1200, 800),
                maximized: false,
                landing: Landing::Found,
            })
        );
    }

    #[test]
    fn the_offset_follows_a_monitor_that_moved_in_the_arrangement() {
        // DISPLAY2 sat at x = -1920 when saved and is now further left.
        let moved = vec![Display {
            monitor: monitor(r"\\.\DISPLAY2", (-2560, 0, 1920, 1040), 100),
            primary: false,
        }];
        let plan = restore_plan(&saved((-1500, 100, 1200, 800), Some(left()), false), &moved);
        assert_eq!(plan.map(|p| p.rect), Some(rect(-2140, 100, 1200, 800)));
    }

    #[test]
    fn a_monitor_is_found_by_its_area_when_its_device_was_renamed() {
        let renamed = vec![Display {
            monitor: monitor(r"\\.\DISPLAY7", (-1920, 0, 1920, 1040), 100),
            primary: true,
        }];
        let plan = restore_plan(
            &saved((-1500, 100, 1200, 800), Some(left()), false),
            &renamed,
        );
        assert_eq!(
            plan.map(|p| (p.rect, p.landing)),
            Some((rect(-1500, 100, 1200, 800), Landing::Found))
        );
    }

    #[test]
    fn the_size_follows_a_monitor_whose_scale_changed() {
        // Saved at 100%: 1000x700 at (100, 100) from the origin. The monitor is now at 150%.
        let before = monitor(r"\\.\DISPLAY1", (0, 0, 2560, 1400), 100);
        let after = vec![Display {
            monitor: monitor(r"\\.\DISPLAY1", (0, 0, 2560, 1400), 150),
            primary: true,
        }];
        let plan = restore_plan(&saved((100, 100, 1000, 700), Some(before), false), &after);
        assert_eq!(plan.map(|p| p.rect), Some(rect(150, 150, 1500, 1050)));
    }

    #[test]
    fn a_window_moves_between_monitors_of_different_scale_keeping_its_logical_size() {
        let on_main = saved((100, 100, 1000, 700), Some(main_monitor()), true);
        let hidpi = monitor(r"\\.\DISPLAY2", (-3840, 0, 3840, 2100), 200);
        assert_eq!(rehome(&on_main, &hidpi), rect(-3640, 200, 2000, 1400));
    }

    #[test]
    fn a_missing_monitor_sends_the_window_to_the_primary_one_centered() {
        let plan = restore_plan(
            &saved((-1500, 100, 1200, 800), Some(left()), false),
            &only_main(),
        );
        assert_eq!(
            plan,
            Some(Plan {
                rect: rect(680, 300, 1200, 800),
                maximized: false,
                landing: Landing::Fallback,
            })
        );
    }

    #[test]
    fn a_missing_monitor_shrinks_the_window_to_the_primary_work_area() {
        let big = monitor(r"\\.\DISPLAY3", (0, 0, 5120, 2880), 100);
        let plan = restore_plan(
            &saved((100, -900, 4000, 3000), Some(big), false),
            &only_main(),
        );
        assert_eq!(plan.map(|p| p.rect), Some(rect(0, 0, 2560, 1400)));
    }

    #[test]
    fn a_missing_monitor_keeps_the_logical_size_on_a_monitor_of_another_scale() {
        let hidpi = monitor(r"\\.\DISPLAY3", (0, 0, 3840, 2100), 150);
        let plan = restore_plan(
            &saved((100, 100, 1500, 1050), Some(hidpi), false),
            &only_main(),
        );
        assert_eq!(plan.map(|p| p.rect), Some(rect(780, 350, 1000, 700)));
    }

    #[test]
    fn a_partly_off_screen_window_is_nudged_fully_on_screen() {
        let plan = restore_plan(
            &saved((2000, 1000, 1200, 800), Some(main_monitor()), false),
            &both(),
        );
        assert_eq!(plan.map(|p| p.rect), Some(rect(1360, 600, 1200, 800)));
        let above = restore_plan(
            &saved((-400, -300, 1200, 800), Some(main_monitor()), false),
            &both(),
        );
        assert_eq!(above.map(|p| p.rect), Some(rect(0, 0, 1200, 800)));
    }

    #[test]
    fn a_snapped_window_keeps_its_position_and_size() {
        // Aero Snap: the left half, with the invisible borders overhanging the work area.
        let snapped = saved((-7, 0, 1294, 1407), Some(main_monitor()), false);
        let plan = restore_plan(&snapped, &both());
        assert_eq!(plan.map(|p| p.rect), Some(rect(-7, 0, 1294, 1407)));
    }

    #[test]
    fn a_maximized_window_is_restored_onto_its_monitor_with_the_normal_bounds() {
        let plan =
            restore_plan(&saved((-1500, 100, 1200, 800), Some(left()), true), &both()).unwrap();
        assert!(plan.maximized);
        assert_eq!(plan.rect, rect(-1500, 100, 1200, 800));
        // The monitor is gone: maximized on the primary one instead.
        let moved = restore_plan(
            &saved((-1500, 100, 1200, 800), Some(left()), true),
            &only_main(),
        )
        .unwrap();
        assert!(moved.maximized);
        assert_eq!(moved.landing, Landing::Fallback);
    }

    #[test]
    fn bounds_without_a_monitor_use_the_monitor_under_the_title_bar() {
        let kept = restore_plan(&saved((-1500, 100, 1200, 800), None, false), &both());
        assert_eq!(kept.map(|p| p.rect), Some(rect(-1500, 100, 1200, 800)));
        let gone = restore_plan(&saved((-1500, 100, 1200, 800), None, false), &only_main());
        assert_eq!(gone.map(|p| p.rect), Some(rect(680, 300, 1200, 800)));
    }

    #[test]
    fn a_title_bar_that_cannot_be_reached_is_not_enough_and_the_size_fits_the_screen() {
        // Only the bottom of the window shows on the primary monitor.
        let above = saved((100, -900, 3000, 1000), None, false);
        let placed = restore_plan(&above, &only_main()).unwrap().rect;
        assert_eq!((placed.x, placed.y), (0, 200));
        assert_eq!((placed.width, placed.height), (2560, 1000));
    }

    #[test]
    fn no_monitor_means_no_plan() {
        assert_eq!(
            restore_plan(&saved((0, 0, 800, 600), None, false), &[]),
            None
        );
    }
}
