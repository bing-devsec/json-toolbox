import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { computeLineDiff as normalDiff } from '../src/components/utils/diffEngine.ts';

const built = await build({
    stdin: { contents: `export { computeLineDiff } from './src/components/utils/diffEngine';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'fail-histogram-only', setup(build) {
        build.onResolve({ filter: /^histogram-diff$/ }, () => ({ path: 'histogram', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const histogramDiff = () => { throw Error("Controlled histogram failure"); };' }));
    } }],
});
const module = { exports: {} };
runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, console });
const fallback = (left, right) => JSON.parse(JSON.stringify(module.exports.computeLineDiff(left, right, { exact: true })));
const reconstruct = (left, right, changes) => {
    let cursor = 0, previousRightEnd = 0;
    const result = [];
    for (const change of changes) {
        const { originalStartLineNumber: a, originalEndLineNumber: ae, modifiedStartLineNumber: b, modifiedEndLineNumber: be } = change;
        assert.ok(a >= cursor + 1 && a <= left.length + 1);
        assert.ok(ae >= a - 1 && ae <= left.length);
        assert.ok(b >= previousRightEnd + 1 && b <= right.length + 1);
        assert.ok(be >= b - 1 && be <= right.length);
        result.push(...left.slice(cursor, a - 1), ...right.slice(b - 1, be));
        cursor = ae; previousRightEnd = be;
    }
    result.push(...left.slice(cursor));
    assert.deepEqual(result, right);
};

test('small histogram failures retain the existing LCS grouping and exact insertion/deletion boundaries', () => {
    const cases = [
        [[], ['a']], [['a'], []], [['a'], ['b']],
        [['a', 'b', 'c'], ['a', 'x', 'c']],
        [['a', 'b', 'c'], ['a', 'new', 'b', 'c']],
        [['a', 'b', 'c'], ['a', 'c']],
    ];
    for (const [left, right] of cases) {
        const changes = fallback(left, right);
        assert.deepEqual(changes, normalDiff(left, right, { exact: true }));
        reconstruct(left, right, changes);
    }
});

test('oversized recovery matrices retain common edges and report one bounded, reconstructable window', () => {
    const left = ['prefix', ...Array.from({ length: 1000 }, (_, i) => `left-${i}`), 'suffix'];
    const right = ['prefix', ...Array.from({ length: 1500 }, (_, i) => `right-${i}`), 'suffix'];
    const changes = fallback(left, right);
    assert.deepEqual(changes, [{ originalStartLineNumber: 2, originalEndLineNumber: 1001, modifiedStartLineNumber: 2, modifiedEndLineNumber: 1501 }]);
    reconstruct(left, right, changes);
});

test('budgeted recovery handles extreme asymmetry, empty sides and preserved surrounding rows', () => {
    const rows = Array.from({ length: 130000 }, (_, i) => `row-${i}`);
    for (const [left, right] of [[rows, ['replacement']], [['replacement'], rows], [rows, []], [[], rows]]) {
        const changes = fallback(left, right);
        assert.equal(changes.length, 1);
        // Avoid a spread-argument limit in the verification helper for huge pure insertion.
        const c = changes[0];
        const rebuilt = left.slice(0, c.originalStartLineNumber - 1).concat(right.slice(c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber), left.slice(c.originalEndLineNumber));
        assert.deepEqual(rebuilt, right);
        assert.ok(c.originalStartLineNumber >= 1 && c.originalEndLineNumber <= left.length);
        assert.ok(c.modifiedStartLineNumber >= 1 && c.modifiedEndLineNumber <= right.length);
    }
});

test('bounded small fallback preserves exact reconstruction across repeated and Unicode lines', () => {
    let seed = 31;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const tokens = ['a', 'b', '中文', '🙂', '', 'same', 'a  b'];
    for (let trial = 0; trial < 100; trial++) {
        const left = Array.from({ length: random() % 20 }, () => tokens[random() % tokens.length]);
        const right = Array.from({ length: random() % 20 }, () => tokens[random() % tokens.length]);
        reconstruct(left, right, fallback(left, right));
    }
});

test('the cell budget boundary keeps small internal matches and coarsens only oversized failed windows', () => {
    for (const [length, expectedBlocks] of [[499, 2], [500, 1]]) {
        const middle = Array.from({ length: length - 2 }, (_, i) => `shared-${i}`);
        const left = ['left-start', ...middle, 'left-end'];
        const right = ['right-start', ...middle, 'right-end'];
        const changes = fallback(left, right);
        assert.equal(changes.length, expectedBlocks);
        reconstruct(left, right, changes);
    }
});
