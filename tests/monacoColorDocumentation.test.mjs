import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { pruneMonacoColorDocumentation } from '../scripts/vite/monaco-color-documentation.mjs';

const root = path.dirname(import.meta.dirname);
const monacoRoot = path.join(root, 'node_modules/monaco-editor/esm/vs');
const colorFiles = fs.readdirSync(path.join(monacoRoot, 'platform/theme/common/colors')).filter(name => name.endsWith('.js'))
    .map(name => path.join(monacoRoot, 'platform/theme/common/colors', name))
    .concat(path.join(monacoRoot, 'editor/common/core/editorColorRegistry.js'));
const withoutDescriptions = value => {
    if (Array.isArray(value)) return value.map(withoutDescriptions);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'description' && key !== 'enumDescriptions')
        .map(([key, child]) => [key, withoutDescriptions(child)]));
    return value;
};

test('color adapter checks every reviewed source and changes only registerColor documentation arguments', () => {
    let calls = 0;
    for (const file of colorFiles) {
        const original = fs.readFileSync(file, 'utf8');
        const patched = pruneMonacoColorDocumentation(original, file);
        assert.equal(typeof patched, 'string', file);
        assert.throws(() => pruneMonacoColorDocumentation(original + '\n', file), /Review the installed Monaco/);
        assert.equal(patched, pruneMonacoColorDocumentation(original, file + '?v=1'));
        assert.equal(patched, pruneMonacoColorDocumentation(original, file.replaceAll('/', '\\')));
        const source = ts.createSourceFile(file, patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        assert.equal(source.parseDiagnostics.length, 0);
        const originalSource = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const collect = source => {
            const found = [];
            const visit = node => {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerColor') found.push(node);
                ts.forEachChild(node, visit);
            };
            visit(source);
            return found;
        };
        const before = collect(originalSource), after = collect(source);
        assert.equal(after.length, before.length);
        // Restoring only argument 3 must reproduce every byte of upstream source.
        let restored = patched;
        for (let index = after.length - 1; index >= 0; index--) {
            const actual = after[index], expected = before[index];
            assert.equal(actual.arguments[2].text, '');
            assert.equal(actual.arguments.length, expected.arguments.length);
            for (let arg = 0; arg < actual.arguments.length; arg++) {
                if (arg !== 2) assert.equal(actual.arguments[arg].getText(source), expected.arguments[arg].getText(originalSource));
            }
            restored = restored.slice(0, actual.arguments[2].getStart(source))
                + expected.arguments[2].getText(originalSource) + restored.slice(actual.arguments[2].end);
        }
        assert.equal(restored, original);
        calls += before.length;
    }
    assert.equal(calls, 305);
    const registryFile = path.join(monacoRoot, 'platform/theme/common/colorUtils.js');
    assert.equal(pruneMonacoColorDocumentation(fs.readFileSync(registryFile, 'utf8'), registryFile), null);
    assert.equal(pruneMonacoColorDocumentation('registerColor("id", null, "UI");', '/application/colors.js'), null);
});

// Load the real installed StandaloneTheme class and its direct dependencies, not
// the DOM-based service. Extraction retains the class/functions verbatim; this
// tests actual color/token resolution without pretending to be a browser test.
function extractStandaloneTheme(code) {
    const source = ts.createSourceFile('standaloneThemeService.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = new Set([
        '../../../base/common/color.js', '../../common/encodedTokenAttributes.js',
        '../../common/languages/supports/tokenization.js', '../common/themes.js',
        '../../../platform/registry/common/platform.js', '../../../platform/theme/common/colorRegistry.js',
        '../../../platform/theme/common/theme.js',
    ]);
    const variables = new Set(['VS_LIGHT_THEME_NAME', 'VS_DARK_THEME_NAME', 'HC_BLACK_THEME_NAME', 'HC_LIGHT_THEME_NAME', 'colorRegistry']);
    const selected = source.statements.filter(node =>
        ts.isImportDeclaration(node) && imports.has(node.moduleSpecifier.text)
        || ts.isVariableStatement(node) && variables.has(node.declarationList.declarations[0].name.text)
        || ts.isClassDeclaration(node) && node.name.text === 'StandaloneTheme'
        || ts.isFunctionDeclaration(node) && ['isBuiltinTheme', 'getBuiltinRules'].includes(node.name.text));
    assert.equal(selected.length, 15);
    return selected.map(node => node.getText(source)).join('\n') + '\nexport { StandaloneTheme };';
}

