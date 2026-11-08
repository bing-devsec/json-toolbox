import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { transform } from 'esbuild';

// Run selected real script-setup declarations, supplying external dependencies explicitly.
export async function vueDeclarations(file, names, globals = {}) {
    const source = readFileSync(file, 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0];
    const tree = ts.createSourceFile(file + '.ts', source, ts.ScriptTarget.Latest, true);
    const selected = tree.statements.filter(node => {
        if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(tree)));
        return ts.isFunctionDeclaration(node) && names.includes(node.name?.text);
    });
    const found = selected.map(node => node.getText(tree)).join('\n');
    const { code } = await transform(found + '\nmodule.exports = {' + names.join(',') + '};', { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, Error, TypeError, URL, URLSearchParams, TextEncoder, AbortController, ...globals });
    return module.exports;
}
