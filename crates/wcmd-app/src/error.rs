//! The error type every IPC command returns.

use serde::Serialize;
use specta::Type;

/// How the UI should treat an error. The UI picks the presentation by kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NotFound,
    InvalidArgument,
    PermissionDenied,
    Conflict,
    Unavailable,
    Internal,
}

/// An error crossing the IPC boundary. `message` is human-readable and safe to show.
#[derive(Debug, Clone, Serialize, Type, thiserror::Error)]
#[error("{kind:?}: {message}")]
pub struct WcmdError {
    pub kind: ErrorKind,
    pub message: String,
    /// Free-form context for "copy details"; the UI receives it as `unknown` and must narrow it.
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub details: Option<serde_json::Value>,
}

impl WcmdError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            details: None,
        }
    }

    /// An unexpected failure. It is logged here with its context; the UI shows a generic message.
    pub fn internal(context: &str, error: &dyn std::error::Error) -> Self {
        tracing::error!(%error, "{context}");
        Self::new(ErrorKind::Internal, format!("{context}: {error}"))
    }
}

impl From<tauri::Error> for WcmdError {
    fn from(error: tauri::Error) -> Self {
        Self::internal("window operation failed", &error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n01_error_serializes_with_camel_case_kind() {
        let error = WcmdError::new(ErrorKind::InvalidArgument, "bad size");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "invalidArgument", "message": "bad size", "details": null })
        );
    }
}
