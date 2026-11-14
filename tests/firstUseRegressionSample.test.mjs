import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';
import { getFirstUseRegressionSampleJson } from './fixtures/firstUseRegressionSample.ts';

const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/index.ts');
const { unescapeJsonText } = await bundleModule('src/components/utils/jsonUnescape.ts');

for (const locale of ['zh', 'en']) {
    test(`preserved ${locale} full regression fixture retains JSON5 edge-case coverage`, () => {
        const formatted = formatJsonInput(getFirstUseRegressionSampleJson(locale), options).formatted;
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
        assert.equal(data.arrayCases[3], null);
        assert.deepEqual(data.users.map(user => user.id), [3, 1, 2]);
        assert.equal(data.specialValueCases.nestedUndefined.c.d, null);
        assert.equal(data.duplicateKeyCases.duplicated, null);
        assert.equal(typeof data.recursiveEscapedJson, 'string');
        assert.equal(typeof data.recursiveEscapedJsonArray, 'string');

        const result = unescapeJsonText(formatted, { ...options, recursive: true });
        assert.equal(result.ok, true);
        const decoded = JSON.parse(result.text);
        assert.equal(decoded.recursiveEscapedJson.payload.english, 'hello recursive escape');
        assert.equal(decoded.recursiveEscapedJson.payload.unicode, '你好');
        assert.equal(decoded.recursiveEscapedJsonArray[0].message, 'English text');
    });
}
