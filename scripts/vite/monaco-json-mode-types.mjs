import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseSource } from './typescript-ast.mjs';

const SUFFIX = '/monaco-editor/esm/vs/language/json/jsonMode.js';
const SOURCE_SHA256 = 'ad6dad47d4d186fe8b11f573f168d3129ba1799c8c5ee87ed1607f3d40fc805a';
const REVIEWED_REMOVED = new Set([
    'DocumentUri', 'URI', 'Location', 'LocationLink', 'ColorInformation', 'ColorPresentation',
    'FoldingRange', 'DiagnosticRelatedInformation', 'DiagnosticTag', 'CodeDescription', 'Diagnostic',
    'Command', 'TextEdit', 'ChangeAnnotation', 'ChangeAnnotationIdentifier', 'AnnotatedTextEdit',
    'TextDocumentEdit', 'CreateFile', 'RenameFile', 'DeleteFile', 'WorkspaceEdit', 'TextDocumentIdentifier',
    'VersionedTextDocumentIdentifier', 'OptionalVersionedTextDocumentIdentifier', 'TextDocumentItem',
    'MarkupKind', 'MarkupContent', 'CompletionItemTag', 'InsertReplaceEdit', 'InsertTextMode',
    'CompletionItemLabelDetails', 'CompletionItem', 'CompletionList', 'MarkedString', 'Hover',
    'ParameterInformation', 'SignatureInformation', 'DocumentHighlight', 'SymbolTag', 'SymbolInformation',
    'WorkspaceSymbol', 'DocumentSymbol', 'CodeActionKind', 'CodeActionTriggerKind', 'CodeActionContext',
    'CodeAction', 'CodeLens', 'FormattingOptions', 'DocumentLink', 'SelectionRange', 'SemanticTokenTypes',
    'SemanticTokenModifiers', 'SemanticTokens', 'InlineValueText', 'InlineValueVariableLookup',
    'InlineValueEvaluatableExpression', 'InlineValueContext', 'InlayHintKind', 'InlayHintLabelPart',
    'InlayHint', 'StringValue', 'InlineCompletionItem', 'InlineCompletionList',
    'InlineCompletionTriggerKind', 'SelectedCompletionInfo', 'InlineCompletionContext', 'WorkspaceFolder',
    'TextDocument', 'FullTextDocument',
]);

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
    if (!condition) throw new Error(`[monaco-json-mode-types] Review the installed Monaco JSON mode: ${message}`);
}
/** @param {ts.Expression} node @returns {ts.Expression} */
function unparenthesize(node) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
}
/** @typedef {{name: string, nodes: [ts.VariableStatement, ...ts.Statement[]], start: number, end: number}} NamespaceUnit */
/** @param {NamespaceUnit} unit */
function proveLocalInitialization(unit) {
    const declaration = unit.nodes[0].declarationList.declarations[0];
    if (declaration.initializer) {
        const value = declaration.initializer;
        assert(unit.name === 'FullTextDocument' && ts.isClassExpression(value) && !value.heritageClauses && !ts.getDecorators(value)?.length, 'unexpected class initializer');
        assert(value.members.every(member => (!member.name || !ts.isComputedPropertyName(member.name)) && !(ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) && !(ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(m => m.kind === ts.SyntaxKind.StaticKeyword))
            && (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member))), 'eager class effect');
        return;
    }
    const statement = unit.nodes[1];
    assert(ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression), 'namespace initializer must be an IIFE');
    const call = statement.expression;
    const fn = unparenthesize(call.expression);
    assert(ts.isFunctionExpression(fn) && fn.parameters.length === 1 && ts.isIdentifier(fn.parameters[0].name) && !fn.parameters[0].initializer && call.arguments.length === 1, 'unexpected IIFE shape');
    const parameter = fn.parameters[0].name.text;
    const argument = unparenthesize(call.arguments[0]);
    assert(ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.BarBarToken
        && ts.isIdentifier(argument.left) && argument.left.text === unit.name, 'unexpected namespace read');
    const assignment = unparenthesize(argument.right);
    assert(ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(assignment.left) && assignment.left.text === unit.name
        && ts.isObjectLiteralExpression(assignment.right) && assignment.right.properties.length === 0, 'namespace must initialize a fresh plain object');
    const functions = new Set(fn.body.statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text));
    for (const bodyStatement of fn.body.statements) {
        if (ts.isFunctionDeclaration(bodyStatement)) continue;
        assert(ts.isExpressionStatement(bodyStatement) && ts.isBinaryExpression(bodyStatement.expression), 'unexpected eager namespace statement');
        const expression = bodyStatement.expression;
        assert(expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && (ts.isPropertyAccessExpression(expression.left) || (ts.isElementAccessExpression(expression.left) && ts.isStringLiteral(expression.left.argumentExpression)))
            && ts.isIdentifier(expression.left.expression) && expression.left.expression.text === parameter, 'namespace may only write its own plain object');
        const value = expression.right;
        assert(ts.isStringLiteral(value) || ts.isNumericLiteral(value)
            || (ts.isIdentifier(value) && functions.has(value.text)), 'namespace assignment must be a literal or local function');
    }
}

