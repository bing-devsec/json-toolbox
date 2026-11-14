# First-use walkthrough: Monaco SVG scope review

Reviewed on 2026-11-14 for the optional first-use walkthrough and sorting-example UI.

- Both projects retain the existing static import closure: **626 modules, 80 icon IDs, 52 SVG glyphs**.
- A fresh collectMonacoIconScope result exactly matches all six enforced inventory fields: files (including source hashes), glyphCodepoints, ids, dynamicImports, skippedWorkerImports and unresolvedIds. Missing imports remain empty.
- The walkthrough opens the existing editor.action.showContextMenu action. Its contextmenu contribution and menu rendering were already present in the reviewed closure. No Monaco contribution or icon dependency was added.
- The new welcome/walkthrough components use Element Plus controls and inline SVG; they do not introduce Codicon references, icon labels, ThemeIcon consumers or arbitrary Monaco icon rendering.
- New i18n strings describe the sorting examples; they contain no Monaco icon interpolation. Existing context-menu labels and registrations are unchanged.
- Temporary demo models and cursor/view operations reuse the installed editor API. They do not change icon reachability.
- Only applicationFiles hashes for the workbench and utils/i18n.ts are refreshed. The eight-file application boundary, adapter digest, module inventory, SVG source and production bundle gate remain unchanged.

The initial workbench review also found hideSuggestWidget and closeParameterHints calls. Their contributions are not included in this product and those calls do not dismiss the context menu. They do not justify adding either contribution; lifecycle cleanup is handled separately by the main implementation.

Validation: run tests/monacoSvgScope.test.mjs and tests/monacoSvg.test.mjs with each project's existing test loader. These tests retain their rejection checks for modified application sources, missing glyph coverage and newly bundled Monaco UI modules.

Result: both projects passed all 10 targeted Monaco SVG tests (20 total), including the production CSS fixture build and the negative scope/bundle checks. No full application build was run for this audit.
