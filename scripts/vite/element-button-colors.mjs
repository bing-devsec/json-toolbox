import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const PREFIX = '[element-button-colors]';
const MODULE_SUFFIX = '/element-plus/es/components/button/src/button-custom.mjs';
const CUSTOM_STYLE_SHA = '959a06f71dd274f3bdc624037d4e915d6038a49498608412db5c82d87e55192d';
const INDEX_SHA = '396de6f92017b66b66449d34e0ab0a4732146dbdaa7eec996ab513e6b5578b3e';
const CLOSURE_SHA = '6708afacd65153f218228f1533e1ac784c6fb4ae77830678165f70a56d205058';
const SHELL_SHA = '551085b784515e3173c0241fbc1a782a6bba13a941f3dd6fa1727166ad9cb00b';
const entries = [
    'alert', 'autocomplete', 'button', 'checkbox', 'collapse-transition', 'collapse', 'dialog',
    'dropdown', 'empty', 'icon', 'input-number', 'input', 'message-box', 'message', 'popover',
    'radio', 'select', 'switch', 'table', 'tag', 'upload',
].map(name => `components/${name}/index.mjs`);
const reviewedExternalPackages = new Set([
    'vue', '@vue/runtime-core', '@vue/runtime-dom', '@element-plus/icons-vue',
    'diff', 'histogram-diff', 'js-base64', 'js-yaml',
    'json5', 'jsonc-parser', 'jsonrepair', 'monaco-editor',
]);
const LOCK_SHA = 'ae12046f4bd0e2a30a6f44216113a20ce5479a87954690c532b50f12fd83d6b5';
const allowedExports = new Set([
    'ElAlert', 'ElAutocomplete', 'ElButton', 'ElButtonGroup', 'ElCheckbox', 'ElCollapse', 'ElCollapseItem',
    'ElCollapseTransition', 'ElDialog', 'ElDropdown', 'ElDropdownItem', 'ElDropdownMenu', 'ElEmpty',
    'ElIcon', 'ElInput', 'ElInputNumber', 'ElMessage', 'ElMessageBox', 'ElOption', 'ElPopover',
    'ElRadio', 'ElRadioButton', 'ElRadioGroup', 'ElSelect', 'ElSwitch', 'ElTable', 'ElTableColumn',
    'ElTag', 'ElUpload',
]);
const excludedDirectories = new Set(['node_modules', '.git', '.nuxt', '.output', '.agents', '.codex', 'tests', 'reports', 'scripts', 'server', 'public', 'types']);
const renderHelpers = new Set(['h', 'createVNode', 'createBlock', 'createElementBlock', 'createElementVNode', 'cloneVNode', 'resolveComponent', 'resolveDynamicComponent', 'resolveDirective', 'mergeProps']);
/** @param {string} message @returns {never} */
const fail = message => { throw new Error(`${PREFIX} ${message} Review the custom-color specialization before enabling this usage.`); };
/** @param {import('node:crypto').BinaryLike} code */
const sha = code => createHash('sha256').update(code).digest('hex');
/** @param {string} name @param {string} code */
const sourceFile = (name, code) => ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') || name.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Conservative application contract: CSS themes, never arbitrary button color props.
 * Unknown Element APIs, prop forwarding and programmatic component construction fail
 * closed. This is deliberately stricter than a general Vue application.
 */
