use napi::bindgen_prelude::*;
use napi::Status;

/// Convert any displayable error into a JS exception carrying a stable `code`.
pub fn to_napi_err(code: &str, message: impl std::fmt::Display) -> Error {
    let msg = message.to_string();
    let reason = format!("[{}] {}", code, msg);
    // The code is prefixed to the reason; the preload layer splits it back
    // out so JavaScript sees a normal `Error` with a `code` property.
    Error::new(Status::GenericFailure, reason)
}

pub fn io_err(context: &str, e: std::io::Error) -> Error {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        _ => "EIO",
    };
    to_napi_err(code, format!("{}: {}", context, e))
}

pub trait NapiResultExt<T> {
    fn napi_ctx(self, context: &str) -> Result<T>;
}

impl<T, E: std::fmt::Display> NapiResultExt<T> for std::result::Result<T, E> {
    fn napi_ctx(self, context: &str) -> Result<T> {
        self.map_err(|e| to_napi_err("EIO", format!("{}: {}", context, e)))
    }
}

/// Local error wrapper so internal layers can use `anyhow` freely while the
/// public `#[napi]` boundary still receives a proper JS exception.
#[derive(Debug)]
pub struct AnyError(pub anyhow::Error);

impl std::fmt::Display for AnyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AnyError {}

impl From<anyhow::Error> for AnyError {
    fn from(value: anyhow::Error) -> Self {
        AnyError(value)
    }
}

impl From<rusqlite::Error> for AnyError {
    fn from(value: rusqlite::Error) -> Self {
        AnyError(anyhow::Error::new(value))
    }
}

impl From<serde_json::Error> for AnyError {
    fn from(value: serde_json::Error) -> Self {
        AnyError(anyhow::Error::new(value))
    }
}

impl From<std::io::Error> for AnyError {
    fn from(value: std::io::Error) -> Self {
        AnyError(anyhow::Error::new(value))
    }
}

/// Bridges the internal error type onto the JS exception type.
impl From<AnyError> for Error {
    fn from(value: AnyError) -> Self {
        to_napi_err("EIO", value.0)
    }
}
