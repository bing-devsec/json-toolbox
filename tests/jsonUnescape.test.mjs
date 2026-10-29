import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';

const { unescapeJsonText } = await bundleModule('src/components/utils/jsonUnescape.ts');
const options = { indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true };
const positions = {
    root: { wrap: value => JSON.stringify(value), read: value => value },
    array: { wrap: value => JSON.stringify([value]), read: value => value[0] },
    field: { wrap: value => JSON.stringify({ payload: value, stats: { ok: true } }), read: value => value.payload },
};
function run(input, recursive = true, extra = {}) {
    const result = unescapeJsonText(input, { ...options, recursive, ...extra });
    assert.equal(result.ok, true, JSON.stringify(result));
    return { ...result, value: JSON.parse(result.text) };
}
function expectAtEachPosition(source, expected, recursive) {
    for (const [name, { wrap, read }] of Object.entries(positions)) {
        const result = run(wrap(source), recursive);
        assert.deepEqual(read(result.value), expected, `${name}, recursive=${recursive}`);
        if (name === 'field') assert.deepEqual(result.value.stats, { ok: true });
    }
}
const reported = String.raw`[
  "{\\\"payload\\\":{\\\"title\\\":\\\"多行字符串中的JSON\\\",\\\"nested\\\":{\\\"note\\\":\\\"第一行\\\\n第二行\\\"}},\\\"stats\\\":{\\\"ok\\\":true}}",
  "\"\""
]`;
for (const recursive of [false, true]) {
    test(`reported mixed array decodes its empty-string element, recursive=${recursive}`, () => {
        assert.deepEqual(run(reported, recursive).value, [
            { payload: { title: '多行字符串中的JSON', nested: { note: '第一行\n第二行' } }, stats: { ok: true } },
            '',
        ]);
    });
    test(`quoted strings decode equally at root, array and field, recursive=${recursive}`, () => {
        for (const value of ['', 'hello', ' 中文😀 ', '123', 'true', 'false', 'null', '001', '1.2300', '9007199254740993']) {
            expectAtEachPosition(JSON.stringify(value), value, recursive);
        }
    });
    test(`ordinary scalar-looking strings retain their type everywhere, recursive=${recursive}`, () => {
        for (const value of ['123', '-42', 'true', 'false', 'null', '001', '+1', '1.2300', '1e-30', '9007199254740993']) {
            expectAtEachPosition(value, value, recursive);
        }
    });
    test(`business escapes survive decoding a quoted string, recursive=${recursive}`, () => {
        for (const value of ['C:\\logs\\orders\\', '\\\\server\\share\\', '\\d+\\s*', 'first\nsecond\tend', String.raw`literal \n \u0041 \x41`, '客服说："明天送达"；} ]']) {
            expectAtEachPosition(JSON.stringify(value), value, recursive);
        }
    });
    test(`incomplete quoted or container text remains unchanged, recursive=${recursive}`, () => {
        for (const value of ['"hello" trailing', '"unfinished', '{"id":1,', '[1,2', String.raw`prose with \"quoted\" words`, String.raw`{\"id\":1,}` + ' trailing']) {
            expectAtEachPosition(value, value, recursive);
        }
    });
    test(`container escape decoding is equivalent everywhere, recursive=${recursive}`, () => {
        const original = { label: '中文😀', path: 'C:\\logs\\', line: 'first\nsecond', rows: [1, true, null] };
        const source = JSON.stringify(original);
        for (const escaped of [source, JSON.stringify(source).slice(1, -1)]) {
            expectAtEachPosition(escaped, original, recursive);
        }
    });
    test(`special property names are data throughout traversal, recursive=${recursive}`, () => {
        const source = '{"__proto__":{"keep":true},"constructor":1,"prototype":2,"safe":3}';
        const expected = JSON.parse(source);
        assert.deepEqual(run(source, recursive).value, expected);
        expectAtEachPosition(source, expected, recursive);
        assert.equal(Object.hasOwn(Object.prototype, 'keep'), false);
    });
    test(`numbers retain exact lexical spelling across decoded layers, recursive=${recursive}`, () => {
        const source = '{"id":9007199254740993,"price":1.2300,"tiny":1e-30,"stats":{"ok":true}}';
        for (const { wrap } of Object.values(positions)) {
            const result = run(wrap(source), recursive);
            for (const literal of ['9007199254740993', '1.2300', '1e-30']) assert(result.text.includes(literal));
            assert(!/[\uE000-\uE7FF]/u.test(result.text));
        }
    });
    test(`cross-layer Unicode placeholders keep distinct keys and values, recursive=${recursive}`, () => {
        const source = String.raw`{"\u0061":"\u0041","b":"\u0042","hex":"\x41","__proto__":{"keep":true}}`;
        const input = '{"outer":"\\u0043","payload":' + JSON.stringify(source) + '}';
        const result = run(input, recursive);
        assert.deepEqual(result.value, { outer: 'C', payload: JSON.parse('{"a":"A","b":"B","hex":"\\\\x41","__proto__":{"keep":true}}') });
        for (const spelling of [String.raw`\u0061`, String.raw`\u0041`, String.raw`\u0042`, String.raw`\u0043`]) assert(result.text.includes(spelling));
        assert(!/[\uE000-\uE7FF]/u.test(result.text));
    });
}
for (const value of ['', '123', 'hello', { id: 1 }, [1, 'text']]) {
    test(`recursive decoding follows every explicit string wrapper: ${JSON.stringify(value)}`, () => {
        let source = JSON.stringify(value);
        for (let wrappers = 1; wrappers <= 4; wrappers++) {
            expectAtEachPosition(source, value, true);
            source = JSON.stringify(source);
        }
    });
}
test('single-round decoding stops before the next explicit string wrapper', () => {
    const value = { id: 1 };
    const source = JSON.stringify(JSON.stringify(value));
    expectAtEachPosition(source, JSON.stringify(value), false);
});
test('single-round mode does not recurse into a newly decoded container', () => {
    const source = JSON.stringify({ detail: JSON.stringify({ id: 1 }) });
    expectAtEachPosition(source, { detail: '{"id":1}' }, false);
    expectAtEachPosition(source, { detail: { id: 1 } }, true);
});
test('empty strings and whitespace-only strings are retained everywhere', () => {
    for (const recursive of [false, true]) for (const value of ['', ' ', '\t\n']) {
        expectAtEachPosition(value, value, recursive);
    }
});
test('actual primitive roots remain JSON primitives', () => {
    for (const value of [123, true, false, null]) {
        for (const recursive of [false, true]) assert.deepEqual(run(JSON.stringify(value), recursive).value, value);
    }
});
test('invalid outer JSON and illegal escapes continue to be rejected', () => {
    for (const [input, code] of [
        ['{"id":1 "stats":true}', 'invalid-json'],
        [String.raw`{\"id\":1}`, 'invalid-json'],
        [String.raw`{"text":"\q"}`, 'illegal-escape'],
    ]) {
        const result = unescapeJsonText(input, { ...options, recursive: true });
        assert.equal(result.ok, false);
        assert.equal(result.code, code);
    }
});
test('existing iteration and depth budgets still bound recursive expansion', () => {
    const source = JSON.stringify(JSON.stringify({ id: 1 }));
    const input = JSON.stringify(source);
    assert.equal(run(input, true, { maxParseIterations: 1 }).value, '{"id":1}');
    assert.deepEqual(run(input, true, { maxParseIterations: 2 }).value, { id: 1 });
    const deep = JSON.stringify({ a: { payload: '{"id":1}' } });
    assert.deepEqual(run(deep, true, { maxDepth: 1 }).value, { a: { payload: '{"id":1}' } });
});

