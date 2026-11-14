import { nextTick } from 'vue';

interface ExtractionPromptHooks {
    customClass: string;
    confirmButtonClass: string;
    cancelButtonClass: string;
}

let promptSequence = 0;

/** Keep the real MessageBox prompt while cancellation owns only this instance. */
export function runCancellableExtractionPrompt(
    openPrompt: (hooks: ExtractionPromptHooks) => Promise<{ value: string }>,
    signal: AbortSignal,
): Promise<{ value: string }> {
    const instanceClass = 'json-tool-extract-values-prompt-' + ++promptSequence;
    const abortError = () => Object.assign(new Error('Extraction cancelled'), { name: 'AbortError' });
    return new Promise((resolve, reject) => {
        let settled = false;
        let opened = false;
        const settle = (callback: typeof resolve | typeof reject, value: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            callback(value as { value: string });
        };
        const closeOwnedPrompt = () => {
            if (typeof document === 'undefined') return false;
            const cancel = document.querySelector<HTMLButtonElement>('.' + instanceClass + ' .json-tool-extract-cancel');
            if (!cancel) return false;
            cancel.click();
            return true;
        };
        const abort = () => {
            settle(reject, abortError());
            // MessageBox applies its custom class on Vue's next render. Try now
            // for unmount cleanup, then once after that render if it just opened.
            if (opened && !closeOwnedPrompt()) void nextTick(closeOwnedPrompt);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        try {
            opened = true;
            const pending = openPrompt({
                customClass: 'json-tool-extract-values-prompt ' + instanceClass,
                confirmButtonClass: 'json-tool-extract-confirm',
                cancelButtonClass: 'json-tool-extract-cancel',
            });
            pending.then(value => settle(resolve, value), error => settle(reject, error));
        } catch (error) { settle(reject, error); }
    });
}
