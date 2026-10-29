import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonLanguageActivation } from '../src/components/utils/jsonLanguageActivation.ts';

function event() {
    const listeners = new Set();
    return {
        listeners,
        subscribe(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        fire(value) { for (const listener of [...listeners]) listener(value); },
    };
}

function harness(initial = []) {
    const created = event(), removed = event(), languageChanged = event();
    const models = new Set(initial);
    const configurations = [];
    const editor = {
        getModels: () => [...models],
        onDidCreateModel: created.subscribe,
        onWillDisposeModel: removed.subscribe,
        onDidChangeModelLanguage: languageChanged.subscribe,
    };
    return {
        editor, configurations, created, removed, languageChanged,
        configure: value => configurations.push(value),
        add(model) { models.add(model); created.fire(model); },
        remove(model) { removed.fire(model); models.delete(model); },
        changeLanguage(model, language) { model.language = language; languageChanged.fire({ model }); },
        listenerCount: () => created.listeners.size + removed.listeners.size + languageChanged.listeners.size,
    };
}

function model(length = 0, language = 'json') {
    const changed = event();
    return {
        length, language, changed,
        getLanguageId() { return this.language; },
        getValueLength() { return this.length; },
        getValue() { throw new Error('Activation must never copy or parse editor text'); },
        onDidChangeContent: changed.subscribe,
        edit(length) { this.length = length; changed.fire(); },
    };
}

test('blank editors keep tokens and explicit completion without automatic Worker consumers', () => {
    const h = harness(), activation = createJsonLanguageActivation(h.editor, h.configure, true);
    const input = model(), output = model();
    h.add(input); h.add(output);
    activation.setDiagnosticsEnabled(false);
    activation.setDiagnosticsEnabled(true);
    assert.equal(h.configurations.length, 1, 'unchanged inactive configuration must not restart providers');
    const blank = h.configurations[0];
    for (const feature of ['tokens', 'completionItems', 'hovers', 'selectionRanges']) assert.equal(blank[feature], true);
    for (const feature of ['diagnostics', 'foldingRanges', 'colors', 'documentSymbols', 'documentFormattingEdits', 'documentRangeFormattingEdits']) assert.equal(blank[feature], false);
    activation.dispose();
    assert.equal(h.listenerCount(), 0);
    assert.equal(input.changed.listeners.size + output.changed.listeners.size, 0);
});

test('first JSON edit enables automatic services once and removes all startup listeners', () => {
    const input = model(), output = model(), h = harness([input, output]);
    const activation = createJsonLanguageActivation(h.editor, h.configure, true);
    input.edit(1);
    assert.equal(h.configurations.length, 2);
    for (const feature of ['tokens', 'diagnostics', 'foldingRanges', 'colors', 'documentSymbols']) assert.equal(h.configurations[1][feature], true);
    assert.equal(h.listenerCount(), 0);
    assert.equal(input.changed.listeners.size + output.changed.listeners.size, 0);
    input.edit(100_000_000); input.edit(0); h.add(model(10));
    assert.equal(h.configurations.length, 2, 'later edits and clearing must not restart providers');
    activation.setDiagnosticsEnabled(false);
    assert.equal(h.configurations.at(-1).diagnostics, false);
    assert.equal(h.configurations.at(-1).foldingRanges, true);
    activation.setDiagnosticsEnabled(false);
    assert.equal(h.configurations.length, 3);
    activation.dispose();
});

test('nonempty Diff, restored and programmatically created JSON models activate immediately', () => {
    for (const existing of [false, true]) {
        const content = model(123), h = harness(existing ? [content] : []);
        const activation = createJsonLanguageActivation(h.editor, h.configure, false);
        if (!existing) h.add(content);
        assert.equal(h.configurations.at(-1).diagnostics, false);
        assert.equal(h.configurations.at(-1).foldingRanges, true);
        assert.equal(h.listenerCount(), 0);
        assert.equal(content.changed.listeners.size, 0);
        activation.setDiagnosticsEnabled(true);
        assert.equal(h.configurations.at(-1).diagnostics, true);
        activation.dispose();
    }
});

test('non-JSON content stays inactive until its language changes to JSON', () => {
    const text = model(500, 'yaml'), h = harness([text]);
    const activation = createJsonLanguageActivation(h.editor, h.configure, true);
    text.edit(600);
    assert.equal(h.configurations.length, 1);
    h.changeLanguage(text, 'json');
    assert.equal(h.configurations.at(-1).diagnostics, true);
    assert.equal(h.listenerCount(), 0);
    activation.dispose();
});

test('disposing empty models or the page releases listeners and prevents stale activation', () => {
    const input = model(), h = harness([input]);
    const activation = createJsonLanguageActivation(h.editor, h.configure, true);
    h.remove(input);
    assert.equal(input.changed.listeners.size, 0);
    input.edit(50);
    assert.equal(h.configurations.length, 1);
    const replacement = model(); h.add(replacement);
    const staleListener = [...replacement.changed.listeners][0];
    activation.dispose();
    replacement.edit(50); staleListener(); activation.setDiagnosticsEnabled(false);
    assert.equal(h.configurations.length, 1);
    assert.equal(h.listenerCount(), 0);
    assert.equal(replacement.changed.listeners.size, 0);
});
