import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Compact snapshots captured before extracting the shared mapping. Deliberate palette
// changes should update these hashes after reviewing the complete variable-map diff.
const expected = {
    "default/light": "b55f312e60b7b9863c162887f4e769514eb2eec135e59444bf02fced939dd548",
    "default/dark": "1b7d1deffcb3fc51f64e9db82ac2f6524257b87a36aa6acc99cbda9bfd5c9771",
    "ide/light": "5beeb58817ecc62264f5289e7a0e705495740ba6adf13f7e07cb9881bd07532c",
    "ide/dark": "8213d694053fb9b62f273b803aefb223575a8ebc7e6f9c09b08745ab71ccc89f",
    "glass/light": "72fb89796dc45cd903db9d387f451640697ede5d669aa29c17469c0bfd1fc497",
    "glass/dark": "56af92826d8ed1161e97be5e8a73aaa37b0a6ff217851e3f258a8131f95542cc",
    "retro/light": "4a1d2622c57e2d0a3960eef393dad994251f72a6e2bcbd07455fc0ba8bb47f0f",
    "retro/dark": "585f3cc55e0dff4d144c3ed747e0dda98ea781da2e4a4eb35cd28d472092bd6d",
    "paper/light": "cccd119f07d41fa509f20863015a67975e8eb5dd5281ad2d23615b7c5e1798a0",
    "paper/dark": "30a719a00d2ce6b9b72615c200edc18f5fa1befff2686f6d60e0417c0c189ac4"
};
const bundle = await build({ entryPoints: ['src/themes/registry.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports });

for (const [appearance, hash] of Object.entries(expected)) {
    test(appearance + ' preserves its complete pre-refactor variable map', () => {
        const [style, mode] = appearance.split('/');
        const variables = module.exports.getInterfaceVariables(style, mode);
        const entries = Object.entries(variables).sort(([a], [b]) => a.localeCompare(b));
        assert.equal(createHash('sha256').update(JSON.stringify(entries)).digest('hex'), hash);
    });
}
