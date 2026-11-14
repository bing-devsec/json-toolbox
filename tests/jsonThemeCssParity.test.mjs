import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

// Reviewed snapshots include IDE selected controls and the approved glass/retro capture-notice button tokens.
// Every other declaration and the full cascade comparison remain unchanged.
const baseline = JSON.parse(readFileSync(new URL('./fixtures/themeCssBeforeSharedExtraction.json', import.meta.url), 'utf8'));
const shared = readFileSync('src/themes/nonDefaultBase.css', 'utf8');
const all = 'body:is([data-interface-style="ide"], [data-interface-style="glass"], [data-interface-style="retro"], [data-interface-style="paper"])';
const subset = 'body:is([data-interface-style="ide"], [data-interface-style="paper"])';

// Project a union of equally specific attribute selectors back onto each original
// theme. Flatten declarations to compare split root rules as well as every nested
// rule/media context, preserving complete cascade order, values and !important.
function declarations(source, theme, project = false) {
    const result = [];
    postcss.parse(source).walkDecls(declaration => {
        const contexts = [];
        for (let node = declaration.parent; node && node.type !== 'root'; node = node.parent) {
            if (node.type === 'rule') {
                let selector = node.selector;
                if (project) {
                    if (selector.includes(subset) && !['ide', 'paper'].includes(theme)) return;
                    selector = selector.replaceAll(all, `body[data-interface-style="${theme}"]`)
                        .replaceAll(subset, `body[data-interface-style="${theme}"]`);
                }
                contexts.unshift(['rule', selector.replace(/\s+/g, ' ').trim()]);
            } else if (node.type === 'atrule') contexts.unshift(['at', node.name, node.params]);
        }
        result.push([contexts, declaration.prop, declaration.value, !!declaration.important]);
    });
    return result;
}
for (const [theme, original] of Object.entries(baseline)) {
    test(theme + ' preserves its reviewed ordered base/control cascade', () => {
        const base = readFileSync(`src/themes/${theme}/base.css`, 'utf8');
        const controls = readFileSync(`src/themes/${theme}/controls.css`, 'utf8');
        // Sharing the setting options intentionally adds only the field-sort dialog.
        // Keep every declaration and its cascade position checked against the baseline.
        const expectedControls = original.controls.replaceAll(
            '.el-dialog.settings-dialog-wrapper .switch-card-radio-group',
            '.el-dialog:is(.settings-dialog-wrapper, .field-sort-dialog-wrapper) .switch-card-radio-group',
        );
        assert.deepEqual(declarations(shared + base + controls, theme, true), declarations(original.base + expectedControls, theme));
        const imports = readFileSync(`src/themes/${theme}/styles.ts`, 'utf8').match(/import '[^']+';/g);
        assert.deepEqual(imports, ["import '../nonDefaultBase.css';", "import './base.css';", "import './controls.css';"]);
    });
}
test('shared foundation does not widen its selectors to the default theme', () => {
    postcss.parse(shared).walkRules(rule => assert(rule.selector.includes(all) || rule.selector.includes(subset)));
    assert(!shared.includes('[data-interface-style="default"]'));
});

test('optional theme styles remain lazy, deduplicate concurrent loads and retry after failure', async () => {
    const { transformSync } = await import('esbuild');
    const { runInNewContext } = await import('node:vm');
    const { createRetryableModuleLoader } = await import('../src/components/utils/jsonToolLoadController.ts');
    const code = transformSync(readFileSync('src/themes/styles.ts', 'utf8'), {
        loader: 'ts', format: 'cjs', supported: { 'dynamic-import': false },
    }).code;
    const imports = new Map();
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports,
        require(path) {
            if (path.includes('jsonToolLoadController')) return { createRetryableModuleLoader };
            const count = (imports.get(path) || 0) + 1;
            imports.set(path, count);
            if (path === './glass/styles' && count === 1) throw Error('temporary CSS/module failure');
            return {};
        },
    });
    const { loadThemeStyles, preloadThemeStyles } = module.exports;
    await loadThemeStyles('default');
    assert.equal(imports.size, 0);
    const first = await Promise.allSettled([loadThemeStyles('glass'), loadThemeStyles('glass')]);
    assert(first.every(result => result.status === 'rejected'));
    assert.equal(imports.get('./glass/styles'), 1);
    await loadThemeStyles('glass');
    await preloadThemeStyles();
    await preloadThemeStyles();
    assert.equal(imports.get('./glass/styles'), 2);
    for (const theme of ['ide', 'retro', 'paper']) assert.equal(imports.get(`./${theme}/styles`), 1);
});
