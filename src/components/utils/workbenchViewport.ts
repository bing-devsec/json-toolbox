export const WORKBENCH_MEDIA_QUERY = '(min-width: 901px)';

/** Start the desktop workbench once, retaining its models when the window shrinks. */
export function observeWorkbenchViewport(view: Pick<Window, 'matchMedia'>, options: {
    onChange: (wide: boolean) => void;
    onFirstWide: () => void;
}): () => void {
    const media = view.matchMedia(WORKBENCH_MEDIA_QUERY);
    let started = false;
    let disposed = false;
    const update = () => {
        if (disposed) return;
        options.onChange(media.matches);
        if (media.matches && !started) {
            started = true;
            options.onFirstWide();
        }
    };
    media.addEventListener('change', update);
    update();
    return () => {
        disposed = true;
        media.removeEventListener('change', update);
    };
}
