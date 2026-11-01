import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { effectScope, nextTick } from 'vue';

const bundle = await build({
    entryPoints: ['src/components/composables/useToolSettings.ts'],
    bundle: true, write: false, format: 'esm', platform: 'node', external: ['vue'],
});
// Import Vue from this project's installation so the composable shares its effect scope.
const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
const { join } = await import('node:path');
const directory = await mkdtemp(join(process.cwd(), 'node_modules', '.extension-settings-test-'));
const filename = join(directory, 'settings.mjs');
await writeFile(filename, bundle.outputFiles[0].text);
const { useToolSettings } = await import(filename);
after(() => rm(directory, { recursive: true, force: true }));

async function withSettings(saved, action) {
    const previousWindow = globalThis.window;
    const previousStorage = globalThis.localStorage;
    const values = new Map(saved ? [['json-tool-settings', JSON.stringify(saved)]] : []);
    globalThis.window = {};
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const scope = effectScope();
    try {
        const settings = scope.run(() => useToolSettings());
        await action(settings, values);
    } finally {
        scope.stop();
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
}

test('fresh installs default to four-space formatting indent while explicit choices are preserved', async () => {
    await withSettings(null, async settings => {
        assert.equal(settings.indentSize.value, 4);
    });
    await withSettings({ indentSize: 2 }, async settings => {
        assert.equal(settings.indentSize.value, 2);
    });
});

test('extension update preserves valid older preferences and starts with repair disabled', async () => {
    await withSettings({
        fontSize: 14, indentSize: 4, wordWrap: false, themeMode: 'dark', sortMethod: 'length',
        buttonVisibility: { compress: false, fetchJson: true, share: true, fullscreen: true },
        defaultFullscreen: true,
    }, async (settings, values) => {
        assert.equal(settings.repairOnFormat.value, false);
        assert.equal(settings.fontSize.value, 14);
        assert.equal(settings.indentSize.value, 4);
        assert.equal(settings.wordWrap.value, false);
        assert.equal(settings.themeMode.value, 'dark');
        assert.equal(settings.sortMethod.value, 'length');
        assert.equal(settings.buttonVisibility.value.compress, false);
        settings.markInitialized();
        settings.repairOnFormat.value = true;
        await nextTick();
        const persisted = JSON.parse(values.get('json-tool-settings'));
        assert.equal(persisted.repairOnFormat, true);
        assert.equal(persisted.fontSize, 14);
        assert.equal(persisted.indentSize, 4);
        assert.equal(persisted.themeMode, 'dark');
        assert.equal(persisted.buttonVisibility.compress, false);
        for (const name of ['fetchJson', 'share', 'fullscreen']) {
            assert.equal(Object.hasOwn(persisted.buttonVisibility, name), false);
        }
        assert.equal(Object.hasOwn(persisted, 'defaultFullscreen'), false);
    });
});

test('extension restores a saved repair preference without altering unrelated settings', async () => {
    await withSettings({ repairOnFormat: true, fontSize: 13, arrayNewLine: false }, async (settings, values) => {
        assert.equal(settings.repairOnFormat.value, true);
        settings.markInitialized();
        settings.repairOnFormat.value = false;
        await nextTick();
        const persisted = JSON.parse(values.get('json-tool-settings'));
        assert.equal(persisted.repairOnFormat, false);
        assert.equal(persisted.fontSize, 13);
        assert.equal(persisted.arrayNewLine, false);
    });
});


test('extension update falls back for unsupported or damaged font sizes while preserving other preferences', async () => {
    for (const fontSize of [15, '14', -1]) {
        await withSettings({ fontSize, indentSize: 4, themeMode: 'dark' }, async (settings, values) => {
            assert.equal(settings.fontSize.value, 12);
            assert.equal(settings.indentSize.value, 4);
            assert.equal(settings.themeMode.value, 'dark');
            settings.markInitialized();
            settings.saveSettings();
            const persisted = JSON.parse(values.get('json-tool-settings'));
            assert.equal(persisted.fontSize, 12);
            assert.equal(persisted.indentSize, 4);
            assert.equal(persisted.themeMode, 'dark');
        });
    }
});

test('new appearance setting defaults safely for older and corrupt records', async () => {
    for (const interfaceStyle of [undefined, null, 'terminal', {}, 42]) {
        await withSettings({ interfaceStyle, themeMode: 'dark', fontSize: 14 }, async (settings, values) => {
            assert.equal(settings.interfaceStyle.value, 'default');
            assert.equal(settings.themeMode.value, 'dark');
            settings.markInitialized();
            settings.saveSettings();
            assert.equal(JSON.parse(values.get('json-tool-settings')).interfaceStyle, 'default');
        });
    }
});

test('all interface styles persist independently of color mode and processing preferences', async () => {
    for (const style of ['default', 'ide', 'glass', 'retro', 'paper']) {
        await withSettings({ interfaceStyle: style, themeMode: 'dark', fontSize: 14, repairOnFormat: true }, async (settings, values) => {
            assert.equal(settings.interfaceStyle.value, style);
            settings.markInitialized();
            settings.themeMode.value = 'light';
            await nextTick();
            let saved = JSON.parse(values.get('json-tool-settings'));
            assert.equal(saved.interfaceStyle, style);
            assert.equal(saved.fontSize, 14);
            assert.equal(saved.repairOnFormat, true);
            settings.interfaceStyle.value = 'paper';
            await nextTick();
            saved = JSON.parse(values.get('json-tool-settings'));
            assert.equal(saved.interfaceStyle, 'paper');
            assert.equal(saved.themeMode, 'light');
        });
    }
});
