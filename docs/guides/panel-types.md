# Adding a panel type

> Status: Current · N-03 ([design](../design/N-03-panel-types.md), [ADR-0003](../adr/0003-panel-content-by-kind.md))

A panel type is a kind of panel the user can add from + (the Add flyout): today only Terminal. A type is registered data and components; the tab view, the saved file and the layout code know no type by name.

## 1. Its saved fields
Every panel is saved as `{ id, title, content }`; `content` holds `kind` and the type's own fields.
- **Built-in type:** add a variant to `PanelContent` in `crates/wcmd-state/src/document.rs` (a struct with `kind`, like `TerminalContent`), its `kind` in the deserializer's match, then `pnpm gen:bindings`. A new kind needs no format bump: older WolfCmds keep it as an unknown kind. A later change to its fields needs a serde default or a migration step in `migrate.rs` and a test with a file of the older format.
- **Plugin type:** nothing in the core: its content stays an `UnknownContent` there, saved as it is. Name the kind `<plugin id>.<type>`.

## 2. The type (`packages/app/src/panels/`)
```tsx
export const BOARD_TYPE: PanelType = {
  id: "acme.board",       // unique in the registry
  order: 10,
  kind: "acme.board",     // content.kind
  label: "Board",
  View: BoardPanel,       // gets PanelViewProps
  Header: BoardHeader,    // <PanelHeader {...props} look={{ title, icon }} />
  add: BOARD_ENTRY,       // what + offers
};
```
- `View` gets `PanelViewProps`: the panel, `focused`, `visible`, `settings`, `actions`, and shared callbacks keyed by panel ID. Change the saved content with `onChange(panel.id, (p) => ({ ...p, content: next }))`; a change that changes nothing must return the same object, so nothing re-renders or is saved. Keep heavy state out of React (terminals are fed through refs).
- `Header` draws the shared `PanelHeader` with a `HeaderLook` (title, icon from `GLYPHS`, optional color and folder). The user's own title is `panel.title`.
- Hidden panels (other tabs, behind a maximized one) stay mounted with `visible: false`; pause work there.

## 3. Register it
- The type: `panelTypes.register(BOARD_TYPE)` in `panels/builtin-types.ts` (or, for a plugin later, wherever it is loaded).
- Its add entry comes with it: `main.tsx` offers every registered type's `add` (`offerAddEntries`). The entry's `open(actions)` calls `actions.addPanel({ kind: "acme.board", …fields })`.

## 4. Test
- Model: what your `onChange` functions do, and that they return the same panel when nothing changes.
- `panels/TabView.test.tsx` shows how to render cards with a registry (`types` prop).
- A file with your kind and no type registered must show the placeholder card and save the content back unchanged (`model/unknown-kind.test.ts`).