async function loadRuntime(patched) {
    const contents = `
        import 'monaco-editor/esm/vs/editor/common/core/editorColorRegistry.js';
        import { Registry } from 'monaco-editor/esm/vs/platform/registry/common/platform.js';
        import { Extensions } from 'monaco-editor/esm/vs/platform/theme/common/colorRegistry.js';
        export { asCssVariableName } from 'monaco-editor/esm/vs/platform/theme/common/colorRegistry.js';
        export const colorRegistry = Registry.as(Extensions.ColorContribution);
        import { Extensions as ThemingExtensions } from 'monaco-editor/esm/vs/platform/theme/common/themeService.js';
        export const themingRegistry = Registry.as(ThemingExtensions.ThemingContribution);
        export { StandaloneTheme } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneThemeService.js';
        export { vs, vs_dark, hc_black, hc_light } from 'monaco-editor/esm/vs/editor/standalone/common/themes.js';
        export { defineJsonToolMonacoThemes } from './src/components/utils/monacoThemes.ts';
    `;
    const result = await build({
        stdin: { contents, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node',
        plugins: [{ name: 'color-doc-test', setup(builder) {
            builder.onLoad({ filter: /monaco-editor\/.*\.js$/ }, args => {
                let code = fs.readFileSync(args.path, 'utf8');
                if (patched) code = pruneMonacoColorDocumentation(code, args.path) ?? code;
                if (args.path.endsWith('/standaloneThemeService.js')) code = extractStandaloneTheme(code);
                return { contents: code, loader: 'js' };
            });
        } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const runtimes = Promise.all([loadRuntime(false), loadRuntime(true)]);

test('real installed color registry retains every color, default, constraint, schema and deprecation', async () => {
    const [before, after] = await runtimes;
    assert.equal(before.colorRegistry.getColors().length, 305);
    assert.deepEqual(withoutDescriptions(after.colorRegistry.getColors()), withoutDescriptions(before.colorRegistry.getColors()));
    assert.deepEqual(withoutDescriptions(after.colorRegistry.getColorSchema()), withoutDescriptions(before.colorRegistry.getColorSchema()));
    assert.deepEqual(after.colorRegistry.colorReferenceSchema.enum, before.colorRegistry.colorReferenceSchema.enum);
    assert(after.colorRegistry.getColors().every(color => color.description === ''));
});

test('real StandaloneTheme color resolution, tokens and generated theme rules match for all product themes and high contrast', async () => {
    const [before, after] = await runtimes;
    const definitions = runtime => {
        const themes = new Map([['vs', runtime.vs], ['vs-dark', runtime.vs_dark], ['hc-black', runtime.hc_black], ['hc-light', runtime.hc_light]]);
        runtime.defineJsonToolMonacoThemes({ editor: { defineTheme: (name, data) => themes.set(name, data) } });
        return themes;
    };
    const originalThemes = definitions(before), patchedThemes = definitions(after);
    assert.equal(originalThemes.size, 24);
    assert.deepEqual(patchedThemes, originalThemes);
    const snapshot = (runtime, name, data) => {
        const theme = new runtime.StandaloneTheme(name, data);
        const css = runtime.colorRegistry.getColors().map(item => {
            const color = theme.getColor(item.id, true);
            return color ? `${runtime.asCssVariableName(item.id)}: ${color.toString()};` : null;
        }).filter(Boolean);
        const rules = [];
        for (const participant of runtime.themingRegistry.getThemingParticipants()) participant(theme, { addRule: rule => rules.push(rule) }, {});
        return {
            type: theme.type, css, rules,
            tokens: theme.tokenTheme.getColorMap().map(color => color.toString()),
            styles: ['string', 'number', 'comment', 'variable', 'invalid'].map(token => theme.getTokenStyleMetadata(token, [], 'json')),
        };
    };
    for (const [name, data] of originalThemes) {
        assert.deepEqual(snapshot(after, name, patchedThemes.get(name)), snapshot(before, name, data), name);
    }
});
