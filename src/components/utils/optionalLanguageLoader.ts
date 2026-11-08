/** Keep optional tokenizers out of the editor bootstrap and retry failed imports. */
export function createOptionalLanguageLoader<T>(
    runtime: () => T,
    loaders: Record<string, () => Promise<{ register: (api: T) => void }>>,
) {
    const ready = new Set<string>();
    const pending = new Map<string, Promise<void>>();
    let disposed = false;
    const isReady = (language: string) => !Object.hasOwn(loaders, language) || ready.has(language);
    const load = (language: string): Promise<void> => {
        if (disposed || isReady(language)) return Promise.resolve();
        const existing = pending.get(language);
        if (existing) return existing;
        const request = Promise.resolve().then(() => loaders[language]()).then(module => {
            if (disposed) return;
            module.register(runtime());
            ready.add(language);
        }).finally(() => { pending.delete(language); });
        pending.set(language, request);
        return request;
    };
    return { load, isReady, dispose: () => { disposed = true; } };
}

interface LanguageModel {
    isDisposed(): boolean;
    getLanguageId(): string;
}

/** New language requests, including synchronous JSON resets, supersede pending loads. */
export function createModelLanguageSetter<T extends LanguageModel>(
    isReady: (language: string) => boolean,
    load: (language: string) => Promise<void>,
    setLanguage: (model: T, language: string) => void,
) {
    const requests = new WeakMap<T, object>();
    let disposed = false;
    const set = (model: T, language: string): Promise<void> => {
        const request = {};
        requests.set(model, request);
        const apply = () => {
            if (!disposed && !model.isDisposed() && requests.get(model) === request && model.getLanguageId() !== language) {
                setLanguage(model, language);
            }
        };
        if (isReady(language)) { apply(); return Promise.resolve(); }
        return load(language).then(apply, error => {
            if (!disposed && !model.isDisposed() && requests.get(model) === request) throw error;
        });
    };
    return { set, dispose: () => { disposed = true; } };
}
