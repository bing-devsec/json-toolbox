import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
    stdin: {
        contents: `export * from './src/themes/registry';
export * from './src/themes/ids';
export * from './src/themes/ide/index.ts';
export * from './src/themes/paper/index.ts';
export * from './src/components/utils/monacoThemes';`,
        resolveDir: process.cwd(),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    loader: { '.css': 'empty' },
});
const module = { exports: {} };
const document = { body: { dataset: {} } };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, document });
const api = module.exports;

const STYLE_IDS = ['default', 'ide', 'glass', 'retro', 'paper'];
const NON_DEFAULT = STYLE_IDS.filter(id => id !== 'default');
const REQUIRED_VARIABLES = [
    '--json-tool-bg', '--json-tool-surface', '--json-tool-surface-soft', '--json-tool-surface-raised',
    '--json-tool-surface-header', '--json-tool-surface-status', '--json-tool-border', '--json-tool-border-strong',
    '--json-tool-toolbar-border', '--json-tool-text', '--json-tool-text-muted', '--json-tool-gutter-bg',
    '--json-tool-editor-bg', '--json-tool-current-line', '--json-tool-shadow',
    '--json-tool-archive-hover', '--json-tool-archive-active', '--json-tool-archive-active-hover',
    '--json-tool-archive-drag', '--json-tool-archive-scrollbar', '--json-tool-archive-scrollbar-hover',
    '--json-tool-button-bg', '--json-tool-button-border', '--json-tool-button-text',
    '--json-tool-button-hover-bg', '--json-tool-button-hover-border',
    '--json-tool-input-bg', '--json-tool-input-border', '--json-tool-input-hover-border',
    '--json-tool-transfer-bg', '--json-tool-transfer-fg', '--json-tool-resizer-grip',
    '--json-tool-diff-center-bg', '--json-tool-diff-center-border', '--json-tool-diff-nav-bg',
    '--json-tool-diff-nav-border', '--json-tool-diff-nav-divider', '--json-tool-diff-nav-text',
    '--json-tool-diff-nav-status-bg', '--json-tool-diff-nav-action-hover', '--json-tool-diff-nav-action-active',
    '--json-tool-diff-nav-action-disabled', '--json-tool-diff-sync-btn-color',
    '--json-tool-diff-sync-btn-hover-color', '--json-tool-diff-sync-btn-active-color',
    '--theme-accent', '--theme-selected', '--theme-radius', '--theme-header', '--theme-on-accent',
    '--theme-danger', '--theme-success', '--theme-warning',
    '--toolbar-hover-bg', '--toolbar-hover-fg', '--toolbar-active-bg', '--toolbar-active-fg',
    '--toolbar-hover-shadow', '--toolbar-active-shadow',
    '--toolbar-primary-hover-bg', '--toolbar-primary-hover-fg',
    '--toolbar-primary-active-bg', '--toolbar-primary-active-fg',
    '--toolbar-primary-hover-shadow', '--toolbar-primary-active-shadow',
    '--toolbar-active-transform', '--toolbar-border', '--toolbar-divider', '--toolbar-primary-border',
    '--el-color-primary', '--el-color-primary-light-3', '--el-color-primary-light-5',
    '--el-color-primary-light-7', '--el-color-primary-light-8', '--el-color-primary-light-9',
    '--el-color-danger', '--el-color-success', '--el-color-warning',
    '--el-color-danger-light-9', '--el-color-success-light-9', '--el-color-warning-light-9',
    '--el-button-divide-border-color', '--el-bg-color', '--el-bg-color-overlay', '--el-fill-color-blank',
    '--el-fill-color', '--el-fill-color-light', '--el-fill-color-lighter',
    '--el-text-color-primary', '--el-text-color-regular', '--el-text-color-secondary',
    '--el-border-color', '--el-border-color-light', '--el-border-color-lighter',
    '--el-border-radius-base', '--el-box-shadow-light',
];

const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
        .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
};
const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};

test('catalog order is fixed and the default theme owns no variables', () => {
    assert.deepEqual(Array.from(api.interfaceStyles, item => item.id), STYLE_IDS);
    assert.deepEqual(Object.keys(api.getInterfaceVariables('default', 'light')), []);
    assert.deepEqual(Object.keys(api.getInterfaceVariables('default', 'dark')), []);
    assert.equal(api.getInterfacePalette('default', 'light'), null);
});

test('every non-default theme provides the full contract in both modes', () => {
    for (const style of NON_DEFAULT) for (const mode of ['light', 'dark']) {
        const variables = api.getInterfaceVariables(style, mode);
        for (const name of REQUIRED_VARIABLES) {
            assert.ok(name in variables, `${style}/${mode} missing ${name}`);
        }
        assert.match(variables['--theme-radius'], /^[0-9.]+(?:px|rem)$/);
        assert.ok(variables['--el-border-radius-base']);
    }
});

