import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// editorTransferFolding uses only these reviewed, already loaded native model APIs.
// An upgrade must review ownership, memento checksums, event ordering and region packing.
/** @type {Record<string, string>} */
const sources = {
    'folding.js': '5f4f7be5e77600bd46cde33d08e23d6b0169e8c8a53b7ce9b0bb2eb60dbb951c',
    'foldingModel.js': '5b02087c2785f09b3c3d4690f03d8925c9dfb9461a8eac176ab967c3e2c9b555',
    'foldingRanges.js': '9d59b8356af764cd7a5956d1d1ebaaaae15e179fd6f1946851044ae3c8d183d3',
    'hiddenRangeModel.js': '906bcb68b7c41a55cba2c65ac2b86c45d6a075439506025014b01b4fff7248ce',
};

/** @param {string} name @param {string} source */
export const assertMonacoTransferFoldingSource = (name, source) => {
    if (!Object.hasOwn(sources, name) || createHash('sha256').update(source).digest('hex') !== sources[name]) {
        throw new Error(`[monaco-transfer-folding] Review the installed Monaco ${name} contract before using transfer folding.`);
    }
};

export const verifyMonacoTransferFoldingContract = () => {
    const root = dirname(createRequire(import.meta.url).resolve('monaco-editor/package.json'));
    for (const name of Object.keys(sources)) {
        assertMonacoTransferFoldingSource(name, readFileSync(join(root, 'esm/vs/editor/contrib/folding/browser', name), 'utf8'));
    }
};
