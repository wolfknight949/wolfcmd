//! `tracing` to the console. `RUST_LOG` overrides the default filter.

use tracing_subscriber::{EnvFilter, fmt};

pub(crate) fn init() {
    let default = if cfg!(debug_assertions) {
        "info,wcmd_app=debug"
    } else {
        "warn,wcmd_app=info"
    };
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default));
    // A second init (e.g. in tests) is harmless, so its error is ignored.
    let _ = fmt().with_env_filter(filter).try_init();
}
