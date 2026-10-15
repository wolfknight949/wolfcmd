//! `pnpm gen:bindings`: writes the TS bindings without starting the app.

use std::path::Path;

fn main() -> anyhow::Result<()> {
    wcmd_app::export_bindings(
        &wcmd_app::specta_builder(),
        Path::new(wcmd_app::BINDINGS_PATH),
    )
}