// Transport escaping removes the surrounding quotes after each stringify.
// The outer document is still valid JSON; only its string values need decoding.
const encodeTransport = (source, layers) => {
    for (let i = 0; i < layers; i++) source = JSON.stringify(source).slice(1, -1);
    return source;
};
test('reported one- and two-layer transport strings both expand inside an array', () => {
    const input = String.raw`["{\\\"id\\\":1}","{\\\\\\\"id\\\\\\\":1}"]`;
    assert.deepEqual(run(input).value, [{ id: 1 }, { id: 1 }]);
});
for (let layers = 1; layers <= 4; layers++) {
    test(`recursive transport decoding handles ${layers} layers at every position`, () => {
        for (const value of [
            { id: 1, text: '中文😀', path: 'C:\\logs\\', note: 'first\nsecond', regex: '\\d+\\s*' },
            [{ id: 2 }, '', '123', 'true', null],
            '', 'hello', '123', 'true', 'null',
        ]) {
            expectAtEachPosition(encodeTransport(JSON.stringify(value), layers), value, true);
        }
    });
}
test('transport and complete string wrappers can alternate without changing values', () => {
    const value = { id: 1, path: 'C:\\data\\', note: 'say "hello"\nnext' };
    const patterns = [
        ['transport', 'quote', 'transport'],
        ['quote', 'transport', 'transport', 'quote'],
        ['transport', 'transport', 'quote', 'transport'],
    ];
    for (const pattern of patterns) {
        let source = JSON.stringify(value);
        for (const step of pattern) source = step === 'quote' ? JSON.stringify(source) : encodeTransport(source, 1);
        expectAtEachPosition(source, value, true);
    }
});
test('single-round mode retains multi-layer transport input until a complete result is available', () => {
    for (let layers = 2; layers <= 4; layers++) {
        const source = encodeTransport('{"id":1}', layers);
        expectAtEachPosition(source, source, false);
    }
    expectAtEachPosition(encodeTransport('{"id":1}', 1), { id: 1 }, false);
});
test('unsuccessful multi-layer lookahead never publishes a partially decoded value', () => {
    const sources = [
        'ordinary text with "quoted" words',
        '{"id":1,', '{"id":}', '[{"id":1}',
        '{"id":1} trailing', '"hello" trailing',
    ];
    for (const original of sources) for (let layers = 1; layers <= 4; layers++) {
        const source = encodeTransport(original, layers);
        expectAtEachPosition(source, source, true);
    }
});
test('multi-layer lookahead preserves exact numbers and special property names', () => {
    const source = '{"id":9007199254740993,"price":1.2300,"tiny":1e-30,"__proto__":{"keep":true}}';
    for (const {wrap,read} of Object.values(positions)) {
        const result=run(wrap(encodeTransport(source,4)));
        for (const literal of ['9007199254740993','1.2300','1e-30']) assert(result.text.includes(literal));
        assert.deepEqual(read(result.value).__proto__,{keep:true});
        assert.equal(Object.hasOwn(read(result.value),'__proto__'),true);
        assert.equal(Object.hasOwn(Object.prototype,'keep'),false);
    }
});
test('a failed transport candidate cannot corrupt adjacent Unicode escapes or successful values', () => {
    const broken = encodeTransport('{"note":"\\u0042","id":',3);
    const valid = encodeTransport(String.raw`{"note":"\u0043","id":1}`,3);
    const input = '{"outer":"\\u0041","bad":'+JSON.stringify(broken)+',"good":'+JSON.stringify(valid)+'}';
    const result = run(input);
    assert.deepEqual(result.value,{outer:'A',bad:broken,good:{note:'C',id:1}});
    assert(result.text.includes(String.raw`\u0041`));
    assert(result.text.includes(String.raw`\u0043`));
    assert(!/[\uE000-\uE7FF]/u.test(result.text));
});
test('transport lookahead consumes the existing per-string iteration budget', () => {
    const source=encodeTransport('{"id":1}',2);
    for(const {wrap,read} of Object.values(positions)) {
        assert.equal(read(run(wrap(source),true,{maxParseIterations:1}).value),source);
        assert.deepEqual(read(run(wrap(source),true,{maxParseIterations:2}).value),{id:1});
        const wrapped=JSON.stringify(source);
        assert.equal(read(run(wrap(wrapped),true,{maxParseIterations:2}).value),source);
        assert.deepEqual(read(run(wrap(wrapped),true,{maxParseIterations:3}).value),{id:1});
    }
});


