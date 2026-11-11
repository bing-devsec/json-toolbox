import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'vite';
import { monacoSvgPlugin, patchMonacoSvg, svgPseudoCSS } from '../scripts/vite/monaco-svg.mjs';
import 'monaco-editor/esm/vs/base/common/codicons.js';
import { getCodiconFontCharacters } from 'monaco-editor/esm/vs/base/common/codiconsUtil.js';

const root = path.resolve('node_modules/monaco-editor/esm/vs');
const scope = JSON.parse(fs.readFileSync('reports/monaco-svg-scope.json', 'utf8'));
const scopeCodes = new Set(scope.glyphCodepoints.map(cp => parseInt(cp, 16)));

const svgCSS = fs.readFileSync('assets/icons/codicon-0.52.2.svg.css', 'utf8');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const patch = name => patchMonacoSvg(read(name), path.join(root, name), svgCSS);
const styleFile = 'platform/theme/browser/iconsStyleSheet.js';

test('scoped SVG data covers every reviewed product codepoint without unused glyphs', () => {
    const matches = [...svgCSS.matchAll(/--json-codicon-([a-f0-9]+):url\("data:image\/svg\+xml,([^"\n]+)"\)/g)];
    assert.equal(matches.length, 52);
    const cps = new Set(matches.map(m => parseInt(m[1], 16)));
    assert.deepEqual(cps, scopeCodes);
    for (const [id, cp] of Object.entries(getCodiconFontCharacters())) if (scope.ids.includes(id)) assert.ok(cps.has(cp), id);
    for (const [, , encoded] of matches) {
        const svg = decodeURIComponent(encoded);
        assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 300 300"><path d="/);
        assert.doesNotMatch(svg, /<script|<image|href=|style=|foreignObject|onload=/i);
    }
});

test('runtime icon aliases and custom font definitions retain their contracts', () => {
    const entries = [
        { id: 'chevron-down', defaults: { fontCharacter: '\\eab4' } },
        { id: 'folding-expanded', defaults: { id: 'chevron-down' } },
        { id: 'custom-test', defaults: { fontCharacter: 'A', font: { id: 'custom-font', definition: { src: [{ location: 'font.woff2', format: 'woff2' }] } } } },
    ];
    const registry = { getIcons: () => entries, getIcon: id => entries.find(e => e.id === id), onDidChange: () => ({ dispose() {} }) };
    class Emitter { event = () => {}; fire() {} dispose() {} }
    class DisposableStore { add(value) { return value; } dispose() {} }
    const source = patch(styleFile).replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nglobalThis.sheet = getIconsStyleSheet();';
    const context = { Emitter, DisposableStore, getIconRegistry: () => registry,
        ThemeIcon: { isThemeIcon: d => !!d?.id }, asCSSPropertyValue: v => v, asCSSUrl: v => `url(${v})` };
    vm.runInNewContext(source, context);
    const css = context.sheet.getCSS();
    assert.match(css, /\.codicon-folding-expanded:before \{ content: ''; --json-codicon-mask: var\(--json-codicon-eab4\); \}/);
    assert.match(css, /--vscode-icon-folding-expanded-mask: var\(--json-codicon-eab4\)/);
    assert.match(css, /\.codicon-custom-test:before \{ content: 'A'; font-family: custom-font; width: auto; height: auto; background: none; -webkit-mask: none; mask: none;/);
    assert.match(css, /@font-face.*custom-font/);
    context.sheet.dispose();
});

test('shadow menus receive the same SVG presentation and keep distinct menu glyphs', () => {
    const menu = patch('base/browser/ui/menu/menu.js');
    const context = patch('base/browser/ui/contextview/contextview.js');
    assert.ok(context.includes(svgPseudoCSS));
    assert.doesNotMatch(context, /16px\/1 codicon/);
    const functionSource = menu.match(/export function formatRule\(c\) \{[\s\S]+?\n\}/)[0].replace('export ', '');
    const scope = { getCodiconFontCharacters };
    vm.runInNewContext(functionSource + '\nglobalThis.rule = formatRule;', scope);
    for (const id of ['menu-selection', 'menu-submenu']) {
        assert.match(scope.rule({ id }), /content: ''; --json-codicon-mask: var\(--json-codicon-[a-f0-9]+\)/);
    }
});

test('direct icon-content CSS gets SVG masking without changing animation and hidden-state CSS', () => {
    const name = 'editor/contrib/inlineProgress/browser/inlineProgressWidget.css';
    assert.match(patch(name), /mask: var\(--vscode-icon-x-mask\)/);
    assert.equal(patchMonacoSvg(read('base/browser/ui/codicons/codicon/codicon-modifiers.css'), path.join(root, 'base/browser/ui/codicons/codicon/codicon-modifiers.css'), svgCSS), null);
    assert.equal(patchMonacoSvg(read('base/browser/ui/toggle/toggle.css'), path.join(root, 'base/browser/ui/toggle/toggle.css'), svgCSS), null);
    assert.match(svgPseudoCSS, /width: 1em/);
    assert.doesNotMatch(svgPseudoCSS, /visibility:|content:|opacity:|transform:/);
});

test('forced-color masks inherit the system-adjusted parent foreground only on drawing pseudo elements', () => {
    const inline = patch('editor/contrib/inlineProgress/browser/inlineProgressWidget.css');
    const shadow = patch('base/browser/ui/contextview/contextview.js');
    for (const css of [svgPseudoCSS, inline, shadow]) {
        assert.match(css, /@media \(forced-colors: active\)[\s\S]*?::before \{ color: inherit; forced-color-adjust: preserve-parent-color; \}/);
        assert.doesNotMatch(css, /forced-color-adjust: none|CanvasText|GrayText/);
    }
    assert.match(inline, /\.inline-progress-widget:hover \.icon::before \{ color: inherit; forced-color-adjust: preserve-parent-color;/);
});

test('unreviewed Monaco modules and altered SVG paths fail rather than silently lose icons', () => {
    assert.throws(() => patchMonacoSvg(read(styleFile) + '\n', path.join(root, styleFile), svgCSS), /Review/);
    const css = 'base/browser/ui/codicons/codicon/codicon.css';
    assert.throws(() => patchMonacoSvg(read(css), path.join(root, css), svgCSS + '\n'), /Regenerate/);
});

test('production icon CSS emits only reviewed SVG masks and no icon font', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'json-svg-test-'));
    try {
        const entry = path.join(tmp, 'entry.js');
        fs.writeFileSync(entry, `import ${JSON.stringify(path.join(root, 'base/browser/ui/codicons/codicon/codicon.css'))};`);
        const result = await build({ configFile: false, publicDir: false, logLevel: 'silent', plugins: [monacoSvgPlugin()], build: { write: false, assetsInlineLimit: 0, rollupOptions: { input: entry } } });
        assert.equal(result.output.filter(x => /\.(?:woff2?|ttf|otf)$/.test(x.fileName)).length, 0);
        const css = result.output.filter(x => x.fileName.endsWith('.css')).map(x => x.source).join('\n');
        assert.match(css, /data:image\/svg\+xml/);
        assert.doesNotMatch(css, /@font-face|codicon\.ttf/);
        assert.equal([...css.matchAll(/--json-codicon-[a-f0-9]+:/g)].length, 52);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
