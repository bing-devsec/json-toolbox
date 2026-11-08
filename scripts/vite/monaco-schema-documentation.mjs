import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseSource } from './typescript-ast.mjs';

const MODULE_ROOT = '/monaco-editor/esm/vs/editor/common/config/';
/** @type {Record<string, {sha256: string, properties: number}>} */
const reviewedSources = {
    'editorOptions.js': {
        sha256: 'fef07cb48544f3dc3927805a2a733d9f4588578f6bb221e845e67765accf2b4d',
        properties: 278,
    },
    'editorConfigurationSchema.js': {
        sha256: '0d9c2bb664aa12dce55c8de738b8710fad5d7457e689c0300bbe55e95b81778a',
        properties: 41,
    },
};
const documentationKeys = new Set([
    'description', 'markdownDescription', 'enumDescriptions', 'markdownEnumDescriptions',
]);

/**
 * These two reviewed Monaco modules include VS Code settings-schema help text.
 * This standalone application has no settings-schema documentation UI: its own
 * bilingual settings dialog supplies its labels. Monaco's runtime consumers use
 * the option names, schemas, defaults, enums, scopes and validators, not this help
 * text. Keep all those fields, deprecation/error messages, actual UI labels and
 * accessibility strings intact. In particular ariaLabel is a runtime default.
 *
 * This is deliberately not a general description/localization-removal transform.
 * Fail closed on a dependency update, and remove only the reviewed AST properties.
 */
/** @param {string} code @param {string} id */
export function pruneMonacoSchemaDocumentation(code, id) {
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    const name = Object.keys(reviewedSources).find(name => normalized.endsWith(MODULE_ROOT + name));
    if (!name) return null;
    const reviewed = reviewedSources[name];
    const fail = () => { throw new Error(`[monaco-schema-documentation] Review the installed Monaco ${name} before changing this build adapter.`); };
    if (createHash('sha256').update(code).digest('hex') !== reviewed.sha256) fail();

    const source = parseSource(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) fail();
    /** @type {Array<[number, number]>} */
    const spans = [];
    /** @param {ts.Node} node */
    const visit = node => {
        if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && documentationKeys.has(node.name.text)) {
            // Every matched property in these source hashes is schema-only prose.
            // Keep the original source outside the property, including all methods.
            spans.push([node.getStart(source), node.end + (code[node.end] === ',' ? 1 : 0)]);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (spans.length !== reviewed.properties) fail();
    for (const [start, end] of spans.reverse()) code = code.slice(0, start) + code.slice(end);
    if (parseSource(name, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS).parseDiagnostics.length) fail();
    return code;
}

/** @returns {import('vite').Plugin} */
export const monacoSchemaDocumentationPlugin = () => ({
    name: 'monaco-schema-documentation',
    enforce: 'pre',
    transform(code, id) {
        const result = pruneMonacoSchemaDocumentation(code, id);
        return result === null ? null : { code: result, map: null };
    },
});
