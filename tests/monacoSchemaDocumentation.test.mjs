import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { monacoSchemaDocumentationPlugin, pruneMonacoSchemaDocumentation } from '../scripts/vite/monaco-schema-documentation.mjs';
import { monacoLargeFoldingPlugin, patchMonacoEditorOptions } from '../scripts/vite/monaco-large-folding.mjs';
import { monacoSingleEditorPlugin } from '../scripts/vite/monaco-single-editor.mjs';
import { monacoSvgPlugin } from '../scripts/vite/monaco-svg.mjs';
import { monacoColorDocumentationPlugin } from '../scripts/vite/monaco-color-documentation.mjs';
import { monacoJsonModeTypesPlugin, pruneUnusedJsonModeTypes } from '../scripts/vite/monaco-json-mode-types.mjs';
import { monacoJsonDiagnosticsPlugin, patchMonacoJsonDiagnostics } from '../scripts/vite/monaco-json-diagnostics.mjs';
import { monacoJsonFoldingPlugin, patchMonacoJsonFolding } from '../scripts/vite/monaco-json-folding.mjs';

const root = path.dirname(import.meta.dirname);
const configRoot = path.join(root, 'node_modules/monaco-editor/esm/vs/editor/common/config');
const documentationKeys = new Set(['description', 'markdownDescription', 'enumDescriptions', 'markdownEnumDescriptions']);

function semanticData(value, omitDocumentation = false) {
    if (typeof value === 'function') return { functionSource: value.toString() };
    if (Array.isArray(value)) return value.map(item => semanticData(item, omitDocumentation));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !omitDocumentation || !documentationKeys.has(key))
        .map(([key, child]) => [key, semanticData(child, omitDocumentation)]));
    return value;
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
    return value;
}

function outcome(operation) {
    try { return { value: semanticData(operation()) }; }
    catch (error) { return { error: error.name, message: error.message }; }
}