/** Remove only unreachable, private LSP namespace initializers from Monaco's prebundled JSON mode. */
/** @param {string} code @param {string} id */
export function pruneUnusedJsonModeTypes(code, id) {
    if (!id.replaceAll('\\', '/').split('?')[0].endsWith(SUFFIX)) return null;
    assert(createHash('sha256').update(code).digest('hex') === SOURCE_SHA256, 'source SHA-256 changed');
    const source = parseSource(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert(source.parseDiagnostics.length === 0, 'source must parse');
    /** @param {ts.Node} node */
    const rejectDynamicEvaluation = node => {
        assert(!(ts.isIdentifier(node) && node.text === 'eval'), 'dynamic evaluation prevents private reachability analysis');
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)) {
            assert(node.expression.text !== 'Function', 'dynamic evaluation prevents private reachability analysis');
        }
        ts.forEachChild(node, rejectDynamicEvaluation);
    };
    rejectDynamicEvaluation(source);
    const start = code.indexOf('// node_modules/vscode-languageserver-types/lib/esm/main.js');
    const end = code.indexOf('// src/language/common/lspLanguageFeatures.ts');
    assert(start >= 0 && end > start, 'reviewed private-library boundaries changed');
    /** @type {NamespaceUnit[]} */
    const units = [];
    for (let i = 0; i < source.statements.length; i++) {
        const node = source.statements[i];
        if (node.getStart(source) < start || node.getStart(source) >= end) continue;
        assert(ts.isVariableStatement(node) && node.declarationList.declarations.length === 1, 'expected single private declaration');
        const declaration = node.declarationList.declarations[0];
        assert(ts.isIdentifier(declaration.name), 'expected private identifier');
        /** @type {[ts.VariableStatement, ...ts.Statement[]]} */
        const nodes = [node];
        if (!declaration.initializer) nodes.push(source.statements[++i]);
        units.push({ name: declaration.name.text, nodes, start: node.getStart(source), end: nodes[nodes.length - 1].end });
    }
    assert(units.length === 81, 'private declaration count changed');
    const names = new Set(units.map(unit => unit.name));
    assert(names.size === units.length, 'private declaration names must be unique');
    /** @param {ts.Node} node */
    const references = node => {
        const result = new Set();
        /** @param {ts.Node} current */
        const visit = current => {
            if (ts.isIdentifier(current) && names.has(current.text)) result.add(current.text);
            ts.forEachChild(current, visit);
        };
        visit(node);
        return result;
    };
    // Count all matching identifiers conservatively, including property names. False
    // positives retain extra code; reflection/eval is absent in the exact reviewed source.
    const live = new Set();
    for (const node of source.statements) {
        if (node.getStart(source) < start || node.getStart(source) >= end) {
            for (const name of references(node)) live.add(name);
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const unit of units) if (live.has(unit.name)) {
            for (const node of unit.nodes) for (const name of references(node)) {
                if (!live.has(name)) { live.add(name); changed = true; }
            }
        }
    }
    const removed = units.filter(unit => !live.has(unit.name));
    assert(removed.length === REVIEWED_REMOVED.size && removed.every(unit => REVIEWED_REMOVED.has(unit.name)), 'reviewed private reachability changed');
    for (const unit of removed) proveLocalInitialization(unit);
    for (const unit of [...removed].reverse()) code = code.slice(0, unit.start) + code.slice(unit.end);
    return code;
}

/** @returns {import('vite').Plugin} */
export const monacoJsonModeTypesPlugin = () => ({
    name: 'monaco-json-mode-types',
    enforce: 'pre',
    transform(code, id) {
        const result = pruneUnusedJsonModeTypes(code, id);
        return result === null ? null : { code: result, map: null };
    },
});
