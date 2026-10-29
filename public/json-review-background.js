import { extensionPage } from './json-capture-core.js';
import {
    REVIEW_TYPE, REVIEW_STORAGE_KEY, REVIEW_STORE_URL, REVIEW_CLAIM_TTL_MS, REVIEW_SHOWN_LEASE_MS,
    REVIEW_COOLDOWN_MS, REVIEW_MAX_SHOWS, REVIEW_USAGE_KINDS, isReviewId, normalizeReviewState, isReviewEligible, recordReviewUsage,
} from './json-review-policy.js';

const failure = (code, message) => Object.assign(new Error(message), { code });
const sameOwner = (value, sender, sessionId, token) => value && value.token === token
    && value.sessionId === sessionId && value.tabId === sender.tab.id;

/** Serialized local policy; extension updates and worker restarts never reset participation decisions. */
export function createReviewController({ chrome: api, now = Date.now, randomId = () => crypto.randomUUID() }) {
    let queue = Promise.resolve();
    const serialized = task => {
        const result = queue.then(task, task);
        queue = result.catch(() => {});
        return result;
    };
    const save = state => api.storage.local.set({ [REVIEW_STORAGE_KEY]: state });
    async function load() {
        const stored = await api.storage.local.get(REVIEW_STORAGE_KEY);
        return normalizeReviewState(stored[REVIEW_STORAGE_KEY], now());
    }
    function validate(message, sender) {
        if (!extensionPage(sender, api) || !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0
            || (sender.frameId !== undefined && sender.frameId !== 0)
            || (sender.documentLifecycle && sender.documentLifecycle !== 'active') || !isReviewId(message.sessionId)) {
            throw failure('SOURCE', 'Review invitations are available only in the active JSON Toolbox editor.');
        }
    }
    async function dispatch(message, sender) {
        if (message?.type !== REVIEW_TYPE) return undefined;
        validate(message, sender);
        let state = await load();
        if (message.action === 'initialize') {
            await save(state);
            return { ok: true, eligible: isReviewEligible(state, now()) };
        }
        if (message.action === 'used') {
            if (!isReviewId(message.eventId) || !REVIEW_USAGE_KINDS.includes(message.kind))
                throw failure('EVENT', 'Invalid successful usage event.');
            if (state.suppressed || state.shownCount >= REVIEW_MAX_SHOWS) return { ok: true, eligible: false };
            state = recordReviewUsage(state, message.eventId, message.kind, now());
            await save(state);
            return { ok: true, eligible: isReviewEligible(state, now()) };
        }
        if (message.action === 'claim') {
            if (!isReviewEligible(state, now()) || (state.lease && state.lease.expiresAt > now()))
                return { ok: true, granted: false };
            const token = randomId();
            if (!isReviewId(token)) throw failure('STATE', 'The invitation token could not be created.');
            const expiresAt = now() + REVIEW_CLAIM_TTL_MS;
            state.lease = { token, sessionId: message.sessionId, tabId: sender.tab.id, phase: 'claimed', expiresAt };
            await save(state);
            return { ok: true, granted: true, token, expiresAt };
        }
        if (!['shown', 'release', 'decide'].includes(message.action)) throw failure('ACTION', 'Unsupported review operation.');
        if (!isReviewId(message.token)) throw failure('SOURCE', 'Invalid invitation token.');
        if (message.action === 'decide' && sameOwner(state.lastDecision, sender, message.sessionId, message.token)) {
            // A timed-out callback or duplicate click never opens another store tab.
            return { ok: true, resolved: true, choice: state.lastDecision.choice };
        }
        if (!sameOwner(state.lease, sender, message.sessionId, message.token)) {
            if (message.action === 'release') return { ok: true };
            throw failure('EXPIRED', 'The review invitation is no longer active.');
        }
        if (message.action === 'release') {
            if (state.lease.phase === 'claimed') { state.lease = null; await save(state); }
            return { ok: true };
        }
        if (message.action === 'shown') {
            if (state.lease.phase === 'shown') return { ok: true };
            if (!isReviewEligible(state, now())) throw failure('STATE', 'The review invitation is no longer eligible.');
            state = { ...state, shownCount: state.shownCount + 1, lastShownAt: now(), cooldownUntil: now() + REVIEW_COOLDOWN_MS,
                lease: { ...state.lease, phase: 'shown', expiresAt: now() + REVIEW_SHOWN_LEASE_MS } };
            await save(state);
            return { ok: true };
        }
        if (state.lease.phase !== 'shown') throw failure('STATE', 'The review invitation has not been displayed.');
        if (!['later', 'never', 'rate'].includes(message.choice)) throw failure('CHOICE', 'Invalid review invitation choice.');
        const previous = state;
        state = { ...state, lease: null,
            lastDecision: { token: message.token, sessionId: message.sessionId, tabId: sender.tab.id, choice: message.choice, at: now() },
            cooldownUntil: Math.max(state.cooldownUntil, now() + REVIEW_COOLDOWN_MS),
            suppressed: message.choice !== 'later',
            suppressionReason: message.choice === 'rate' ? 'rate_clicked' : message.choice === 'never' ? 'never' : null };
        // Persist intent before the external side effect: retries are at most once, even after a worker restart.
        await save(state);
        if (message.choice === 'rate') {
            try { await api.tabs.create({ url: REVIEW_STORE_URL, active: true }); }
            catch {
                // An ordinary open failure remains retryable. A storage failure stays quiet and fails closed.
                await save(previous).catch(() => {});
                throw failure('OPEN_FAILED', 'The Chrome Web Store could not be opened. Please try again.');
            }
        }
        return { ok: true, resolved: true, choice: message.choice };
    }
    return {
        initialize: () => serialized(async () => { const state = await load(); await save(state); return state; }),
        handle: (message, sender) => serialized(async () => {
            try { return await dispatch(message, sender); }
            catch (error) { return { ok: false, code: typeof error?.code === 'string' ? error.code : 'STORAGE',
                error: error instanceof Error ? error.message : 'Review invitation storage is unavailable.' }; }
        }),
    };
}
