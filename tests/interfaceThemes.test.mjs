import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
const bundle = await build({ stdin: { contents: `export * from './src/themes/interfaceThemes'; export * from './src/themes/paperTokens'; export * from './src/themes/ideTokens'; export * from './src/components/utils/monacoThemes';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs' });
const module = { exports: {} };
const document = { body: { dataset: {} } };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, document });
const api = module.exports;

test('style palettes have readable primary text and leave original theme untouched', () => {
    assert.deepEqual(Object.keys(api.getInterfaceVariables('default', 'dark')), []);
    const luminance = hex => {
        const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    for (const style of ['ide', 'glass', 'retro', 'paper']) for (const mode of ['light', 'dark']) {
        const p = api.getInterfacePalette(style, mode);
        const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
        assert.ok(contrast(p.text, p.editor) >= 4.5, `${style}/${mode} editor contrast`);
        assert.ok(contrast(p.muted, p.surface) >= 4.5, `${style}/${mode} secondary text contrast`);
    }
});

test('all style/mode/language combinations resolve to registered editor themes', () => {
    const registered = new Map();
    api.defineJsonToolMonacoThemes({ editor: { defineTheme: (name, value) => registered.set(name, value) } });
    for (const style of ['default', 'ide', 'glass', 'retro', 'paper']) for (const mode of ['light', 'dark']) for (const language of ['json', 'toml', 'yaml', 'plaintext']) {
        document.body.dataset.interfaceStyle = style;
        const name = api.getJsonToolThemeForLanguage(language, mode);
        assert.ok(registered.has(name), `${style}/${mode}/${language}`);
        if (style !== 'default') assert.equal(registered.get(name).colors['editor.background'], api.getInterfacePalette(style, mode).editor);
    }
    document.body.dataset.interfaceStyle = 'unknown';
    assert.equal(api.getJsonToolThemeForLanguage('json', 'light'), api.JSON_TOOL_LIGHT_THEME);
});


function contrastRatio(a, b) {
    const luminance = hex => {
        const [r, g, b] = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return .2126 * r + .7152 * g + .0722 * b;
    };
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

test('paper control text and focus meet contrast targets in every enabled state and mode', () => {
    for (const mode of ['light', 'dark']) {
        const t = api.paperControls[mode];
        const p = api.getInterfacePalette('paper', mode);
        for (const role of ['neutral', 'secondary', 'primary', 'danger']) {
            const c = t[role];
            for (const prefix of ['', 'hover', 'active']) {
                const bg = prefix ? c[prefix + 'Background'] : c.background;
                const fg = prefix ? c[prefix + 'Foreground'] : c.foreground;
                assert.ok(contrastRatio(bg, fg) >= 4.5, `${mode}/${role}/${prefix || 'normal'} text`);
            }
            assert.ok(contrastRatio(c.border, p.surface) >= 3, `${mode}/${role} boundary`);
        }
        assert.ok(contrastRatio(t.focus, p.surface) >= 3, `${mode} focus`);
        assert.ok(contrastRatio(t.selectedForeground, t.selectedBackground) >= 4.5, `${mode} selected text`);
        for (const name of ['success', 'warning']) assert.ok(contrastRatio(t[name], t[name + 'Background']) >= 4.5, `${mode}/${name} feedback`);
    }
});

test('paper controls retain roles when serialized into theme variables, without leaking into other styles', () => {
    for (const mode of ['light', 'dark']) {
        const variables = api.getInterfaceVariables('paper', mode);
        for (const role of ['neutral', 'secondary', 'primary', 'danger']) {
            assert.equal(variables[`--paper-${role}-foreground`], api.paperControls[mode][role].foreground);
            assert.equal(variables[`--paper-${role}-active-background`], api.paperControls[mode][role].activeBackground);
        }
        assert.equal(variables['--json-tool-transfer-fg'], api.paperControls[mode].secondary.foreground);
        for (const style of ['default', 'ide', 'glass', 'retro']) {
            assert.equal(Object.keys(api.getInterfaceVariables(style, mode)).some(key => key.startsWith('--paper-')), false);
        }
    }
});

test('paper component styles consume semantic tokens instead of introducing independent colors', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile('src/themes/paperControls.css', 'utf8');
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css), false, 'paper color values belong in paperTokens.ts');
});


test('IDE workbench roles remain readable in both modes, including primary and selected states', () => {
    for (const mode of ['light', 'dark']) {
        const p = api.getInterfacePalette('ide', mode), c = api.ideControls[mode];
        for (const bg of [c.button, c.hover, c.pressed, c.input]) assert.ok(contrastRatio(p.text, bg) >= 4.5, `${mode} neutral control text`);
        for (const bg of [p.accent, c.primaryHover, c.primaryPressed]) assert.ok(contrastRatio(c.onPrimary, bg) >= 4.5, `${mode} primary action text`);
        assert.ok(contrastRatio(c.onSelected, p.selected) >= 4.5, `${mode} selected menu text`);
        assert.ok(contrastRatio(c.link, p.soft) >= 4.5, `${mode} help heading`);
        assert.ok(contrastRatio(c.danger, c.button) >= 4.5, `${mode} danger action text`);
        assert.ok(contrastRatio(c.controlBorder, c.input) >= 3, `${mode} input boundary`);
    }
});

test('semantic control routing isolates IDE and paper from legacy overrides without changing theme IDs', () => {
    assert.deepEqual(Array.from(api.interfaceStyles, item => item.id), ['default', 'ide', 'glass', 'retro', 'paper']);
    for (const style of ['default', 'ide', 'glass', 'retro', 'paper']) {
        assert.equal(api.getInterfaceControlSystem(style), style === 'ide' || style === 'paper' ? 'semantic' : 'legacy');
        for (const mode of ['light', 'dark']) {
            const variables = api.getInterfaceVariables(style, mode);
            assert.equal(Object.keys(variables).some(key => key.startsWith('--ide-')), style === 'ide');
        }
    }
});
