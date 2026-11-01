import type { ReviewChoice, ReviewClient, ReviewUsageSignal } from './reviewClient';
export const REVIEW_AFTER_USE_DELAY_MS = 1_000;
export const REVIEW_IDLE_DELAY_MS = 1_000;
export interface ReviewEnvironment { visible: boolean; focused: boolean; blocked: boolean }

/** One local UI session, with an independent backend lease for cross-tab exclusion. */
export function createReviewInvitationScheduler(options: {
    client: ReviewClient;
    environment: () => ReviewEnvironment;
    onVisible: (token: string | null) => void;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => unknown;
    clearTimer?: (timer: unknown) => void;
}) {
    const now = options.now ?? Date.now;
    const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let timer: unknown;
    let disposed = false;
    let finished = false;
    let eligible = false;
    let sequence = -1;
    let useRevision = 0;
    let revision = 0;
    let lastUse = -Infinity;
    let lastActivity = now();
    let phase: 'idle' | 'claiming' | 'marking' | 'visible' | 'deciding' = 'idle';
    let token: string | undefined;
    let flowAbort: AbortController | undefined;
    let useAbort: AbortController | undefined;
    let decisionAbort: AbortController | undefined;
    const released = new Set<string>();
    const safe = () => { const env = options.environment(); return env.visible && env.focused && !env.blocked; };
    const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
    const release = (value?: string) => {
        if (!value || released.has(value)) return;
        released.add(value);
        void options.client.release(value).catch(() => {});
    };
    const hide = () => options.onVisible(null);
    const invalidateFlow = () => {
        revision++;
        flowAbort?.abort(); flowAbort = undefined;
        if (phase === 'marking') { finished = true; eligible = false; }
        if (phase === 'claiming' || phase === 'marking') {
            release(token); token = undefined; phase = 'idle';
        }
        clear();
    };
    const arm = () => {
        clear();
        if (disposed || finished || !eligible || phase !== 'idle') return;
        const env = options.environment();
        if (!env.visible || !env.focused) return;
        const delay = Math.max(0, lastUse + REVIEW_AFTER_USE_DELAY_MS - now(), lastActivity + REVIEW_IDLE_DELAY_MS - now());
        timer = setTimer(() => { timer = undefined; void offer(); }, Math.max(delay, env.blocked ? 1000 : 0));
    };
    const offer = async () => {
        if (disposed || finished || !eligible || phase !== 'idle') return;
        if (!safe() || now() < Math.max(lastUse + REVIEW_AFTER_USE_DELAY_MS, lastActivity + REVIEW_IDLE_DELAY_MS)) { arm(); return; }
        const current = ++revision;
        flowAbort = new AbortController(); const signal = flowAbort.signal;
        phase = 'claiming';
        try {
            const claim = await options.client.claim({ signal });
            if (disposed || current !== revision || signal.aborted) { release(claim.token); return; }
            if (!claim.granted || !claim.token) { eligible = false; phase = 'idle'; return; }
            token = claim.token;
            if (!safe()) { release(token); token = undefined; phase = 'idle'; arm(); return; }
            phase = 'marking';
            await options.client.shown(token, { signal });
            if (disposed || current !== revision || signal.aborted) { release(claim.token); return; }
            if (!safe()) { release(token); token = undefined; phase = 'idle'; finished = true; eligible = false; return; }
            phase = 'visible'; finished = true; eligible = false;
            options.onVisible(token);
        } catch {
            if (!disposed && current === revision) {
                release(token); token = undefined; phase = 'idle'; eligible = false;
            }
        } finally { if (current === revision) flowAbort = undefined; }
    };
    const decide = async (choice: ReviewChoice, immediateHide = false): Promise<void> => {
        if (disposed || phase !== 'visible' || !token) return;
        const selected = token;
        phase = 'deciding'; decisionAbort = new AbortController();
        if (immediateHide) hide();
        try {
            await options.client.decide(selected, choice, { signal: decisionAbort.signal });
            if (!disposed) { token = undefined; phase = 'idle'; hide(); }
        } catch (error) {
            if (!disposed) {
                if (immediateHide) { token = undefined; phase = 'idle'; release(selected); }
                else phase = 'visible';
            }
            throw error;
        } finally { decisionAbort = undefined; }
    };
    return {
        async recordUse(usage: ReviewUsageSignal): Promise<void> {
            if (disposed || finished || !options.client.available || !Number.isSafeInteger(usage.sequence) || usage.sequence <= sequence) return;
            sequence = usage.sequence;
            lastUse = now(); lastActivity = now();
            invalidateFlow(); useAbort?.abort(); useAbort = new AbortController();
            const current = ++useRevision;
            try {
                const result = await options.client.used(usage.kind, { signal: useAbort.signal });
                if (!disposed && current === useRevision) { eligible = result.eligible; arm(); }
            } catch { if (!disposed && current === useRevision) eligible = false; }
        },
        activity(): void {
            if (disposed || phase === 'visible' || phase === 'deciding') return;
            lastActivity = now(); invalidateFlow(); arm();
        },
        refresh(): void {
            if (disposed) return;
            if (phase === 'visible' && !safe()) { void decide('later', true).catch(() => {}); return; }
            if (phase === 'deciding') return;
            lastActivity = now(); invalidateFlow(); arm();
        },
        decide,
        dispose(): void {
            if (disposed) return;
            disposed = true; useRevision++; useAbort?.abort(); decisionAbort?.abort();
            invalidateFlow(); release(token); token = undefined;
        },
    };
}
