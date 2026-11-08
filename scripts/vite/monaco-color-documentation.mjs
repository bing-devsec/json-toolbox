import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseSource } from './typescript-ast.mjs';

const MODULE_ROOT = '/monaco-editor/esm/vs/';
/** @type {Record<string, [string, number]>} */
const reviewedSources = {
    'platform/theme/common/colors/baseColors.js': ['8d879c2779740383d778271e3142d7dbfb59fece56b768dbb449b64a7ea961a6', 17],
    'platform/theme/common/colors/chartsColors.js': ['ab678e2101a9a2e889b0262a57a822d3c2bb9cb199ac175bab0d35fd1927ccd6', 8],
    'platform/theme/common/colors/editorColors.js': ['32cc6ed31f2304369c0b78f907d632f0e166c23c4233ec0fd946ede49648ac8b', 93],
    'platform/theme/common/colors/inputColors.js': ['17b22e8de34fb905b4af12dbd4a5d7b6fa7b75888b4b988e1cf400f600ee3648', 45],
    'platform/theme/common/colors/listColors.js': ['ba72f69f1afbb2cb9c8c1abc9b87a6d31c76d236616913312351de08ed9db895', 36],
    'platform/theme/common/colors/menuColors.js': ['87533c091be311709ee73df1e35830b2825810b65d991e90ed0c8626a4dd4621', 7],
    'platform/theme/common/colors/minimapColors.js': ['9a339a31791e7ac74c4580846f00b7f3e73e0110f675e919539d26ed4536e2c5', 11],
    'platform/theme/common/colors/miscColors.js': ['d68975f4b9aa3d1b48cc638913bc9e5c0f791d276d19f803cb0f998170d87904', 8],
    'platform/theme/common/colors/quickpickColors.js': ['a2a9c1dc2bc57cd45b0fec2e2d07574d4146d288235d91c3658efca85ded0b1b', 9],
    'platform/theme/common/colors/searchColors.js': ['b589ad30b7a225c20a9377bc8bf27b7b8c0f7693ed530b07d9724fa4db1ee044', 3],
    'editor/common/core/editorColorRegistry.js': ['e799295451ee01280b8b2ab496d24c7f8bedf6918742793c96b43df6a5930865', 68],
};

/**
 * registerColor's third argument documents a color in VS Code's settings schema.
 * StandaloneThemeService consumes its id/defaults, never that documentation. The
 * app's own theme panel supplies its bilingual copy independently. Replace only
 * this argument in these reviewed definition modules, leaving every color,
 * transform, transparency constraint, deprecation message and UI label intact.
 * Do not transform colorUtils or arbitrary UI modules that also use localization.
 */
/** @param {string} code @param {string} id */
export function pruneMonacoColorDocumentation(code, id) {
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    const name = Object.keys(reviewedSources).find(name => normalized.endsWith(MODULE_ROOT + name));
    if (!name) return null;
    const [sha256, calls] = reviewedSources[name];
    const fail = () => { throw new Error(`[monaco-color-documentation] Review the installed Monaco ${name} before changing this build adapter.`); };
    if (createHash('sha256').update(code).digest('hex') !== sha256) fail();
    const source = parseSource(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) fail();
    /** @type {Array<[number, number]>} */
    const spans = [];
    /** @param {ts.Node} node */
    const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerColor') {
            const description = node.arguments[2];
            const isLocalized = description && ts.isCallExpression(description) && description.expression.getText(source) === 'nls.localize';
            const isEmpty = description && ts.isStringLiteral(description) && description.text === '';
            if (node.arguments.length < 3 || node.arguments.length > 5 || (!isLocalized && !isEmpty)) fail();
            spans.push([description.getStart(source), description.end]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (spans.length !== calls) fail();
    for (const [start, end] of spans.reverse()) code = code.slice(0, start) + "''" + code.slice(end);
    if (parseSource(name, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS).parseDiagnostics.length) fail();
    return code;
}

/** @returns {import('vite').Plugin} */
export const monacoColorDocumentationPlugin = () => ({
    name: 'monaco-color-documentation',
    enforce: 'pre',
    transform(code, id) {
        const result = pruneMonacoColorDocumentation(code, id);
        return result === null ? null : { code: result, map: null };
    },
});