test('unescape output preserves numeric negative zero through nested and transport-encoded containers', () => {
    const source='{"negative":-0,"positive":0,"decimal":2.0,"fractionZero":-0.00}';
    const expected=JSON.parse(source);
    for (const recursive of [false,true]) {
        assert.equal(run('-0',recursive).text,'-0');
        for (const {wrap,read} of Object.values(positions)) {
            const result=run(wrap(source),recursive);
            assert.deepEqual(read(result.value),expected);
            assert.match(result.text,/"negative": -0,/);
            assert.match(result.text,/"decimal": 2\.0,/);
            assert.match(result.text,/"fractionZero": -0\.00/);
        }
    }
    for (const {wrap,read} of Object.values(positions)) {
        const result=run(wrap(encodeTransport(source,3)));
        assert.deepEqual(read(result.value),expected);
        assert.match(result.text,/"negative": -0,/);
    }
});

test('negative-zero text and keys stay strings during unescape', () => {
    for (const recursive of [false,true]) for (const source of ['-0','0','-0.0']) {
        expectAtEachPosition(source,source,recursive);
        expectAtEachPosition(JSON.stringify(source),source,recursive);
    }
    assert.deepEqual(run('{"-0":"-0","zero":0}').value,{'-0':'-0',zero:0});
});


