export const REVIEW_TYPE = 'json-tool-review';
export const REVIEW_STORAGE_KEY = 'json-tool-review-v1';
export const REVIEW_DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_MIN_AGE_MS = 7 * REVIEW_DAY_MS;
export const REVIEW_MIN_USES = 10;
export const REVIEW_MIN_ACTIVE_DAYS = 3;
export const REVIEW_USAGE_INTERVAL_MS = 60 * 1000;
export const REVIEW_COOLDOWN_MS = 30 * REVIEW_DAY_MS;
export const REVIEW_MAX_SHOWS = 2;
export const REVIEW_CLAIM_TTL_MS = 60 * 1000;
export const REVIEW_SHOWN_LEASE_MS = 10 * 60 * 1000;
export const REVIEW_USAGE_KINDS = Object.freeze(['format', 'compress', 'unescape', 'escape', 'convert', 'import']);
export const REVIEW_STORE_URL = 'https://chromewebstore.google.com/detail/json-%E5%B7%A5%E5%85%B7%E7%AE%B1/gjodfccabjefjicpjbbhfkgkddapafbh/reviews';
const MAX_USES = 1_000_000;
const validTime = value => Number.isSafeInteger(value) && value > 0;
const validCount = value => Number.isSafeInteger(value) && value >= 0;
export const isReviewId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const validDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const reviewDayKey = now => {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const ownerFields = value => value && typeof value === 'object' && isReviewId(value.token) && isReviewId(value.sessionId)
    && Number.isSafeInteger(value.tabId) && value.tabId >= 0;

/** Only local counters and invitation decisions survive; never retain processing content or URLs. */
export function normalizeReviewState(value, now) {
    if (!validTime(now)) throw new Error('Invalid review clock.');
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const usable = raw.schemaVersion === 1 && validTime(raw.firstSeenAt);
    const state = {
        schemaVersion: 1,
        firstSeenAt: usable ? raw.firstSeenAt : now,
        totalUses: usable && validCount(raw.totalUses) ? Math.min(raw.totalUses, MAX_USES) : 0,
        activeDays: usable && Array.isArray(raw.activeDays) ? [...new Set(raw.activeDays.filter(validDay))].sort().slice(-3) : [],
        lastCountedAt: usable && validTime(raw.lastCountedAt) ? raw.lastCountedAt : 0,
        recentEventIds: usable && Array.isArray(raw.recentEventIds) ? [...new Set(raw.recentEventIds.filter(isReviewId))].slice(-32) : [],
        shownCount: validCount(raw.shownCount) ? Math.min(raw.shownCount, REVIEW_MAX_SHOWS) : 0,
        lastShownAt: usable && validTime(raw.lastShownAt) ? raw.lastShownAt : 0,
        cooldownUntil: usable && validTime(raw.cooldownUntil) ? raw.cooldownUntil : 0,
        suppressed: raw.suppressed === true,
        suppressionReason: raw.suppressionReason === 'never' || raw.suppressionReason === 'rate_clicked' ? raw.suppressionReason : null,
        lease: null,
        lastDecision: null,
    };
    const lease = raw.lease;
    if (usable && ownerFields(lease) && ['claimed', 'shown'].includes(lease.phase) && validTime(lease.expiresAt)
        && (lease.phase === 'shown' || lease.expiresAt > now)) {
        state.lease = { token: lease.token, sessionId: lease.sessionId, tabId: lease.tabId, phase: lease.phase, expiresAt: lease.expiresAt };
    }
    const decision = raw.lastDecision;
    if (usable && ownerFields(decision) && ['later', 'never', 'rate'].includes(decision.choice) && validTime(decision.at)) {
        state.lastDecision = { token: decision.token, sessionId: decision.sessionId, tabId: decision.tabId, choice: decision.choice, at: decision.at };
    }
    // Missing cooldown metadata must not cause a previously displayed invitation to reappear early.
    if (state.lastShownAt) state.cooldownUntil = Math.max(state.cooldownUntil, state.lastShownAt + REVIEW_COOLDOWN_MS);
    return state;
}

export function isReviewEligible(state, now) {
    return !state.suppressed && state.shownCount < REVIEW_MAX_SHOWS
        && now >= state.firstSeenAt + REVIEW_MIN_AGE_MS
        && state.totalUses >= REVIEW_MIN_USES && state.activeDays.length >= REVIEW_MIN_ACTIVE_DAYS
        && now >= state.cooldownUntil;
}

/** One successful user operation per minute, shared across editor tabs. */
export function recordReviewUsage(state, eventId, kind, now) {
    if (!isReviewId(eventId) || !REVIEW_USAGE_KINDS.includes(kind)) throw new Error('Invalid successful usage event.');
    if (state.suppressed || state.shownCount >= REVIEW_MAX_SHOWS || state.recentEventIds.includes(eventId)) return state;
    const next = { ...state, recentEventIds: [...state.recentEventIds, eventId].slice(-32) };
    if (state.lastCountedAt && now - state.lastCountedAt < REVIEW_USAGE_INTERVAL_MS) return next;
    return { ...next, totalUses: Math.min(state.totalUses + 1, MAX_USES), lastCountedAt: now,
        activeDays: [...new Set([...state.activeDays, reviewDayKey(now)])].sort().slice(-3) };
}
