# WolfCmd branding — H / Ear bracket

The WolfCmd mark as clean vectors: wolf ears and a command chevron.

## Files

- `mark/wolfcmd.svg`: scalable transparent mark, blue-violet `#9aa3f2`.
- `mark/{size}x{size}.png`: transparent PNGs at 16, 20, 24, 32, 48, 64, 128, 256, 512 and 1024 px.
- `app-icon/wolfcmd-app.svg`: mark on a dark `#191816` rounded tile.
- `app-icon/{size}x{size}.png`: matching app icons at the same sizes.
- `platforms/windows/`: multi-resolution ICO and generated StoreLogo / Square logos.
- `platforms/macos/icon.icns`: macOS icon container.

Use the SVG for large artwork and future exports. Use the transparent mark in headers; use the dark tile for desktop shortcuts and app listings. Platform resources are artwork for future packaging; a store submission may require additional sizes, backgrounds, screenshots and metadata.

## App integration and regeneration

The header and browser favicon use `packages/app/public/wolfcmd.svg`. Desktop and installer icons come from `crates/wcmd-app/icons/icon-source.svg`. Keep the paths in these two SVGs and the copies here aligned when changing the design.

From the repository root, regenerate desktop and platform icons with:

```powershell
pnpm tauri icon icons/icon-source.svg
```

Generate custom transparent exports with:

```powershell
pnpm tauri icon ../../packages/app/public/wolfcmd.svg --output ../../assets/branding/wolfcmd/mark --png 16 --png 20 --png 24 --png 32 --png 48 --png 64 --png 128 --png 256 --png 512 --png 1024
```

The Tauri script runs from `crates/wcmd-app`; its paths are relative to that directory. An installed app picks up the new native icon after rebuilding and installing it.
