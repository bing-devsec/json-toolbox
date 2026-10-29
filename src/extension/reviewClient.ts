export type ReviewUsageKind = 'format' | 'compress' | 'unescape' | 'escape' | 'convert' | 'import';
export interface ReviewUsageSignal { sequence: number; kind: ReviewUsageKind }
export type ReviewChoice = 'later' | 'never' | 'rate';
export interface ReviewRequestOptions { signal?: AbortSignal }
export interface ReviewClaim { granted: boolean; token?: string; expiresAt?: number }
export interface ReviewRuntime {
    id?: string;
    lastError?: { message?: string };
    sendMessage(message: unknown, callback: (value: unknown) => void): void;
}
export interface ReviewClient {
    available: boolean;
    initialize(options?: ReviewRequestOptions): Promise<{ eligible: boolean }>;
    used(kind: ReviewUsageKind, options?: ReviewRequestOptions): Promise<{ eligible: boolean }>;
    claim(options?: ReviewRequestOptions): Promise<ReviewClaim>;
    shown(token: string, options?: ReviewRequestOptions): Promise<void>;
    release(token: string): Promise<void>;
    decide(token: string, choice: ReviewChoice, options?: ReviewRequestOptions): Promise<void>;
}
export class ReviewClientError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'ReviewClientError'; }
}
const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const detectRuntime = (): ReviewRuntime | undefined => {
    const value = (globalThis as typeof globalThis & { chrome?: { runtime?: ReviewRuntime } }).chrome?.runtime;
    return value?.id && typeof value.sendMessage === 'function' ? value : undefined;
};

/** Local metadata only: operation kind and random ids, never editor content. */
export function createReviewClient(options: {
    runtime?: ReviewRuntime;
    sessionId?: string;
    newId?: () => string;
    timeoutMs?: number;
} = {}): ReviewClient {
    const runtime = options.runtime ?? detectRuntime();
    const newId = options.newId ?? (() => crypto.randomUUID());
    let sessionId = '';
    try { if (runtime?.id) sessionId = options.sessionId ?? newId(); } catch { /* Keep ordinary previews inert. */ }
    const available = Boolean(runtime?.id && isId(sessionId) && typeof runtime.sendMessage === 'function');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const send = (action: string, details: Record<string, unknown> = {}, request: ReviewRequestOptions = {}, onLate?: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: unknown, value?: Record<string, unknown>) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            request.signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(abortError());
        if (!available || !runtime) { finish(new ReviewClientError('UNAVAILABLE', 'Review invitations are available in the installed extension.')); return; }
        if (request.signal?.aborted) { abort(); return; }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) { finish(new ReviewClientError('TIMEOUT', 'Invalid review request timeout.')); return; }
        request.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new ReviewClientError('TIMEOUT', 'The extension did not respond in time.')), timeoutMs);
        try {
            runtime.sendMessage({ type: 'json-tool-review', action, sessionId, ...details }, result => {
                const browserError = runtime.lastError;
                const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null;
                if (settled) { if (!browserError && value?.ok === true) onLate?.(value); return; }
                if (browserError) { finish(new ReviewClientError('BROWSER', browserError.message || 'Extension communication failed.')); return; }
                if (value?.ok !== true) { finish(new ReviewClientError(typeof value?.code === 'string' ? value.code : 'FAILED', typeof value?.error === 'string' ? value.error : 'The review operation failed.')); return; }
                finish(undefined, value);
            });
        } catch (error) { finish(error); }
    });
    const release = async (token: string): Promise<void> => { if (isId(token)) await send('release', { token }); };
    const eligibility = async (action: string, details: Record<string, unknown>, request?: ReviewRequestOptions) => {
        const result = await send(action, details, request);
        if (typeof result.eligible !== 'boolean') throw new ReviewClientError('INVALID_RESPONSE', 'Invalid invitation eligibility.');
        return { eligible: result.eligible };
    };
    return {
        available,
        initialize: request => eligibility('initialize', {}, request),
        used: async (kind, request) => {
            if (!['format', 'compress', 'unescape', 'escape', 'convert', 'import'].includes(kind)) throw new ReviewClientError('INVALID_KIND', 'Invalid operation kind.');
            return eligibility('used', { kind, eventId: newId() }, request);
        },
        claim: async request => {
            const result = await send('claim', {}, request, late => { if (late.granted === true && isId(late.token)) void release(late.token).catch(() => {}); });
            if (typeof result.granted !== 'boolean' || (result.granted && (!isId(result.token) || !Number.isSafeInteger(result.expiresAt) || Number(result.expiresAt) <= 0))) {
                if (isId(result.token)) void release(result.token).catch(() => {});
                throw new ReviewClientError('INVALID_RESPONSE', 'Invalid invitation claim.');
            }
            return { granted: result.granted, ...(result.granted ? { token: result.token as string, expiresAt: result.expiresAt as number } : {}) };
        },
        shown: async (token, request) => { if (!isId(token)) throw new ReviewClientError('INVALID_TOKEN', 'Invalid invitation token.'); await send('shown', { token }, request); },
        release,
        decide: async (token, choice, request) => {
            if (!isId(token) || !['later', 'never', 'rate'].includes(choice)) throw new ReviewClientError('INVALID_CHOICE', 'Invalid invitation decision.');
            await send('decide', { token, choice }, request);
        },
    };
}
