import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { detectInputLanguage } from '../src/components/utils/common.ts';

const body = '{\n  "payload": "{\\"id\\":1}",\n  "stats": {\n    "ok": true\n  }\n}';

test('JSON highlighting stays JSON with the reported path comment at every position', () => {
    const comment = String.raw`// 日志路径 C:\work\demo`;
    for (const input of [body, `${comment}\n${body}`, body.replace('{\n', `{\n  ${comment}\n`), `${body}\n${comment}`]) {
        assert.equal(detectInputLanguage(input), 'json', input);
    }
});

test('leading comment groups, CRLF and fake syntax in comments do not select another language', () => {
    const prefixes = [
        '// note\n',
        String.raw`// 日志路径 C:\work\demo` + '\r\n',
        '/* note */ ',
        '/* several\nlines */\n',
        '# note\n',
        ' \uFEFF// first\n \t/* second */\n# third\n ',
        '// <div> { } [ ] " : = https://example.com\n',
        '/* {"fake":true} [table] name = "fake" */\n',
    ];
    const bodies = [body, '{"example":".x { color: red; }"}', '{"ok":true}', '{key: \'value\', list: [1,2,],}', '[1,2]', '[{"id":1}]', "['a', {b: true},]", '[\n[1], [2]\n]', '[true]', '[null]', '[NaN]', '[Infinity]', '[undefined]', '{"unfinished":'];
    for (const prefix of prefixes) for (const value of bodies) {
        assert.equal(detectInputLanguage(prefix + value), 'json', prefix + value);
    }
});

test('commented root strings and complete primitive tokens remain JSON', () => {
    for (const value of ['"hello"', '"text: value"', '"unfinished', 'true', 'false', 'null', '123', '-0', '1.2e+3']) {
        assert.equal(detectInputLanguage('// note\n' + value), 'json', value);
    }
});

test('commented TOML headers and assignments keep TOML highlighting', () => {
    for (const value of [
        '# note\n[server]\nport = 8080',
        '# note\n[server]',
        '# note\n[[products]]',
        '# note\n[[products]]\nname = "Hammer"',
        '# note\n[server] # settings\nport = 8080',
        '# note\n[server]\n# comment\nport = 8080',
        '# note\nport = 8080',
        '# note\n[server]\n"port" = 8080',
        "# note\n[server]\n'port' = 8080",
        '# note\n[server]\n"db"."port" = 8080',
        '# note\ntrue = false',
        '# note\n123 = 456',
        '// note\n[server]\nport = 8080',
        '/* note */\n[server]\nport = 8080',
    ]) assert.equal(detectInputLanguage(value), 'toml', value);
});

test('quoted YAML keys and primitive-looking keys are not JSON root values', () => {
    for (const value of ['"name": value', 'true: false', 'false: true', 'null: value', '123: value', 'true : false', '123 : value', 'name: value', 'items:\n  - value']) {
        assert.equal(detectInputLanguage('# note\n' + value), 'yaml', value);
    }
    assert.equal(detectInputLanguage('# note\n"quoted key" = "value"'), 'plaintext');
});

test('foreign formats and comment-only inputs preserve existing detection', () => {
    for (const [value, expected] of [
        ['#app { color: red; }', 'css'],
        ['/* note */\n#app { color: red; }', 'css'],
        ['// note\n<div>hello</div>', 'html'],
        ['// note\n<root>hello</root>', 'xml'],
        ['// note\nhello world', 'plaintext'],
        ['// {"fake":true}', 'plaintext'],
        ['/* {"fake":true}', 'plaintext'],
        ['// note', 'plaintext'],
        ['/* note */', 'plaintext'],
        ['# note', 'plaintext'],
        ['', 'json'],
    ]) assert.equal(detectInputLanguage(value), expected, value);
});

test('comment skipping is limited to the existing language detection sample', () => {
    const input = '//' + 'x'.repeat(20000) + '\n' + body;
    assert.equal(detectInputLanguage(input), 'plaintext');
    assert.equal(detectInputLanguage('/*' + 'x'.repeat(20000) + '*/' + body), 'plaintext');
    assert.equal(detectInputLanguage('//' + 'x'.repeat(19995) + '\n{}'), 'json');
});

// Keep the original fast path stable for inputs that do not start with comments.
test('ordinary JSON and other original language detection paths stay unchanged', () => {
    for (const value of ['{}', '[]', body, '"hello"', 'true', 'false', 'null', '-123', '[server]\nport = 8080']) {
        assert.equal(detectInputLanguage(value), 'json', value);
    }
    for (const [value, expected] of [['name: value', 'yaml'], ['port = 8080', 'toml'], ['<?xml version="1.0"?><root/>', 'xml'], ['<div>hello</div>', 'xml']]) {
        assert.equal(detectInputLanguage(value), expected, value);
    }
});


test('quoted TOML table detection bounds backtracking on long invalid dotted keys', () => {
    const moduleUrl = new URL('../src/components/utils/common.ts', import.meta.url).href;
    const input = '# note\n["server"]\n' + 'a.'.repeat(9000) + '!';
    // A subprocess timeout can stop synchronous regexp backtracking if it regresses.
    const result = spawnSync(process.execPath, ['--import', './scripts/register-typescript-tests.mjs', '--input-type=module', '-e', `
        import { detectInputLanguage } from ${JSON.stringify(moduleUrl)};
        if (detectInputLanguage(${JSON.stringify(input)}) !== 'json') process.exit(1);
    `], { timeout: 5000, encoding: 'utf8' });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
});
