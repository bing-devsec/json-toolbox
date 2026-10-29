import type { RepairLimits } from './types';

export function createRepairLimits(inputLength: number, overrides: Partial<RepairLimits>): RepairLimits {
    return {
        maxDepth: 128,
        maxEdits: 256,
        maxWork: inputLength * 8 + 32768,
        maxDurationMs: 2500,
        maxLookahead: 32768,
        ...overrides,
    };
}
