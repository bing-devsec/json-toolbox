# Theme architecture

Every appearance style is an isolated, self-contained module. Themes never import or style each other.

## Runtime

- `ids.ts`: the fixed id list and persistence normalization. It contains no colors.
- `contract.ts`: shared types (Palette, ThemeDefinition). It contains no values.
- `registry.ts`: ordered definitions and variable dispatch. It contains no colors or rules.
- `useInterfaceTheme.ts`: applies the variables a theme returns, sets `body[data-interface-style]`, and restores them on unmount.
- `early.ts`: applies the stored theme before the app mounts, so the skeleton and load states already use the right surface. `main.ts` calls it once. `loadJsonToolWorkbench` waits for the saved theme stylesheet before rendering.
- Components consume a stable semantic variable contract (`--json-tool-*`, `--el-*`, `--theme-*`). The contract is the only shared visual boundary.

## Isolation rules

1. A theme lives in `src/themes/<id>/` and owns `index.ts`, its CSS, its Monaco colors and its preview swatch.
2. Every CSS selector (except `.swatch-<id>` previews) must be scoped by `body[data-interface-style="<id>"]`.
3. A theme may not reference another theme's id, token prefix (`--ide-`, `--paper-`, `--glass-`, `--retro-`) or files.
4. Colors and material values live in the theme's TypeScript tokens, not in CSS literals. The only exception is the static preview swatch.
5. The legacy dark rules in Workbench/dialogs belong to `default` and are scoped by `body[data-interface-style="default"]`. New themes must style dark mode themselves.
6. Changing one theme must never require editing another theme's files.

## Adding a style

1. Create `src/themes/<id>/index.ts` returning `ThemeDefinition` with `palettes` and `getVariables(mode)`.
2. Add `base.css`, `controls.css` and `swatch.css`; scope every selector to the new id.
3. Ensure every variable in the contract is provided in both modes; `tests/interfaceThemes.test.mjs` enforces it.
4. Add a Monaco palette (gutter, current line, selection) and the preview swatch.
5. Register the definition in `registry.ts` and the id in `ids.ts`.

## Verification

`npm run typecheck`, `npm test`, `npm run build`; then load `dist/` and walk light/dark through toolbar, folding, settings, masking, sort/demo, Diff and feedback.

Current status: all five styles are isolated. `default`, `ide` and `paper` are migrated; `glass` (soft-focus glass) and `retro` (2010 desktop client + portal content) are implemented as first versions and still being refined against browser screenshots.

Each implemented theme folder contains `tokens.ts` (palettes, control roles, material strings), `base.css` (material and surface rules), `controls.css` (component states) and `swatch.css` (preview). `styles.ts` dispatches cached, retryable stylesheet imports; it contains no visual rules. Each theme owns a `styles.ts` entry for its base and controls. Only the saved theme loads at startup; opening Settings prepares all themes before switching becomes available. Preview swatches belong to AppearanceSettings and load with that dialog.
