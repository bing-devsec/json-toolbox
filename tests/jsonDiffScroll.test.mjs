import assert from 'node:assert/strict';
import test from 'node:test';
import { withPreservedDiffScroll } from '../src/components/utils/diffScroll.ts';

// Model the browser/editor invariant: reducing content bounds immediately clamps
// scroll position; increasing them later does not recover the previous position.
function editorAt(scrollTop, scrollLeft = 0, maxTop = 11_000, maxLeft = 500) {
    return {
        scrollTop,
        scrollLeft,
        maxTop,
        maxLeft,
        getScrollTop() { return this.scrollTop; },
        getScrollLeft() { return this.scrollLeft; },
        setScrollPosition(position) {
            this.scrollTop = Math.max(0, Math.min(position.scrollTop, this.maxTop));
            this.scrollLeft = Math.max(0, Math.min(position.scrollLeft, this.maxLeft));
        },
        setBounds(top, left = this.maxLeft) {
            this.maxTop = top;
            this.maxLeft = left;
            this.setScrollPosition(this);
        },
    };
}

for (const editedSide of ['left', 'right']) {
    test(`bottom-of-file edits preserve both viewports when ${editedSide} alignment gaps are rebuilt`, () => {
        const left = editorAt(10_500, 180);
        const right = editorAt(10_500, 180);
        const shrinkingEditor = editedSide === 'left' ? left : right;
        withPreservedDiffScroll([left, right], () => {
            shrinkingEditor.setBounds(8_000);
            assert.equal(shrinkingEditor.getScrollTop(), 8_000, 'the intermediate layout really clamps');
            shrinkingEditor.setBounds(11_000);
        });
        assert.equal(left.getScrollTop(), 10_500);
        assert.equal(right.getScrollTop(), 10_500);
        assert.equal(left.getScrollLeft(), 180);
        assert.equal(right.getScrollLeft(), 180);
    });
}

test('edits near the beginning leave an already-valid viewport unchanged', () => {
    const editor = editorAt(600, 90);
    withPreservedDiffScroll([editor], () => {
        editor.setBounds(8_000);
        editor.setBounds(11_000);
    });
    assert.equal(editor.getScrollTop(), 600);
    assert.equal(editor.getScrollLeft(), 90);
});

test('a permanently shorter result respects the final scroll bounds', () => {
    const editor = editorAt(10_500, 180);
    withPreservedDiffScroll([editor], () => {
        editor.setBounds(8_000, 0);
        editor.setBounds(9_000, 100);
    });
    assert.equal(editor.getScrollTop(), 9_000);
    assert.equal(editor.getScrollLeft(), 100);
});

test('a failed layout update restores available scroll positions and propagates its error', () => {
    const editor = editorAt(10_500, 180);
    const failure = new Error('layout failed after rebuilding');
    assert.throws(() => withPreservedDiffScroll([editor], () => {
        editor.setBounds(8_000, 0);
        editor.setBounds(11_000, 500);
        throw failure;
    }), (error) => error === failure);
    assert.equal(editor.getScrollTop(), 10_500);
    assert.equal(editor.getScrollLeft(), 180);
});
