//! N-06: telling the user an agent finished while the window wasn't in front: the taskbar
//! button flashes until the window comes forward, and a system notification (a Windows toast)
//! says which agent in which tab. Only names go into it, never terminal content.

use std::sync::{Mutex, PoisonError};

use tauri::WebviewWindow;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    FLASHW_TIMERNOFG, FLASHW_TRAY, FLASHWINFO, FlashWindowEx,
};
use windows_core::{HSTRING, IInspectable};

/// The `AppUserModelID` Windows PowerShell registers: a dev build has no Start menu shortcut
/// with WolfCmd's own id, so its toasts go under this one (as Tauri's notification plugin does).
const DEV_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/// The toast on screen, kept so its click handler lives as long as it does.
static SHOWN: Mutex<Option<ToastNotification>> = Mutex::new(None);

/// Flashes the window's taskbar button until the window comes to the foreground.
pub(crate) fn flash_taskbar(window: &WebviewWindow) -> tauri::Result<()> {
    let hwnd = window.hwnd()?;
    let info = FLASHWINFO {
        cbSize: u32::try_from(std::mem::size_of::<FLASHWINFO>()).unwrap_or(u32::MAX),
        hwnd: HWND(hwnd.0),
        dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
        uCount: 3,
        dwTimeout: 0,
    };
    // SAFETY: `info` is a fully initialized FLASHWINFO for this window's handle; the call only
    // changes how its taskbar button is drawn (its return value is the previous state).
    unsafe {
        let _ = FlashWindowEx(&raw const info);
    }
    Ok(())
}

/// The id toasts are shown under: the app's identifier (its installer's Start menu shortcut
/// carries it), or PowerShell's for a build run from a cargo `target` folder.
fn app_id(identifier: &str) -> String {
    let dev = std::env::current_exe().is_ok_and(|exe| {
        exe.ancestors()
            .any(|dir| dir.file_name().is_some_and(|name| name == "target"))
    });
    if dev {
        DEV_APP_ID.to_owned()
    } else {
        identifier.to_owned()
    }
}

/// `text` safe inside XML text.
fn xml_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '"' => "&quot;".to_owned(),
            '\'' => "&apos;".to_owned(),
            c => c.to_string(),
        })
        .collect()
}

/// The toast's XML: a title and one line.
fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text>\
         </binding></visual><audio silent=\"true\"/></toast>",
        xml_text(title),
        xml_text(body)
    )
}

/// Shows a system notification; `on_click` runs (on a system thread) when the user clicks it.
pub(crate) fn notify(
    identifier: &str,
    title: &str,
    body: &str,
    on_click: impl Fn() + Send + Sync + 'static,
) -> std::io::Result<()> {
    show_toast(identifier, title, body, on_click).map_err(std::io::Error::other)
}

fn show_toast(
    identifier: &str,
    title: &str,
    body: &str,
    on_click: impl Fn() + Send + Sync + 'static,
) -> windows_core::Result<()> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
        move |_, _| {
            on_click();
            Ok(())
        },
    ))?;
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(identifier)))?;
    notifier.Show(&toast)?;
    *SHOWN.lock().unwrap_or_else(PoisonError::into_inner) = Some(toast);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n06_the_toast_holds_only_escaped_names() {
        let xml = toast_xml("Claude Code finished", "in <fix & \"test\">\x1b]0;x\x07");
        assert!(xml.contains("<text>Claude Code finished</text>"));
        assert!(xml.contains("<text>in &lt;fix &amp; &quot;test&quot;&gt;]0;x</text>"));
        assert!(!xml.contains('\x1b'));
    }
}