/** @param {string} code @param {string} filename */
export function auditElementButtonApplicationSource(code, filename) {
    const name = filename.replaceAll('\\', '/');
    let script = code;
    let buttonCount = 0;
    if (name.endsWith('.vue')) {
        const { descriptor, errors } = parse(code, { filename });
        if (errors.length) fail(`Cannot inspect ${name}.`);
        if (descriptor.template?.src || descriptor.script?.src || descriptor.scriptSetup?.src
            || (descriptor.template?.lang && descriptor.template.lang !== 'html')
            || [descriptor.script?.lang, descriptor.scriptSetup?.lang].some(lang => lang && !['js', 'ts'].includes(lang))) {
            fail(`External or preprocessed component block in ${name}.`);
        }
        script = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n');
        /** @param {import('@vue/compiler-core').RootNode | import('@vue/compiler-core').TemplateChildNode | import('@vue/compiler-core').SimpleExpressionNode | undefined} node */
        const walkTemplate = node => {
            if (!node) return;
            if (node.type === 1) {
                if (/^(?:el-button|ElButton)$/.test(node.tag)) buttonCount++;
                for (const prop of node.props) {
                    const attr = prop.type === 6 ? prop.name : prop.name === 'bind' && prop.arg?.type === 4 ? prop.arg.content : undefined;
                    if (attr?.toLowerCase() === 'color') fail(`Color prop in ${name}:${node.loc.start.line}.`);
                    if (prop.type === 7 && prop.name === 'bind' && (!prop.arg || prop.arg.type !== 4 || !prop.arg.isStatic)) {
                        fail(`Dynamic prop forwarding in ${name}:${node.loc.start.line}.`);
                    }
                    if (/^(?:el-dropdown|ElDropdown)$/.test(node.tag) && attr && ['button-props', 'buttonProps', 'split-button', 'splitButton'].includes(attr)) {
                        fail(`Dropdown button forwarding in ${name}:${node.loc.start.line}.`);
                    }
                    // Component refs can expose mutable props/defaults, bypassing template checks.
                    if (/^(?:el-button|ElButton|el-dropdown|ElDropdown)$/.test(node.tag) && attr === 'ref') {
                        fail(`Mutable button/dropdown ref in ${name}:${node.loc.start.line}.`);
                    }
                }
                if (node.tag === 'component' || node.props.some(prop => prop.name === 'is' || (prop.type === 7 && prop.name === 'bind' && prop.arg?.type === 4 && prop.arg.content === 'is'))) {
                    if (!name.endsWith('/src/App.vue') || sha(code) !== SHELL_SHA) {
                        fail(`Unreviewed dynamic component in ${name}.`);
                    }
                }
            }
            if ('children' in node && Array.isArray(node.children)) {
                for (const child of node.children) if (typeof child === 'object') walkTemplate(child);
            }
        };
        walkTemplate(descriptor.template?.ast);
    }
    const tree = sourceFile(name, script);
    const componentLocals = new Set();
    const importedIdentifiers = new Set();
    const importedRenderHelpers = new Set();
    /** @param {string} specifier @param {ts.Node} node */
    const validateSpecifier = (specifier, node) => {
        {
            const local = specifier.startsWith('.') || specifier.startsWith('~/') || specifier.startsWith('@/');
            if (local) {
                const target = specifier.startsWith('.') ? resolve(dirname(name), specifier).replaceAll('\\', '/') : specifier.slice(2);
                const parts = target.split('/');
                const excludedLeafDirectory = excludedDirectories.has(parts.at(-1) ?? '')
                    && !['.ts', '.js', '.vue'].some(extension => existsSync(target + extension));
                if (parts.slice(0,-1).some(part => excludedDirectories.has(part)) || excludedLeafDirectory) {
                    fail(`Import from an unaudited source directory in ${name}.`);
                }
            } else if (specifier !== 'element-plus' && !specifier.startsWith('element-plus/')) {
                const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0];
                if (!reviewedExternalPackages.has(packageName)) fail(`Unreviewed external dependency ${specifier} in ${name}.`);
            }
        }
        if (specifier === 'element-plus') {
            if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) {
                fail(`Unreviewed Element import in ${name}.`);
            }
            if (node.importClause.name) fail(`Default Element import in ${name}.`);
            for (const item of node.importClause.namedBindings.elements) {
                if (node.importClause.isTypeOnly || item.isTypeOnly) continue;
                const exported = (item.propertyName ?? item.name).text;
                if (!allowedExports.has(exported) || item.name.text !== exported) fail(`Unreviewed Element export or alias ${exported} in ${name}.`);
                importedIdentifiers.add(item.name);
                if (item.propertyName) importedIdentifiers.add(item.propertyName);
                if (exported !== 'ElMessage' && exported !== 'ElMessageBox') componentLocals.add(item.name.text);
            }
        } else if (specifier.startsWith('element-plus/')) {
            if (specifier !== 'element-plus/es/components/message-box/index.mjs'
                && !/^element-plus\/es\/components\/[a-z-]+\/style\/css(?:\.mjs)?$/.test(specifier)) {
                fail(`Unreviewed Element subpath ${specifier} in ${name}.`);
            }
        }
    };
    /** @param {ts.Node} node */
    const walk = node => {
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) fail(`CommonJS import alias in ${name}.`);
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) validateSpecifier(node.moduleSpecifier.text, node);
            if (ts.isExportDeclaration(node) && node.moduleSpecifier && /^(?:vue(?:\/|$)|@vue\/)/.test(node.moduleSpecifier.text)) fail(`Vue runtime re-export in ${name}.`);
            if (ts.isImportDeclaration(node) && /^(?:vue(?:\/|$)|@vue\/)/.test(node.moduleSpecifier.text)) {
                if (node.importClause?.name) fail(`Vue default import in ${name}.`);
                if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) fail(`Vue namespace import in ${name}.`);
                for (const item of (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : [])) {
                    if (renderHelpers.has((item.propertyName ?? item.name).text)) {
                        if (item.name.text !== (item.propertyName ?? item.name).text) fail(`Aliased Vue render helper in ${name}.`);
                        importedRenderHelpers.add(item.name.text);
                        importedIdentifiers.add(item.name);
                    }
                }
            }
        }
        if (ts.isJsxSpreadAttribute(node) || (ts.isJsxAttribute(node) && node.name.getText(tree).toLowerCase() === 'color')) {
            fail(`JSX prop forwarding/color in ${name}.`);
        }
        if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
                if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) {
                    fail(`Unresolved dynamic module in ${name}.`);
                } else validateSpecifier(node.arguments[0].text, node);
            }
            if (ts.isIdentifier(node.expression) && renderHelpers.has(node.expression.text)) {
                const safeMessageSpan = name.endsWith('/src/utils/jsonToolMessage.ts')
                    && node.getText(tree) === "h('span', { title: message }, message)";
                if (!safeMessageSpan) fail(`Programmatic component rendering in ${name}.`);
            }
            const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
                : ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression) ? node.expression.argumentExpression.text : undefined;
            if (method && ['setPropsDefaults', 'component', 'use'].includes(method)) {
                fail(`Component registration/default mutation in ${name}.`);
            }
        }
        ts.forEachChild(node, walk);
    };
    walk(tree);
    /** @param {ts.Node} node */
    const checkReferences = node => {
        if (ts.isIdentifier(node) && importedRenderHelpers.has(node.text) && !importedIdentifiers.has(node)) {
            if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) fail(`Aliased render helper reference in ${name}.`);
        }
        if (ts.isIdentifier(node) && componentLocals.has(node.text) && !importedIdentifiers.has(node)) {
            fail(`Programmatic Element component reference ${node.text} in ${name}.`);
        }
        ts.forEachChild(node, checkReferences);
    };
    checkReferences(tree);
    return { buttonCount };
}

