import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import * as vue from 'vue';

const bundle = await build({
    stdin: { contents: `
        export { useToolSettings } from './src/components/composables/useToolSettings';
        export { useJsonToolSettingsDialog } from './src/components/composables/useJsonToolSettingsDialog';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vue'],
});
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function fixture(initial, userAgent = MAC, blocked = false) {
    let stored = initial === undefined ? null : typeof initial === 'string' ? initial : JSON.stringify(initial);
    let writes = 0;
    const module = { exports: {} };
    const localStorage = {
        getItem(key) { assert.equal(key, 'json-tool-settings'); if (blocked) throw new Error('blocked'); return stored; },
        setItem(key, value) { assert.equal(key, 'json-tool-settings'); if (blocked) throw new Error('blocked'); stored = value; writes++; },
    };
    runInNewContext(bundle.outputFiles[0].text, {
        module, exports: module.exports, window: {}, navigator: { userAgent, maxTouchPoints: 0 }, localStorage,
        require(name) { assert.equal(name, 'vue'); return vue; },
    });
    const scope = vue.effectScope();
    const settings = scope.run(() => module.exports.useToolSettings());
    return { settings, api: module.exports, scope, saved: () => stored && JSON.parse(stored), writes: () => writes };
}

async function withFixture(initial, userAgent, run) {
    const f = fixture(initial, userAgent);
    try { await run(f); } finally { f.scope.stop(); }
}

test('fresh settings use the same fixed manual default on every platform and do not write during initialization', async () => {
    for (const platform of [MAC, WINDOWS, '']) {
        await withFixture(undefined, platform, async f => {
            assert.equal(f.settings.fontSize.value, 12);
            f.settings.saveSettings();
            await vue.nextTick();
            assert.equal(f.writes(), 0);
            f.settings.markInitialized();
            f.settings.saveSettings();
            assert.equal(f.saved().fontSize, 12);
            assert.equal(Object.hasOwn(f.saved(), 'fontSizePreference'), false);
        });
    }
});

test('changing another preference preserves saved font sizes and unrelated options', async () => {
    for (const platform of [MAC, WINDOWS]) for (const size of [12, 13, 14]) {
        await withFixture({ fontSize: size, indentSize: 4, repairOnFormat: true, buttonVisibility: { archive: false } }, platform, async f => {
            assert.equal(f.settings.fontSize.value, size);
            f.settings.markInitialized();
            f.settings.themeMode.value = 'dark';
            await vue.nextTick();
            const saved = f.saved();
            assert.equal(saved.fontSize, size);
            assert.equal(saved.indentSize, 4);
            assert.equal(saved.repairOnFormat, true);
            assert.equal(saved.buttonVisibility.archive, false);
            assert.equal(saved.buttonVisibility.compress, true);
        });
    }
});

test('obsolete preference records retain their last numeric size and are discarded when settings are saved', async () => {
    // The removed version stored this extra key alongside its actual numeric size.
    for (const platform of [MAC, WINDOWS]) for (const fontSize of [13, 14]) {
        for (const obsoletePreference of ['auto', 12]) {
            await withFixture({ fontSizePreference: obsoletePreference, fontSize }, platform, async f => {
                assert.equal(f.settings.fontSize.value, fontSize);
                assert.equal(Object.hasOwn(f.settings, 'fontSizePreference'), false);
                f.settings.markInitialized();
                f.settings.saveSettings();
                assert.equal(f.saved().fontSize, fontSize);
                assert.equal(Object.hasOwn(f.saved(), 'fontSizePreference'), false);
            });
        }
    }
});

test('manual size changes persist and reload without consulting the platform', async () => {
    await withFixture({ fontSize: 12 }, MAC, async f => {
        f.settings.markInitialized();
        for (const size of [13, 14, 12]) {
            f.settings.fontSize.value = size;
            await vue.nextTick();
            assert.equal(f.saved().fontSize, size);
            await withFixture(f.saved(), WINDOWS, async reloaded => assert.equal(reloaded.settings.fontSize.value, size));
        }
        assert.equal(f.writes(), 3);
    });
});

test('damaged font settings use the fixed fallback rather than an obsolete preference', async () => {
    for (const value of ['{broken', 'null', '[]', '"text"', { fontSize: '14' }, { fontSize: null, fontSizePreference: 13 }, { fontSize: 15 }]) {
        for (const platform of [MAC, WINDOWS]) {
            await withFixture(value, platform, async f => assert.equal(f.settings.fontSize.value, 12));
        }
    }
});

test('unavailable browser storage does not prevent changing the manual font size', async () => {
    const f = fixture(undefined, MAC, true);
    try {
        assert.equal(f.settings.fontSize.value, 12);
        f.settings.markInitialized();
        f.settings.fontSize.value = 14;
        await vue.nextTick();
        assert.equal(f.settings.fontSize.value, 14);
        assert.doesNotThrow(() => f.settings.saveSettings());
    } finally { f.scope.stop(); }
});

test('manual size changes update both normal editors, Diff options and layout with matching line height', async () => {
    await withFixture(undefined, MAC, async f => {
        const normal = [[], []], diff = [], layout = { normal: 0, diff: 0, recompute: 0 };
        const settings = f.settings;
        const dialog = f.scope.run(() => f.api.useJsonToolSettingsDialog({
            wordWrap: settings.wordWrap, fontSize: settings.fontSize, indentSize: settings.indentSize,
            arrayNewLine: settings.arrayNewLine, showMinimap: settings.showMinimap, stickyScroll: settings.stickyScroll,
            enableDiagnostics: settings.enableDiagnostics, preferredStickyScroll: settings.preferredStickyScroll,
            preferredEnableDiagnostics: settings.preferredEnableDiagnostics, buttonVisibility: settings.buttonVisibility,
            selectedLevel: vue.ref(0), isDiffMode: vue.ref(false),
            getInputEditor: () => ({ updateOptions: value => normal[0].push(value), getValue: () => '' }),
            getOutputEditor: () => ({ updateOptions: value => normal[1].push(value) }),
            updateDiffEditorOptions: value => diff.push(value),
            updateEditorLayout: () => layout.normal++, scheduleDiffEditorLayout: () => layout.diff++,
            scheduleDiffRecompute: () => layout.recompute++, configureJsonSchemaSupport() {},
            refreshInputEditorErrors() {}, checkToolBarScroll() {},
        }));
        for (const [fontSize, lineHeight] of [[14, 20], [12, 17], [13, 18]]) {
            settings.fontSize.value = fontSize;
            dialog.updateFontSize(); await vue.nextTick();
            for (const options of [normal[0].at(-1), normal[1].at(-1), diff.at(-1)]) {
                assert.equal(options.fontSize, fontSize);
                assert.equal(options.lineHeight, lineHeight);
                assert.equal(options.fontWeight, 'normal');
                assert.equal(options.fontLigatures, false);
            }
        }
        assert.deepEqual(layout, { normal: 3, diff: 3, recompute: 3 });
    });
});


test('local extension settings keep supported fields and discard website-only or obsolete preferences', async () => {
    await withFixture({
        fontSize: 14, fontSizePreference: 'auto', defaultFullscreen: true, isFullscreen: true,
        buttonVisibility: { archive: false, share: true, fetchJson: true, fullscreen: true, compress: 'false' },
    }, MAC, async f => {
        assert.equal(f.settings.fontSize.value, 14);
        assert.equal(f.settings.buttonVisibility.value.archive, false);
        assert.equal(f.settings.buttonVisibility.value.compress, true);
        for (const key of ['share', 'fetchJson', 'fullscreen']) assert.equal(Object.hasOwn(f.settings.buttonVisibility.value, key), false);
        f.settings.markInitialized();
        f.settings.saveSettings();
        const saved = f.saved();
        for (const key of ['fontSizePreference', 'defaultFullscreen', 'isFullscreen']) assert.equal(Object.hasOwn(saved, key), false);
        for (const key of ['share', 'fetchJson', 'fullscreen']) assert.equal(Object.hasOwn(saved.buttonVisibility, key), false);
    });
});

test('malformed saved button maps fall back to supported local button defaults', async () => {
    for (const buttonVisibility of [null, [], ['archive'], 'text', 14, true]) {
        await withFixture({ fontSize: 13, buttonVisibility }, MAC, async f => {
            assert.equal(f.settings.fontSize.value, 13);
            assert.equal(f.settings.buttonVisibility.value.archive, true);
            assert.equal(f.settings.buttonVisibility.value.compress, true);
            assert.equal(Object.hasOwn(f.settings.buttonVisibility.value, '0'), false);
        });
    }
});
