//! The native folder picker: the shell's file dialog (`IFileOpenDialog`) in folder
//! mode, the same one Explorer and Windows Terminal use.

use tauri::WebviewWindow;
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
    CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx,
};
use windows::Win32::UI::Shell::{
    FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog, IShellItem,
    SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
};
use windows_core::HSTRING;

/// Shows a folder picker owned by `window` (modal to it), opening in `start` when that
/// exists, and blocks until it closes. `Ok(None)`: the user cancelled. Never call it on the
/// UI thread: it waits for the dialog, which runs on a fresh thread of its own (with its
/// own COM apartment, so no pooled thread's COM state matters).
pub(crate) fn pick_folder(
    window: &WebviewWindow,
    title: &str,
    start: Option<&str>,
) -> std::io::Result<Option<String>> {
    // A window handle is just a number to pass along; it isn't `Send` as a pointer.
    let owner = window
        .hwnd()
        .map_err(|e| std::io::Error::other(e.to_string()))?
        .0 as usize;
    std::thread::scope(|scope| {
        scope
            .spawn(|| pick_on_this_thread(HWND(owner as *mut _), title, start))
            .join()
    })
    .map_err(|_| std::io::Error::other("the folder dialog failed"))?
}

fn pick_on_this_thread(
    owner: HWND,
    title: &str,
    start: Option<&str>,
) -> std::io::Result<Option<String>> {
    // SAFETY: initializes COM for this new thread (the shell dialog needs a single-threaded
    // apartment); it is uninitialized below only when this call initialized it.
    let initialized =
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok();
    // SAFETY: COM is initialized on this thread; `owner` is this process's live main window.
    let result = unsafe { show(owner, title, start) };
    if initialized {
        // SAFETY: balances the successful `CoInitializeEx` above, on the same thread, after
        // every COM object of this call has been released.
        unsafe { CoUninitialize() };
    }
    match result {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.code() == ERROR_CANCELLED.to_hresult() => Ok(None),
        Err(error) => Err(std::io::Error::other(error)),
    }
}

/// # Safety
/// COM must be initialized (apartment-threaded) on the calling thread.
unsafe fn show(owner: HWND, title: &str, start: Option<&str>) -> windows_core::Result<String> {
    // SAFETY: COM calls on interfaces created and used on this thread only; the strings
    // outlive the calls; the path buffer from `GetDisplayName` is freed once copied.
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
        dialog.SetTitle(&HSTRING::from(title))?;
        // A start folder that is gone is not an error: the dialog opens where it was last.
        if let Some(item) = start.and_then(|start| {
            SHCreateItemFromParsingName::<_, _, IShellItem>(
                &HSTRING::from(start),
                None::<&IBindCtx>,
            )
            .ok()
        }) {
            let _ = dialog.SetFolder(&item);
        }
        dialog.Show(Some(owner))?;
        let raw = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = String::from_utf16_lossy(raw.as_wide());
        CoTaskMemFree(Some(raw.0.cast_const().cast()));
        Ok(path)
    }
}