/** Hash the entire conservative component dependency closure, including both indirect
 * button consumers (Dropdown and MessageBox). A new consumer/release cannot slip in.
 */
/** @param {string} root */
export function auditElementButtonDependencies(root) {
    const base = resolve(root, 'node_modules/element-plus/es');
    if (JSON.parse(readFileSync(resolve(base, '../package.json'), 'utf8')).version !== '2.13.7'
        || sha(readFileSync(resolve(base, 'index.mjs'))) !== INDEX_SHA) fail('Unreviewed Element Plus release/index.');
    if (sha(readFileSync(resolve(root, 'package-lock.json'))) !== LOCK_SHA) fail('Unreviewed dependency lockfile.');
    const seen = new Set();
    /** @type {string[]} */
    const consumers = [];
    /** @param {string} file */
    const visit = file => {
        if (seen.has(file)) return;
        seen.add(file);
        const tree = sourceFile(file, readFileSync(file, 'utf8'));
        for (const node of tree.statements) {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
                const target = resolve(dirname(file), node.moduleSpecifier.text);
                if (target.endsWith('/components/button/index.mjs')) consumers.push(relative(base, file).replaceAll('\\', '/'));
                if (target.endsWith('.mjs')) visit(target);
            }
        }
    };
    for (const entry of entries) visit(resolve(base, entry));
    const hash = createHash('sha256');
    for (const file of [...seen].sort()) hash.update(relative(base, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
    if (hash.digest('hex') !== CLOSURE_SHA) fail('Unreviewed Element component dependency/consumer source.');
    return { modules: seen.size, consumers: consumers.sort() };
}

/** @param {string} root */
export function auditElementButtonApplication(root) {
    let buttonCount = 0;
    let files = 0;
    /** @param {string} directory */
    const visit = directory => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (!excludedDirectories.has(entry.name) && !entry.name.startsWith('.')) visit(file);
            } else if (/\.(?:vue|[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                files++;
                buttonCount += auditElementButtonApplicationSource(readFileSync(file, 'utf8'), file).buttonCount;
            }
        }
    };
    visit(resolve(root, 'src'));
    return { files, buttonCount, ...auditElementButtonDependencies(root) };
}

