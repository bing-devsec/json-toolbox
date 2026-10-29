export type JsonToolLoadStatus = 'loading' | 'slow' | 'ready' | 'error';

export interface JsonToolLoadState<T> {
    status: JsonToolLoadStatus;
    component: T | null;
}

/** Share a successful module download, while allowing another attempt after rejection. */
export const createRetryableModuleLoader = <T>(load: () => Promise<T>): (() => Promise<T>) => {
    let pending: Promise<T> | null = null;
    return () => {
        if (!pending) {
            const attempt = Promise.resolve().then(load);
            pending = attempt;
            void attempt.catch(() => {
                if (pending === attempt) pending = null;
            });
        }
        return pending;
    };
};

/** A slow download is still in progress; only rejection exposes a retry action. */
export const createJsonToolLoadController = <T>(options: {
    load: () => Promise<T>;
    onChange: (state: JsonToolLoadState<T>) => void;
    slowAfterMs?: number;
}) => {
    let disposed = false;
    let currentAttempt: Promise<void> | null = null;
    let slowTimer: ReturnType<typeof setTimeout> | null = null;

    const clearSlowTimer = () => {
        if (slowTimer !== null) clearTimeout(slowTimer);
        slowTimer = null;
    };

    const start = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (currentAttempt) return currentAttempt;

        options.onChange({ status: 'loading', component: null });
        slowTimer = setTimeout(() => {
            slowTimer = null;
            if (!disposed) options.onChange({ status: 'slow', component: null });
        }, options.slowAfterMs ?? 8000);

        currentAttempt = Promise.resolve()
            .then(options.load)
            .then(
                component => {
                    if (!disposed) options.onChange({ status: 'ready', component });
                },
                () => {
                    if (!disposed) options.onChange({ status: 'error', component: null });
                },
            )
            .finally(() => {
                clearSlowTimer();
                currentAttempt = null;
            });
        return currentAttempt;
    };

    return {
        start,
        dispose() {
            disposed = true;
            clearSlowTimer();
            // The shared download can finish for a later visit, but may not update this view.
        },
    };
};
