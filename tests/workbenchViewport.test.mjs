import assert from 'node:assert/strict';
import test from 'node:test';
import { observeWorkbenchViewport } from '../src/components/utils/workbenchViewport.ts';

function viewport(wide) {
    const listeners = new Set();
    const media = { matches: wide, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
    return { view: { matchMedia: query => { assert.equal(query, '(min-width: 901px)'); return media; } },
        listeners, resize(wide) { media.matches = wide; for (const fn of listeners) fn(); } };
}

test('a narrow first visit never starts the editor or import reader', () => {
    const screen = viewport(false), changes = []; let starts = 0;
    const stop = observeWorkbenchViewport(screen.view, { onChange: wide => changes.push(wide), onFirstWide: () => starts++ });
    assert.deepEqual(changes, [false]); assert.equal(starts, 0);
    screen.resize(false); assert.equal(starts, 0);
    stop();
});

test('widening starts once; later narrowing and widening retain the existing workbench', () => {
    for (const initialWide of [false, true]) {
        const screen = viewport(initialWide), changes = []; let starts = 0;
        const stop = observeWorkbenchViewport(screen.view, { onChange: wide => changes.push(wide), onFirstWide: () => starts++ });
        screen.resize(true); assert.equal(starts, 1);
        screen.resize(false); assert.equal(changes.at(-1), false);
        screen.resize(true); assert.equal(changes.at(-1), true); assert.equal(starts, 1);
        stop();
    }
});

test('leaving removes the media listener and ignores already queued callbacks', () => {
    const screen = viewport(false), changes = []; let starts = 0;
    const stop = observeWorkbenchViewport(screen.view, { onChange: wide => changes.push(wide), onFirstWide: () => starts++ });
    const queued = [...screen.listeners][0]; stop(); stop();
    assert.equal(screen.listeners.size, 0);
    screen.resize(true); queued();
    assert.deepEqual(changes, [false]); assert.equal(starts, 0);
});