/** Preserve the original no-color execution path, including props.color tracking,
 * computed identity, setup injections and empty object result. Only its unreachable
 * TinyColor branch/export is removed. An unexpected runtime color fails explicitly.
 */
/** @param {string} code @param {string} id */
export function pruneUnusedElementButtonColors(code, id) {
    const name = id.replaceAll('\\', '/').split('?')[0];
    if (!name.endsWith(MODULE_SUFFIX)) return null;
    if (sha(code) !== CUSTOM_STYLE_SHA) fail('Unreviewed button custom-style source.');
    const tree = sourceFile(name, code);
    /** @type {Array<[number, number, string]>} */
    const changes = [];
    /** @param {ts.Node} node */
    const walk = node => {
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) fail(`CommonJS import alias in ${name}.`);
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@ctrl/tinycolor') changes.push([node.getStart(tree), node.end, '']);
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'darken') changes.push([node.getStart(tree), node.end, '']);
        if (ts.isIfStatement(node) && node.expression.getText(tree) === 'buttonColor') {
            changes.push([node.getStart(tree), node.end, `if (buttonColor) throw new Error('${PREFIX} Unexpected button color; review the build specialization.');`]);
            return;
        }
        ts.forEachChild(node, walk);
    };
    walk(tree);
    for (const [start, end, replacement] of changes.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + replacement + code.slice(end);
    return code.replace('export { darken, useButtonCustomStyle };', 'export { useButtonCustomStyle };');
}

/** @returns {import('vite').Plugin} */
export const elementButtonColorsPlugin = () => {
    let root = process.cwd();
    let enabled = false;
    return {
        name: 'element-button-colors',
        enforce: 'pre',
        apply: 'build',
        configResolved(config) { root = config.root; },
        buildStart() {
            enabled = false;
            try {
                auditElementButtonApplication(root);
                enabled = true;
            } catch (error) {
                // Legitimate future features must keep working. Abandon this small
                // optimization if their usage or upgraded dependencies are unreviewed.
                this.warn(`${error instanceof Error ? error.message : String(error)} Keeping the original Element Plus custom-color implementation.`);
            }
        },
        transform(code, id) {
            if (!enabled) return null;
            const result = pruneUnusedElementButtonColors(code, id);
            return result === null ? null : { code: result, map: null };
        },
    };
};
