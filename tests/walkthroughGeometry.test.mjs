import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWalkthroughGeometry } from '../src/components/utils/walkthroughGeometry.ts';

const note = { width: 270, height: 110 };
const viewport = { width: 1440, height: 960 };
const place = (target, view = viewport, size = note) => calculateWalkthroughGeometry({ target, viewport: view, note: size });
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const bounded = (geometry, view) => {
    const { note: box, arrow } = geometry;
    for (const value of [box.x, box.y, box.width, box.height, ...Object.values(arrow).flatMap(point => [point.x, point.y])]) assert(Number.isFinite(value));
    assert(box.x >= 0 && box.y >= 0 && box.width >= 0 && box.height >= 0);
    assert(box.x + box.width <= view.width + 1e-8);
    assert(box.y + box.height <= Math.max(0, view.height - 80) + 1e-8);
    for (const point of Object.values(arrow)) {
        assert(point.x >= 0 && point.x <= view.width);
        assert(point.y >= 0 && point.y <= view.height);
    }
};

test('prefers the right side and points at the target edge midpoint with eight-pixel clearance', () => {
    const target = { x: 400, y: 300, width: 80, height: 40 };
    const result = place(target);
    assert.equal(result.side, 'right');
    assert.equal(result.note.x - target.x - target.width, 64);
    assert.equal(result.note.y + result.note.height / 2, target.y + target.height / 2);
    assert.deepEqual(result.arrow.start, { x: result.note.x - 8, y: 320 });
    assert.deepEqual(result.arrow.end, { x: target.x + target.width + 8, y: 320 });
    assert(!overlaps(result.note, target));
    bounded(result, viewport);
});

for (const [side, target] of [
    ['left', { x: 1380, y: 300, width: 40, height: 40 }],
    ['bottom', { x: 0, y: 100, width: 1440, height: 40 }],
    ['top', { x: 0, y: 850, width: 1440, height: 40 }],
]) {
    test('uses ' + side + ' when the earlier sides cannot fit', () => {
        const result = place(target);
        assert.equal(result.side, side);
        assert(!overlaps(result.note, target));
        bounded(result, viewport);
    });
}

test('clamps a corner target without covering it when free space remains', () => {
    const target = { x: 0, y: 0, width: 32, height: 32 };
    const result = place(target, { width: 1024, height: 640 });
    assert.equal(result.side, 'right');
    assert(!overlaps(result.note, target));
    bounded(result, { width: 1024, height: 640 });
});

test('chooses a non-overlapping clamped side before a nearer position over the target', () => {
    const target = { x: 300, y: 0, width: 700, height: 500 };
    const result = place(target, { width: 1024, height: 640 });
    assert.equal(result.side, 'left');
    assert(!overlaps(result.note, target));
    bounded(result, { width: 1024, height: 640 });
});

test('keeps the note above the controls when a target occupies most of the viewport', () => {
    const view = { width: 1024, height: 640 };
    const target = { x: 0, y: 0, width: 1024, height: 560 };
    const result = place(target, view);
    assert(overlaps(result.note, target)); // No empty side exists in this layout.
    bounded(result, view);
});

test('reports an effective note size for viewports too small for the requested size', () => {
    const view = { width: 240, height: 160 };
    const result = place({ x: 5, y: 5, width: 20, height: 20 }, view);
    assert.equal(result.note.width, 240);
    assert.equal(result.note.height, 80);
    bounded(result, view);
});

test('handles zero-sized and invalid measurements without NaN coordinates', () => {
    for (const view of [{ width: 0, height: 0 }, { width: 50, height: 50 }]) {
        bounded(place({ x: NaN, y: Infinity, width: -3, height: NaN }, view), view);
    }
});

test('desktop edge and large-target layouts remain finite and inside their viewport', () => {
    for (const view of [{ width: 1024, height: 640 }, viewport]) {
        for (const targetWidth of [1, 32, view.width * .75, view.width]) {
            for (const targetHeight of [1, 40, view.height * .75]) {
                for (const x of [0, (view.width - targetWidth) / 2, view.width - targetWidth]) {
                    for (const y of [0, (view.height - targetHeight) / 2, view.height - targetHeight]) {
                        bounded(place({ x, y, width: targetWidth, height: targetHeight }, view), view);
                    }
                }
            }
        }
    }
});

test('does not mutate the measurements supplied by the view', () => {
    const input = Object.freeze({ target: Object.freeze({ x: 12, y: 34, width: 56, height: 78 }), viewport: Object.freeze(viewport), note: Object.freeze(note) });
    assert.deepEqual(calculateWalkthroughGeometry(input), calculateWalkthroughGeometry(input));
});