test('theme palettes keep readable text and measurable control boundaries', () => {
    for (const style of NON_DEFAULT) for (const mode of ['light', 'dark']) {
        const p = api.getInterfacePalette(style, mode);
        const v = api.getInterfaceVariables(style, mode);
        assert.ok(contrast(p.text, p.editor) >= 4.5, `${style}/${mode} editor text`);
        assert.ok(contrast(p.muted, p.surface) >= 4.5, `${style}/${mode} secondary text`);
        assert.ok(contrast(v['--theme-on-accent'], p.accent) >= 4.5, `${style}/${mode} on accent`);
        assert.ok(contrast(v['--json-tool-border-strong'], p.surface) >= 3, `${style}/${mode} strong border`);
        assert.ok(contrast(v['--json-tool-transfer-fg'], p.surface) >= 4.5, `${style}/${mode} transfer glyph`);
        assert.ok(contrast(v['--theme-success'], p.surface) >= 3, `${style}/${mode} feedback`);
    }
});

test('all style/mode/language combinations resolve to registered editor themes', () => {
    const registered = new Map();
    api.defineJsonToolMonacoThemes({ editor: { defineTheme: (name, value) => registered.set(name, value) } });
    for (const style of STYLE_IDS) for (const mode of ['light', 'dark']) for (const language of ['json', 'toml', 'yaml', 'plaintext']) {
        document.body.dataset.interfaceStyle = style;
        const name = api.getJsonToolThemeForLanguage(language, mode);
        assert.ok(registered.has(name), `${style}/${mode}/${language}`);
        if (style === 'default') continue;
        const theme = registered.get(name);
        const p = api.getInterfacePalette(style, mode);
        assert.equal(theme.colors['editor.background'], p.editor);
        for (const key of ['editor.foreground', 'editorGutter.background', 'editorLineNumber.foreground',
            'editorCursor.foreground', 'editor.lineHighlightBackground', 'editor.selectionBackground']) {
            assert.ok(theme.colors[key], `${style}/${mode}/${language} missing ${key}`);
        }
    }
    document.body.dataset.interfaceStyle = 'unknown';
    assert.equal(api.getJsonToolThemeForLanguage('json', 'light'), api.JSON_TOOL_LIGHT_THEME);
});

test('each theme folder is self-contained and does not reference another theme', async () => {
    const themeRoot = path.join(process.cwd(), 'src/themes');
    const tokenPrefixes = { ide: '--ide-', paper: '--paper-', glass: '--glass-', retro: '--retro-' };
    for (const style of NON_DEFAULT) {
        const directory = path.join(themeRoot, style);
        const files = (await readdir(directory)).filter(name => name.endsWith('.css') || name.endsWith('.ts'));
        const sources = await Promise.all(files.map(async name => [name, await readFile(path.join(directory, name), 'utf8')]));
        for (const [name, source] of sources) {
            for (const other of NON_DEFAULT.filter(id => id !== style)) {
                assert.equal(source.includes(`data-interface-style="${other}"`), false, `${style}/${name} references ${other}`);
                assert.equal(source.includes(tokenPrefixes[other]), false, `${style}/${name} uses ${other} tokens`);
                assert.equal(new RegExp(`from '../${other}(?:/|')`).test(source), false, `${style}/${name} imports ${other}`);
            }
            if (name.endsWith('.css') && name !== 'swatch.css') {
                assert.ok(source.includes(`body[data-interface-style="${style}"]`), `${style}/${name} is not scoped to its theme`);
                assert.equal(/:not\(\[data-interface-style=/.test(source), false, `${style}/${name} uses a blanket selector`);
            }
            if (name === 'swatch.css') assert.ok(source.includes(`.swatch-${style}`), `${style} swatch missing`);
        }
    }
});

test('legacy dark rules are owned by the default theme only', async () => {
    const files = [
        'src/components/JsonToolWorkbench.vue',
        'src/components/SettingsDialog.vue',
        'src/components/DataMaskingDialog.vue',
        'src/components/JsonSortFeature.vue',
        'src/components/JsonToolDiffPane.vue',
    ];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        assert.equal(source.includes('data-theme-controls'), false, `${file} still gates on data-theme-controls`);
        assert.equal(/(^|\n)\.json-tool-root\.theme-dark/.test(source), false, `${file} has an unscoped legacy root rule`);
    }
    const workbench = await readFile('src/components/JsonToolWorkbench.vue', 'utf8');
    assert.equal(workbench.includes('interfaceThemes'), false, 'workbench still imports the old shared layer');
    assert.equal(workbench.includes("themes/paperControls.css") || workbench.includes("themes/ideControls.css"), false);
});

test('theme styles keep colors in their own tokens', async () => {
    for (const file of [
        'src/themes/paper/controls.css',
        'src/themes/glass/base.css',
        'src/themes/glass/controls.css',
        'src/themes/retro/base.css',
        'src/themes/retro/controls.css',
    ]) {
        const css = await readFile(file, 'utf8');
        assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css), false, `${file} must consume tokens`);
    }
});

test('every theme stylesheet is loaded exactly once by styles.ts', async () => {
    const styles = await readFile('src/themes/styles.ts', 'utf8');
    for (const style of NON_DEFAULT) {
        const directory = path.join(process.cwd(), 'src/themes', style);
        const cssFiles = (await readdir(directory)).filter(name => name.endsWith('.css'));
        assert.ok(cssFiles.length > 0, `${style} has no stylesheet`);
        for (const name of cssFiles) {
            const specifier = `./${style}/${name}`;
            assert.equal(styles.split(`'${specifier}'`).length - 1, 1, `${specifier} must be imported once`);
        }
    }
});
