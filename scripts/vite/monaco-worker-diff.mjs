import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseSource } from './typescript-ast.mjs';

/** @type {Record<string, {sha256: string, className: string, methods: Record<string, {async: boolean, static: boolean}>, imports: Record<string, string[]>}>} */
const reviewedModules = {
    '/monaco-editor/esm/vs/editor/browser/services/editorWorkerService.js': {
        sha256: '22b4c0c846f835c6bf14d0ad24f3516bb6d8a19436bc1062b01011075ca5e4b5',
        className: 'EditorWorkerService',
        methods: { computeDiff: { async: true, static: false } },
        imports: {
            '../../common/diff/linesDiffComputer.js': ['MovedText'],
            '../../common/diff/rangeMapping.js': ['DetailedLineRangeMapping', 'RangeMapping', 'LineRangeMapping'],
            '../../common/core/lineRange.js': ['LineRange'],
        },
    },
    '/monaco-editor/esm/vs/editor/common/services/editorSimpleWorker.js': {
        sha256: '37e79e176bcc7816278da15b0470dd794aa37ac4ca114b85775536392d2d9d8b',
        className: 'BaseEditorSimpleWorker',
        methods: {
            $computeDiff: { async: true, static: false },
            computeDiff: { async: false, static: true },
            _modelsAreIdentical: { async: false, static: true },
        },
        imports: { '../diff/linesDiffComputers.js': ['linesDiffComputers'] },
    },
};

/**
 * The application uses its own diff engine and two ordinary editors. The
 * single-editor adapter already removes Monaco's native Diff widget factories.
 * Remove their remaining unused worker RPC and native line-diff algorithms too.
 *
 * Keep all other worker methods, stringDiff (minimal edits), model mirroring,
 * foreign-language workers, and the synchronous local fallback byte-for-byte.
 * In particular, do not introduce a network request into the fallback path.
 */
/** @param {string} code @param {string} id */
export function pruneUnusedMonacoWorkerDiff(code, id) {
    const normalized = id.replaceAll('\\', '/').split('?')[0];
    const suffix = Object.keys(reviewedModules).find(name => normalized.endsWith(name));
    if (!suffix) return null;
    const reviewed = reviewedModules[suffix];
    const fail = () => { throw new Error(`[monaco-worker-diff] Review the installed Monaco ${suffix.split('/').at(-1)} before changing this build adapter.`); };
    if (createHash('sha256').update(code).digest('hex') !== reviewed.sha256) fail();

    const source = parseSource(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) fail();
    /** @type {Array<[number, number]>} */
    const spans = [];
    const foundMethods = new Set();
    const foundImports = new Set();
    let classCount = 0;
    /** @param {ts.Node} node */
    const visit = node => {
        if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name?.text === reviewed.className) {
            classCount++;
            for (const member of node.members) {
                if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
                const name = member.name.text;
                const expected = reviewed.methods[name];
                if (!expected) continue;
                /** @param {ts.SyntaxKind} kind */
                const has = kind => !!member.modifiers?.some(modifier => modifier.kind === kind);
                if (foundMethods.has(name) || has(ts.SyntaxKind.StaticKeyword) !== expected.static || has(ts.SyntaxKind.AsyncKeyword) !== expected.async) fail();
                foundMethods.add(name);
                spans.push([member.getStart(source), member.end]);
            }
        }
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            const expected = reviewed.imports[specifier];
            if (expected) {
                const clause = node.importClause;
                const bindings = clause?.namedBindings;
                if (foundImports.has(specifier) || clause?.name || !bindings || !ts.isNamedImports(bindings)
                    || bindings.elements.length !== expected.length
                    || bindings.elements.some((binding, index) => binding.propertyName || binding.name.text !== expected[index])) fail();
                foundImports.add(specifier);
                spans.push([node.getStart(source), node.end]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (classCount !== 1 || foundMethods.size !== Object.keys(reviewed.methods).length || foundImports.size !== Object.keys(reviewed.imports).length) fail();
    for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + code.slice(end);
    if (parseSource(id, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS).parseDiagnostics.length) fail();
    return code;
}

/**
 * Guard the emitted main graph, not an assumed list of application imports.
 * Inline Edit also uses the native Diff provider, even without a Diff widget.
 * This is deliberately a narrow known-consumer guard, not a JavaScript analyzer.
 * Worker files are assets in the main build; the dedicated worker plugin applies
 * the same reviewed pruning and this guard inside each worker build.
 */
/** @param {import('rollup').OutputBundle} bundle */
export function assertNoNativeMonacoDiffConsumers(bundle) {
    for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of new Set([...Object.keys(output.modules ?? {}), ...(output.moduleIds ?? [])])) {
            const normalized = id.replaceAll('\\', '/').split('?')[0];
            if (/\/monaco-editor\/esm\/vs\/editor\/(?:browser\/widget\/(?:diffEditor|multiDiffEditor)\/|contrib\/(?:inlineEdit|inlineEdits)\/)/.test(normalized)) {
                throw new Error(`[monaco-worker-diff] Native Monaco Diff consumer ${normalized} reached ${output.fileName}. Review the single-editor contract before enabling this feature.`);
            }
        }
    }
}
