// Read-only source inventory, not a production build or proof of runtime reachability.
// Usage: node collect-icon-scope.mjs /path/to/baseline > icon-scope.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
/** @param {string} projectRoot */
export async function collectMonacoIconScope(projectRoot) {
const root = path.resolve(projectRoot);
const require = createRequire(path.join(root, 'package.json'));
/** @type {typeof import('typescript')} */
const ts = require('typescript');
/** @type {typeof import('./vite/monaco-single-editor.mjs')} */
const { pruneUnusedMonacoDiffWidgets } = await import(pathToFileURL(path.join(root, 'scripts/vite/monaco-single-editor.mjs')).href);
const base = path.join(root, 'node_modules/monaco-editor/esm');
/** @param {import('node:crypto').BinaryLike} text */
const hash = text => createHash('sha256').update(text).digest('hex');
/** @type {Map<string, {source: string, original: string}>} */
const seen = new Map();
const pending = [path.join(root, 'src/components/utils/monacoRuntimeImpl.ts')];
/** @type {Array<{file: string, spec: string}>} */
const missing = [];
/** @type {Array<{file: string, expression: string}>} */
const dynamicImports = [];
/** @type {Array<{file: string, spec: string}>} */
const skippedWorkerImports = [];
while (pending.length) {
  const file = /** @type {string} */ (pending.pop());
  if (seen.has(file)) continue;
  const original = fs.readFileSync(file, 'utf8');
  const source = file.endsWith('.js') ? pruneUnusedMonacoDiffWidgets(original, file) || original : original;
  seen.set(file, { source, original });
  if (!/\.[jt]s$/.test(file)) continue;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  /** @type {string[]} */
  const specs = [];
  /** @param {import('typescript').Node} node */
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
      else dynamicImports.push({ file: path.relative(root, file), expression: node.getText(parsed) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (let spec of specs) {
    if (spec.includes('?worker')) { skippedWorkerImports.push({ file: path.relative(root, file), spec }); continue; }
    spec = spec.split('?')[0];
    /** @type {string | null | undefined} */
    let target = spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : spec.startsWith('monaco-editor/esm/') ? path.join(root, 'node_modules', spec) : null;
    if (!target || !(target.startsWith(base) || target.endsWith('/monacoQuickInput.css'))) continue;
    if (!fs.existsSync(target)) target = ['.js', '.css', '.ts'].map(ext => target + ext).find(fs.existsSync);
    if (target) pending.push(target); else missing.push({ file: path.relative(root, file), spec });
  }
}
/** @type {Record<string, string>} */
const names = {};
/** @type {Record<string, string | number | undefined>} */
const codes = {};
for (const file of ['codiconsLibrary.js', 'codicons.js']) {
  const source = fs.readFileSync(path.join(base, 'vs/base/common', file), 'utf8');
  for (const match of source.matchAll(/(\w+): register\('([^']+)', (0x[0-9a-f]+|'[^']+')\)/g)) {
    names[match[1]] = match[2];
    codes[match[2]] = match[3].startsWith('0x') ? parseInt(match[3], 16) : match[3].slice(1, -1);
  }
}
/** @type {Set<string>} */
const props = new Set();
/** @type {Set<string>} */
const ids = new Set();
/** @type {Array<{file: string, variable: string, id: string, target: string}>} */
const aliases = [];
/** @type {Array<{file: string, id: string}>} */
const cssReferences = [];
/** @type {Array<{file: string, id: string}>} */
const textReferences = [];
/** @type {string[]} */
const dynamicConsumers = [];
/** @type {Array<{file: string, properties: string[]}>} */
const propertyFiles = [];
/** @type {Record<string, string>} */
const aliasVariables = {};
for (const [file, { source }] of seen) {
  if (/\/codicons(?:Library)?\.js$|\/codiconsUtil\.js$/.test(file)) continue;
  const relative = path.relative(root, file);
  const localProps = [...source.matchAll(/Codicon\.([A-Za-z0-9_]+)/g)].map(match => match[1]);
  localProps.forEach(prop => props.add(prop));
  if (localProps.length) propertyFiles.push({ file: relative, properties: [...new Set(localProps)] });
  for (const match of source.matchAll(/(\w+)\s*=\s*registerIcon\('([^']+)',\s*(Codicon\.\w+|\w+)/g)) {
    aliases.push({ file: relative, variable: match[1], id: match[2], target: match[3] });
    aliasVariables[match[1]] = match[2];
    ids.add(match[2]);
  }
  for (const match of source.matchAll(/codicon-([a-z][a-z0-9-]+)/g)) {
    if (['modifier-', 'modifier-spin', 'spin'].includes(match[1])) continue;
    ids.add(match[1]); cssReferences.push({ file: relative, id: match[1] });
  }
  for (const match of source.matchAll(/--vscode-icon-([a-z][a-z0-9-]*)-(?:content|font-family)/g)) ids.add(match[1]);
  for (const match of source.matchAll(/\$\(([a-z][a-z0-9-]*)(?:~[a-z]+)?\)/g)) {
    // glob.js documents a basename interpolation token, not an icon.
    if (file.endsWith('/base/common/glob.js') && match[1] === 'basename') continue;
    ids.add(match[1]); textReferences.push({ file: relative, id: match[1] });
  }
  if (/ThemeIcon\.fromId|renderLabelWithIcons|supportThemeIcons/.test(source)) dynamicConsumers.push(relative);
}
for (const prop of props) ids.add(names[prop]);
for (const alias of aliases) codes[alias.id] = alias.target.startsWith('Codicon.') ? names[alias.target.slice(8)] : aliasVariables[alias.target];
/** @param {string} id @param {Set<string>} [ancestry] @returns {number | undefined} */
const resolveCode = (id, ancestry = new Set()) => {
  if (ancestry.has(id)) throw new Error(`cyclic alias ${id}`);
  const value = codes[id];
  return typeof value === 'string' ? resolveCode(value, new Set([...ancestry, id])) : value;
};
/** @param {number | undefined} code @returns {code is number} */
const isFiniteCode = code => typeof code === 'number' && Number.isFinite(code);
const glyphs = [...new Set([...ids].map(id => resolveCode(id)).filter(isFiniteCode))].sort((a, b) => a - b);
const files = [...seen].map(([file, value]) => ({ file: path.relative(root, file), sha256: hash(value.original), analyzedSha256: hash(value.source) })).sort((a, b) => a.file.localeCompare(b.file));
const report = {
  scope: 'Conservative static import closure; applies reviewed native Diff factory removal; excludes worker entry points. Counts include unused exports within imported modules.',
  moduleCount: seen.size, codiconPropertyCount: props.size, referencedIdCount: ids.size, distinctGlyphCount: glyphs.length,
  missingImports: missing, dynamicImports, skippedWorkerImports,
  unresolvedIds: [...ids].filter(id => resolveCode(id) === undefined),
  properties: [...props].sort(), ids: [...ids].sort(), glyphCodepoints: glyphs.map(code => '0x' + code.toString(16)),
  aliases, cssReferences, textReferences, dynamicConsumers, propertyFiles, files,
  sourceGuard: { entry: 'src/components/utils/monacoRuntimeImpl.ts', dependencyLayout: files, adapter: { file: 'scripts/vite/monaco-single-editor.mjs', sha256: hash(fs.readFileSync(path.join(root, 'scripts/vite/monaco-single-editor.mjs'))) } },
  caution: 'A safe allowlist must regenerate/compare the entire module set and all source hashes, reject missing or nonliteral imports, and separately review dynamic consumers. This inventory alone is not that proof.'
};
return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await collectMonacoIconScope(process.argv[2]), null, 2));