const escapedPathComments = [
    String.raw`// 日志路径 C:\work\demo \q \uZZZZ \xGG " '`+'\n',
    String.raw`/* 日志路径 C:\work\demo \q \uZZZZ \xGG " ' */`,
    String.raw`# 日志路径 C:\work\demo \q \uZZZZ \xGG " '`+'\n',
];
for (const recursive of [false,true]) {
    test(`reported comment path no longer blocks unescape, recursive=${recursive}`, () => {
        const input=String.raw`// 日志路径 C:\work\demo
{
  "payload": "{\"id\":1}",
  "stats": {
    "ok": true
  }
}`;
        assert.deepEqual(run(input,recursive).value,{payload:{id:1},stats:{ok:true}});
    });
    test(`outer comment styles and positions do not affect unescape, recursive=${recursive}`, () => {
        const body='"payload":"{\\"id\\":1}","stats":{"ok":true}';
        for(const comment of escapedPathComments) {
            for(const input of [comment+'{'+body+'}', '{'+body+'}'+comment, '{'+comment+body+'}']) {
                assert.deepEqual(run(input,recursive).value,{payload:{id:1},stats:{ok:true}});
            }
        }
    });
    test(`nested JSON documents with leading, inner or trailing comments expand, recursive=${recursive}`, () => {
        for(const comment of escapedPathComments) {
            for(const source of [comment+'{"id":1}', '{'+comment+'"id":1}', '{"id":1}'+comment]) {
                expectAtEachPosition(source,{id:1},recursive);
            }
        }
    });
    test(`real illegal escapes are still rejected after comments, recursive=${recursive}`, () => {
        for(const comment of escapedPathComments) for(const value of [
            String.raw`http://host/\q`, String.raw`/* \q */`, String.raw`# \q`,String.raw`\uZZZZ`,String.raw`\xG1`,
        ]) {
            const result=unescapeJsonText(comment+'{"text":"'+value+'"}',{...options,recursive});
            assert.equal(result.ok,false);
            assert.equal(result.code,'illegal-escape');
        }
    });
    test(`URLs and comment markers inside strings are preserved, recursive=${recursive}`, () => {
        const text='https://host/a//b /* literal \\q */ # \\uZZZZ';
        const input=escapedPathComments[0]+JSON.stringify({text,payload:'{"id":1}'});
        assert.deepEqual(run(input,recursive).value,{text,payload:{id:1}});
    });
}
test('recursive unescape combines comment-aware documents and multi-layer transport', () => {
    const inner=escapedPathComments[0]+'{"id":1,"zero":-0,"decimal":2.0}'+escapedPathComments[1];
    for (let layers=1;layers<=3;layers++) {
        const input=JSON.stringify({payload:encodeTransport(inner,layers),stats:{ok:true}});
        const result=run(input);
        assert.deepEqual(result.value,{payload:{id:1,zero:-0,decimal:2},stats:{ok:true}});
        assert.match(result.text,/"zero": -0,/);
        assert.match(result.text,/"decimal": 2\.0/);
    }
});
test('comment handling does not turn malformed nested strings into repaired data', () => {
    const bad=escapedPathComments[0]+'{"id":1 "other":2}';
    const invalidEscape=escapedPathComments[1]+String.raw`{"text":"http://host/\q"}`;
    const input=JSON.stringify({good:escapedPathComments[0]+'{"id":1}',bad,invalidEscape,stats:{ok:true}});
    assert.deepEqual(run(input).value,{good:{id:1},bad,invalidEscape,stats:{ok:true}});
});
test('comment-aware checking preserves compatible line continuations', () => {
    for(const quote of ['"',"'"]) for(const newline of ['\n','\r\n','\u2028','\u2029']) {
        const input='{text:'+quote+'first\\'+newline+'second'+quote+',payload:"{\\"id\\":1}"}';
        assert.deepEqual(run(input).value,{text:'firstsecond',payload:{id:1}});
    }
});
