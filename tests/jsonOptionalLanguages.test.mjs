import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { createOptionalLanguageLoader, createModelLanguageSetter } from '../src/components/utils/optionalLanguageLoader.ts';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

test('optional tokenizer imports are lazy, coalesced, registered once, and retry after failure', async () => {
    let attempts = 0, registered = 0;
    const runtime = {};
    const loader = createOptionalLanguageLoader(() => runtime, {
        yaml: async () => {
            attempts++;
            if (attempts === 1) throw Error('network');
            return { register(api) { assert.equal(api, runtime); registered++; } };
        },
    });
    assert.equal(attempts, 0);
    await loader.load('json');
    assert.equal(attempts, 0);
    const failed = loader.load('yaml');
    assert.equal(loader.load('yaml'), failed);
    await assert.rejects(failed, /network/);
    assert.equal(loader.isReady('yaml'), false);
    await Promise.all([loader.load('yaml'), loader.load('yaml')]);
    await loader.load('yaml');
    assert.equal(attempts, 2);
    assert.equal(registered, 1);
});

test('unmount cancels delayed tokenizer registration without affecting a replacement registry', async () => {
    const waiting = deferred();
    let registered = 0;
    const module = { register() { registered++; } };
    const loader = createOptionalLanguageLoader(() => ({}), { yaml: () => waiting.promise });
    const request = loader.load('yaml');
    loader.dispose();
    waiting.resolve(module);
    await request;
    assert.equal(registered, 0);
    const replacement = createOptionalLanguageLoader(() => ({}), { yaml: async () => module });
    await replacement.load('yaml');
    assert.equal(registered, 1);
});

test('language setters preserve synchronous JSON and isolate superseded, disposed and unmounted models', async () => {
    const waiting = deferred();
    const setter = createModelLanguageSetter(language => language === 'json', () => waiting.promise,
        (model, language) => { model.language = language; });
    const model = () => ({ language: 'plaintext', disposed: false, getLanguageId() { return this.language; }, isDisposed() { return this.disposed; } });
    const superseded = model(), destroyed = model(), active = model();
    const requests = [setter.set(superseded, 'yaml'), setter.set(destroyed, 'xml'), setter.set(active, 'toml')];
    void setter.set(superseded, 'json');
    assert.equal(superseded.language, 'json');
    destroyed.disposed = true;
    waiting.resolve();
    await Promise.all(requests);
    assert.equal(superseded.language, 'json');
    assert.equal(destroyed.language, 'plaintext');
    assert.equal(active.language, 'toml');
    const other = model();
    const pending = setter.set(other, 'html');
    setter.dispose();
    await pending;
    assert.equal(other.language, 'plaintext');
});

test('all extracted tokenizers retain actual registration behavior', async () => {
    for (const language of ['yaml', 'xml', 'html', 'css', 'toml']) {
        const captures = [];
        const source = await readFile(new URL(`../src/components/utils/languages/${language}.ts`, import.meta.url), 'utf8');
        const { code } = await transform(source, { loader: 'ts', format: 'esm' });
        const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        module.register({ languages: {
            register: value => captures.push(value.id),
            setTokensProvider: (id, provider) => { assert.equal(id, language); assert.equal(typeof provider.tokenize, 'function'); },
            setMonarchTokensProvider: (id, provider) => { assert.equal(id, language); assert.ok(provider.tokenizer.root.length); },
        } });
        assert.deepEqual(captures, [language]);
    }
});
