import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';

const { detectIllegalEscapes } = await bundleModule('src/components/utils/jsonStructure.ts');
const jsonCheck = source => detectIllegalEscapes(source, 'json');

const comments = [
    String.raw`// C:\work\demo \q \uZZZZ \xGG " '` + '\n',
    String.raw`/* C:\work\demo \q \uZZZZ \xGG " ' */`,
    String.raw`# C:\work\demo \q \uZZZZ \xGG " '` + '\n',
];
for (const [index, comment] of comments.entries()) {
    test(`JSON document checking ignores escapes in comment style ${index}`, () => {
        for (const source of [comment+'{"id":1}', '{"id":1}'+comment, '{'+comment+'"id":1}']) {
            assert.deepEqual(jsonCheck(source), {hasIllegal:false,details:[]});
        }
    });
    test(`real invalid strings following comment style ${index} are still rejected`, () => {
        const source = comment+String.raw`{"bad":"\q","ok":"\\q"}`;
        assert.deepEqual(jsonCheck(source), {hasIllegal:true,details:[String.raw`非法转义序列: \q`]});
    });
}
test('comment-like content inside real strings cannot hide illegal escapes', () => {
    for (const source of [
        String.raw`{"text":"http://host/\q"}`,
        String.raw`{"text":"/* \q */"}`,
        String.raw`{"text":"# \q"}`,
        String.raw`{"text":"say \"//\q\" end"}`,
        String.raw`{'text':'http://host/\q'}`,
        String.raw`{"text":"\u12"}`,
        String.raw`{"text":"\xG1"}`,
    ]) assert.equal(jsonCheck(source).hasIllegal,true,source);
});
test('valid escaped backslashes, quotes, URLs and comment markers remain ordinary data', () => {
    for (const text of [
        'C:\\work\\demo', 'http://host/\\q', '/* \\uZZZZ */', '# \\xGG',
        'say "// \\q" end', "single ' and double \" quotes", '\\\\server\\share\\',
    ]) assert.deepEqual(jsonCheck(JSON.stringify({text})), {hasIllegal:false,details:[]});
});
test('backslash parity is respected within quoted JSON strings', () => {
    for (let count=0;count<=7;count++) {
        const source='{"text":"'+'\\'.repeat(count)+'q"}';
        assert.equal(jsonCheck(source).hasIllegal,count%2===1,source);
    }
});
test('string-content checking retains its original scope and rejection policy', () => {
    for (const source of [String.raw`http://host/\q`,String.raw`/* \q */`,String.raw`# \q`]) {
        assert.equal(detectIllegalEscapes(source).hasIllegal,true);
        assert.deepEqual(detectIllegalEscapes(source,'text'),detectIllegalEscapes(source));
    }
    assert.equal(jsonCheck(String.raw`{text:'don\'t'}`).hasIllegal,true,'this change does not broaden other escape policies');
});
test('the checker retains existing JSON5 line-continuation handling', () => {
    for (const quote of ['"',"'"]) for (const newline of ['\n','\r\n','\u2028','\u2029']) {
        const source='{text:'+quote+'first\\'+newline+'second'+quote+'}';
        assert.equal(detectIllegalEscapes(source).hasIllegal,false);
        assert.equal(jsonCheck(source).hasIllegal,false);
    }
});
