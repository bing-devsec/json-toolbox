import assert from 'node:assert/strict';
import test from 'node:test';
import { detectIndentSize, reformatJsonIndentation } from '../src/components/utils/indentUtils.ts';

test('indent detection retains ASCII-space, non-whitespace, minimum and fallback rules', () => {
    for (const [source, expected] of [
        ['', 4], ['no-indent\n\tfield\n\u00a0field', 4], ['  \tfield\n  \r\n', 4],
        ['    a\n  b\n      c', 2], ['        a', 8], ['         a', 4],
        ['                 a\n       b', 7], [' x\n  y', 1], ['  中文\r\n    🙂', 2],
        ['  \u2028field\n   value', 3],
    ]) assert.equal(detectIndentSize(source), expected, JSON.stringify(source));
    assert.equal(detectIndentSize('none', 6), 6);
});

test('indent rewriting preserves existing escape text and established whitespace behavior', () => {
    assert.equal(reformatJsonIndentation('{\n    "text": "a\\nb",\n        "nested": true\n}\n', 2), '{\n  "text": "a\\nb",\n    "nested": true\n}\n');
    assert.equal(reformatJsonIndentation('no-indent\n', 2), 'no-indent\n');
    assert.equal(reformatJsonIndentation('  value  \n \n', 2), '  value  \n \n', 'same indent returns original text');
    assert.equal(reformatJsonIndentation('    value  \n \n', 2), '  value\n\n');
});

test('200,000 indented lines rewrite without spread-argument overflow', () => {
    const source = '    "value",\n'.repeat(200000);
    assert.equal(detectIndentSize(source), 4);
    const rewritten = reformatJsonIndentation(source, 2);
    assert.equal(rewritten, '  "value",\n'.repeat(200000));
});

// The pre-optimization implementation is the compatibility oracle, including
// trim(), mixed whitespace, fractional indentation and String.repeat errors.
const legacyReformat = (source, target) => {
    const lines = source.split('\n');
    let current = Infinity;
    for (const line of lines) {
        if (!line.trim()) continue;
        const length = line.match(/^(\s*)/)[1].length;
        if (length > 0) current = Math.min(current, length);
    }
    if (current === Infinity || current === target) return source;
    return lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        const length = line.match(/^(\s*)/)[1].length;
        const level = length > 0 ? Math.floor(length / current) : 0;
        return ' '.repeat(level * target) + trimmed;
    }).join('\n');
};

const reformatOutcome = (fn, source, target) => {
    try { return { value: fn(source, target) }; }
    catch (error) { return { name: error.name, message: error.message }; }
};

test('indent rewrite preserves all JavaScript whitespace and invalid-target behavior', () => {
    const prefixes = ['', ' ', '  ', '   ', '    ', '\t', '\t  ', '\r', '\v', '\f',
        '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
        '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f',
        '\u205f', '\u3000', '\ufeff', '\u0085', '\u200b'];
    const bodies = ['', '{', '}', '"n": 900719925474099312345,', '"s": "\\u0041\\n \\t",',
        'true,', ' x  ', 'a\rb', '"  literal  "'];
    const targets = [-2, -1, 0, 0.5, 1, 1.5, 2, 2.25, 4, 8, NaN, Infinity, -Infinity, undefined, null, '2'];
    const check = source => {
        for (const target of targets) assert.deepEqual(
            reformatOutcome(reformatJsonIndentation, source, target),
            reformatOutcome(legacyReformat, source, target),
            JSON.stringify({ source, target }),
        );
    };
    for (const prefix of prefixes) for (const body of bodies) {
        check(prefix + body + '\n' + prefix + '\r\n' + prefix + body + '\n');
    }
    let seed = 0x41a731;
    const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let i = 0; i < 2500; i++) {
        let source = '';
        for (let line = random(12); line >= 0; line--) {
            source += prefixes[random(prefixes.length)] + bodies[random(bodies.length)]
                + prefixes[random(prefixes.length)] + (random(3) ? '\n' : '\r\n');
        }
        check(source);
    }
});

test('same indentation and no-indent transfers do not split the entire document', () => {
    const sources = [
        '{\n' + '  "id": 900719925474099312345,\r\n'.repeat(200000) + '  "text": "\\u0041\\n"  \n}',
        'no indentation\n'.repeat(200000),
        ' \t\r\n\u00a0\n'.repeat(200000),
        '',
    ];
    for (const source of sources) {
        const nativeSplit = String.prototype.split;
        String.prototype.split = function (...args) {
            assert.notEqual(String(this), source, 'no-op transfer must not allocate a per-line array');
            return nativeSplit.apply(this, args);
        };
        try { assert.equal(reformatJsonIndentation(source, 2), source); }
        finally { String.prototype.split = nativeSplit; }
    }
});

test('changed indentation scans without splitting the entire document', () => {
    const source = '{\n' + '    "value": "\\u0041\\n",\r\n'.repeat(200000) + '}';
    const expected = '{\n' + '  "value": "\\u0041\\n",\n'.repeat(200000) + '}';
    const nativeSplit = String.prototype.split;
    String.prototype.split = function (...args) {
        assert.notEqual(String(this), source, 'rewrite must not allocate a whole-document line array');
        return nativeSplit.apply(this, args);
    };
    try { assert.equal(reformatJsonIndentation(source, 2), expected); }
    finally { String.prototype.split = nativeSplit; }
});

test('batched indentation output preserves separators, empty lines and deep levels', () => {
    for (const count of [1023, 1024, 1025, 2047, 2048, 2049]) {
        for (const suffix of ['', '\n', '\n\t\r\u3000']) {
            const source = ' x\r\n' + '\t\r\u3000\n'.repeat(count)
                + (' '.repeat(128) + '"\\n \\u0041" \t\r\n').repeat(count) + '    tail  ' + suffix;
            for (const target of [0, 0.5, 2, 4]) {
                assert.equal(reformatJsonIndentation(source, target), legacyReformat(source, target));
            }
        }
    }
});

test('indent cache preserves coercion and errors for unusual non-number targets', () => {
    const sources = ['head\n    a\n    b\n    c\n', '\n\t\n    a\n', 'no indent\n'];
    for (const source of sources) {
        for (const target of [true, false, '', 'invalid', 0n, 2n, Symbol('indent'), new Number(2)]) {
            assert.deepEqual(reformatOutcome(reformatJsonIndentation, source, target), reformatOutcome(legacyReformat, source, target));
        }
        const runWithCoercion = fn => {
            let count = 0;
            const target = { valueOf() { return ++count === 4 ? -1 : count; } };
            return { result: reformatOutcome(fn, source, target), count };
        };
        assert.deepEqual(runWithCoercion(reformatJsonIndentation), runWithCoercion(legacyReformat));
    }
});
