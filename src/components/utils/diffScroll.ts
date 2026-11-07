interface DiffScrollEditor {
    getScrollTop(): number;
    getScrollLeft(): number;
    setScrollPosition(position: { scrollTop: number; scrollLeft: number }): void;
}

/** Preserve the viewport while a synchronous layout update temporarily removes alignment gaps. */
export const withPreservedDiffScroll = (editors: readonly DiffScrollEditor[], update: () => void): void => {
    const positions = editors.map((editor) => ({
        editor,
        scrollTop: editor.getScrollTop(),
        scrollLeft: editor.getScrollLeft(),
    }));
    try {
        update();
    } finally {
        for (const { editor, scrollTop, scrollLeft } of positions) {
            // Monaco's default is an immediate update; final bounds still clamp normally.
            editor.setScrollPosition({ scrollTop, scrollLeft });
        }
    }
};