async function loadRuntime(patched) {
    const contents = `
        export { EditorOptions, editorOptionsRegistry } from 'monaco-editor/esm/vs/editor/common/config/editorOptions.js';
        export { isEditorConfigurationKey, isDiffEditorConfigurationKey } from 'monaco-editor/esm/vs/editor/common/config/editorConfigurationSchema.js';
        export { DefaultConfiguration } from 'monaco-editor/esm/vs/platform/configuration/common/configurations.js';
        import { Registry } from 'monaco-editor/esm/vs/platform/registry/common/platform.js';
        import { Extensions } from 'monaco-editor/esm/vs/platform/configuration/common/configurationRegistry.js';
        export const configurationRegistry = Registry.as(Extensions.Configuration);
    `;
    const result = await build({
        stdin: { contents, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node',
        plugins: patched ? [{ name: 'schema-doc-test', setup(builder) {
            builder.onLoad({ filter: /\/config\/(?:editorOptions|editorConfigurationSchema)\.js$/ }, args => ({
                contents: pruneMonacoSchemaDocumentation(fs.readFileSync(args.path, 'utf8'), args.path), loader: 'js',
            }));
        } }] : [],
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const runtimes = Promise.all([loadRuntime(false), loadRuntime(true)]);

test('actual Vite Monaco plugin order validates editor options and JSON lifecycle adapter composition', () => {
    const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
    const source = ts.createSourceFile('vite.config.ts', config, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let pluginNames;
    const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name?.text === 'plugins' && ts.isArrayLiteralExpression(node.initializer)) {
            pluginNames = node.initializer.elements.map(item => item.expression.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    const factories = { monacoSchemaDocumentationPlugin, monacoColorDocumentationPlugin, monacoLargeFoldingPlugin, monacoSingleEditorPlugin, monacoSvgPlugin, monacoJsonModeTypesPlugin, monacoJsonDiagnosticsPlugin, monacoJsonFoldingPlugin };
    assert(pluginNames.indexOf('monacoSchemaDocumentationPlugin') < pluginNames.indexOf('monacoLargeFoldingPlugin'));
    assert.deepEqual(pluginNames.filter(name => ['monacoJsonModeTypesPlugin', 'monacoJsonDiagnosticsPlugin', 'monacoJsonFoldingPlugin'].includes(name)),
        ['monacoJsonModeTypesPlugin', 'monacoJsonDiagnosticsPlugin', 'monacoJsonFoldingPlugin']);
    const applyPlugins = (original, file) => {
        let actual = original;
        for (const name of pluginNames.filter(name => name.startsWith('monaco'))) {
            assert(factories[name], `Review new Vite plugin ${name} in the composition test`);
            const plugin = factories[name]();
            actual = plugin.transform?.(actual, file)?.code ?? actual;
        }
        return actual;
    };
    const file = path.join(configRoot, 'editorOptions.js'), original = fs.readFileSync(file, 'utf8');
    const actual = applyPlugins(original, file);
    assert.equal(actual, patchMonacoEditorOptions(pruneMonacoSchemaDocumentation(original, file)));
    assert(actual.includes("'foldingMaximumRegions', 5000, 10, 1000000,"));
    assert.throws(() => pruneMonacoSchemaDocumentation(patchMonacoEditorOptions(original), file), /Review the installed Monaco/);
    const jsonFile = path.join(root, 'node_modules/monaco-editor/esm/vs/language/json/jsonMode.js');
    const jsonSource = fs.readFileSync(jsonFile, 'utf8');
    const expectedJson = patchMonacoJsonFolding(patchMonacoJsonDiagnostics(pruneUnusedJsonModeTypes(jsonSource, jsonFile), jsonFile), jsonFile);
    assert.equal(applyPlugins(jsonSource, jsonFile), expectedJson);
    assert.throws(() => applyPlugins(jsonSource + '\n', jsonFile), /Review the installed Monaco/);
});

test('adapter fails closed on unreviewed sources and leaves all other modules untouched', () => {
    for (const name of ['editorOptions.js', 'editorConfigurationSchema.js']) {
        const file = path.join(configRoot, name), original = fs.readFileSync(file, 'utf8');
        assert.throws(() => pruneMonacoSchemaDocumentation(original + '\n', file), /Review the installed Monaco/);
        const patched = pruneMonacoSchemaDocumentation(original, file);
        assert.equal(patched, pruneMonacoSchemaDocumentation(original, file + '?v=1'));
        assert.equal(patched, pruneMonacoSchemaDocumentation(original, file.replaceAll('/', '\\')));
        assert.equal(ts.createSourceFile(name, patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
    }
    assert.equal(pruneMonacoSchemaDocumentation('const x = { description: "visible UI" };', '/application/editorOptions.js'), null);
});

test('all installed option methods and actual UI, error and deprecation strings remain unchanged', () => {
    const file = path.join(configRoot, 'editorOptions.js'), original = fs.readFileSync(file, 'utf8');
    const patched = pruneMonacoSchemaDocumentation(original, file);
    const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let checkedMethods = 0;
    const visit = node => {
        if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
            assert(patched.includes(node.getText(source)), node.name?.getText(source));
            checkedMethods++;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(checkedMethods, 83);
    assert(patched.includes("nls.localize('editorViewAccessibleLabel', \"Editor content\")"));
    for (const key of ['errorMessage', 'deprecationMessage', 'markdownDeprecationMessage']) {
        const originalValues = [];
        const collect = node => {
            if (ts.isPropertyAssignment(node) && node.name?.text === key) originalValues.push(node.getText(source));
            ts.forEachChild(node, collect);
        };
        collect(source);
        assert(originalValues.length, key);
        for (const property of originalValues) assert(patched.includes(property), key);
    }
});

test('real installed Monaco option defaults, schemas, validators and updates retain their behavior', async () => {
    const [before, after] = await runtimes;
    assert.equal(after.editorOptionsRegistry.length, before.editorOptionsRegistry.length);
    assert.deepEqual(Object.keys(after.EditorOptions), Object.keys(before.EditorOptions));
    const samples = [undefined, null, true, false, 0, -1, 1, 8, 100, 1e10, NaN, '', 'false', 'on', 'off', 'invalid',
        [], {}, { enabled: true }, { enabled: false, maxLineCount: 12 }, { size: 12, showSlider: 'always' },
        { autoFindInSelection: 'multiline', seedSearchStringFromSelection: 'selection' }];
    let validations = 0;
    for (const original of before.editorOptionsRegistry) {
        const patched = after.editorOptionsRegistry[original.id];
        assert.equal(patched.name, original.name);
        assert.deepEqual(semanticData(patched.defaultValue), semanticData(original.defaultValue), original.name);
        assert.deepEqual(semanticData(patched.schema, true), semanticData(original.schema, true), original.name);
        const enumValues = original.schema?.enum || [];
        for (const value of [...samples, original.defaultValue, ...enumValues]) {
            assert.deepEqual(outcome(() => patched.validate(clone(value))), outcome(() => original.validate(clone(value))), `${original.name}: validate ${String(value)}`);
            assert.deepEqual(outcome(() => patched.applyUpdate(clone(patched.defaultValue), clone(value))),
                outcome(() => original.applyUpdate(clone(original.defaultValue), clone(value))), `${original.name}: applyUpdate`);
            validations++;
        }
    }
    assert(validations > 3500);
});

test('real schema registry, configuration-key routing and default configuration retain all non-documentation data', async () => {
    const [before, after] = await runtimes;
    const beforeProperties = before.configurationRegistry.getConfigurationProperties();
    const afterProperties = after.configurationRegistry.getConfigurationProperties();
    assert.deepEqual(semanticData(afterProperties, true), semanticData(beforeProperties, true));
    assert(Object.keys(beforeProperties).length > 150);
    for (const key of [...Object.keys(beforeProperties), 'editor.notASetting', 'diffEditor.notASetting']) {
        const suffix = key.slice(key.indexOf('.') + 1);
        assert.equal(after.isEditorConfigurationKey(suffix), before.isEditorConfigurationKey(suffix), key);
        assert.equal(after.isDiffEditorConfigurationKey(suffix), before.isDiffEditorConfigurationKey(suffix), key);
    }
    for (const property of ['configurationContributors', 'excludedConfigurationProperties']) {
        assert.deepEqual(semanticData(after.configurationRegistry[property], true), semanticData(before.configurationRegistry[property], true), property);
    }
    assert.deepEqual(after.configurationRegistry.getPolicyConfigurations(), before.configurationRegistry.getPolicyConfigurations());
    const beforeDefaults = new before.DefaultConfiguration(console);
    const afterDefaults = new after.DefaultConfiguration(console);
    try {
        const baseline = beforeDefaults.reload(), optimized = afterDefaults.reload();
        assert.deepEqual(semanticData(optimized.contents), semanticData(baseline.contents));
        assert.deepEqual(optimized.keys, baseline.keys);
        assert.deepEqual(semanticData(optimized.overrides), semanticData(baseline.overrides));
    } finally {
        beforeDefaults.dispose();
        afterDefaults.dispose();
    }
});
