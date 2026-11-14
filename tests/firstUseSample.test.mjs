import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';
import { FIRST_USE_SAMPLE_JSON_ZH, FIRST_USE_SAMPLE_JSON_EN, getFirstUseSampleJson } from '../src/components/utils/firstUseSampleJson.ts';
import { getRecursiveUnescapeSampleJson } from './fixtures/recursiveUnescapeSample.ts';
import { getFirstUseRegressionSampleJson } from './fixtures/firstUseRegressionSample.ts';

const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/index.ts');
const { unescapeJsonText } = await bundleModule('src/components/utils/jsonUnescape.ts');
const users = [
    { id: 3, name: 'Charlie', score: 88.5, tags: ['json', 'json5', 'comment'], extra: null },
    { id: 1, name: 'Alice', score: 100, tags: ['alpha', 'beta'], extra: null },
    { id: 2, name: 'Bob', score: 0.75, tags: [], extra: null },
];

for (const locale of ['zh', 'en']) {
    const message = locale === 'en' ? 'Hello, JSON!' : '你好，JSON！';
    const decodedGuideExample = { payload: { details: { message, tags: ['json', 'demo'] } } };

    test('first-use ' + locale + ' sample restores the original complete demo and formats through the real engine', () => {
        const source = getFirstUseSampleJson(locale);
        assert.equal(source, getFirstUseRegressionSampleJson(locale));
        assert.throws(() => JSON.parse(source));
        const formatted = formatJsonInput(source, options).formatted;
        const data = JSON.parse(formatted);
        assert.equal(data.metadata.name, 'JSON5 regression fixture');
        assert.equal(data.undefined, null);
        assert.equal(data.stringUndefinedCases.normal, 'undefined');
        assert.equal(data.commentCases.hashAfterValue, 3);
        assert.equal(data.numberCases.hex, 16);
        assert.equal(data.numberCases.negativeHex, -32);
        assert.equal(data.numberCases.infinity, null);
        assert.equal(data.numberCases.nanValue, null);
        assert(formatted.includes('900719925474099312345'));
        assert(formatted.includes('1.23000000000000000001'));
        assert.equal(data.stringCases.backslash, 'C:\\Users\\test\\file.json');
        assert.equal(data.stringCases.unicodeEscaped, '你好');
        assert.deepEqual(data.users, users);
        assert.equal(data.arrayCases[3], null);
        assert.equal(data.duplicateKeyCases.duplicated, null);
        assert.equal(typeof data.recursiveEscapedJson, 'string');
        assert.equal(typeof data.recursiveEscapedJsonArray, 'string');
    });

    test('recursive ' + locale + ' fixture covers three-layer decoding independently of the walkthrough', () => {
        const source = getRecursiveUnescapeSampleJson(locale);
        const outer = JSON.parse(source);
        assert.equal(typeof outer.payload, 'string');
        const middle = JSON.parse(outer.payload);
        assert.equal(typeof middle.details, 'string');
        const inner = JSON.parse(middle.details);
        assert.equal(inner.message, message);
        assert.equal(typeof inner.tags, 'string');
        assert.deepEqual(JSON.parse(inner.tags), ['json', 'demo']);

        const recursive = unescapeJsonText(source, { ...options, recursive: true });
        assert.equal(recursive.ok, true);
        assert.deepEqual(JSON.parse(recursive.text), decodedGuideExample);
        const shallow = unescapeJsonText(source, { ...options, recursive: false });
        assert.equal(shallow.ok, true);
        assert.equal(typeof JSON.parse(shallow.text).payload.details, 'string');
    });

    test('first-use ' + locale + ' full demo retains nested object and array escape examples', () => {
        const formatted = formatJsonInput(getFirstUseSampleJson(locale), options).formatted;
        const before = JSON.parse(formatted);
        const result = unescapeJsonText(formatted, { ...options, recursive: true });
        assert.equal(result.ok, true);
        const data = JSON.parse(result.text);
        assert.deepEqual(data.recursiveEscapedJson.payload, { unicode: '你好', hex: "\\x48\\x65\\x6C\\x6C\\x6F", english: 'hello recursive escape' });
        assert.deepEqual(data.recursiveEscapedJsonArray, [{ message: 'English text', unicode: '世界', hex: "\\x4A\\x53\\x4F\\x4E" }]);
        assert.deepEqual(data.users, before.users);
        assert.deepEqual(data.metadata, before.metadata);
        assert.deepEqual(data.specialValueCases, before.specialValueCases);
        assert.equal(data.stringUndefinedCases.normal, 'undefined');
    });
}

test('first-use sample defaults to Chinese and preserves both public locale constants', () => {
    assert.equal(getFirstUseSampleJson(), FIRST_USE_SAMPLE_JSON_ZH);
    assert.equal(getFirstUseSampleJson('zh'), FIRST_USE_SAMPLE_JSON_ZH);
    assert.equal(getFirstUseSampleJson('en'), FIRST_USE_SAMPLE_JSON_EN);
    assert.equal(getRecursiveUnescapeSampleJson(), getRecursiveUnescapeSampleJson('zh'));
    assert.notEqual(FIRST_USE_SAMPLE_JSON_EN, FIRST_USE_SAMPLE_JSON_ZH);
});
