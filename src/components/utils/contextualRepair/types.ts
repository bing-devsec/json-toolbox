/** Source offsets are UTF-16 editor offsets; edits never reinterpret number literals. */
export interface RepairEdit {
    start: number;
    end: number;
    text: string;
    reason: string;
    risk: 'syntax' | 'inferred';
}

export interface RepairLimits {
    maxDepth: number;
    maxEdits: number;
    maxWork: number;
    maxDurationMs: number;
    maxLookahead: number;
}

export interface ContextRepairResult {
    rootEnd?: number;
    /** Complete extension structure was checked; compatibility conversion is permitted. */
    legacyCompatible?: boolean;
    status: 'repaired' | 'unchanged' | 'unsupported' | 'unsafe' | 'limit';
    text?: string;
    edits: RepairEdit[];
    reason?: string;
    work?: number;
}

export interface RepairStringContext {
    consumeBudget?: (cost: number) => boolean;
    role: 'key' | 'value';
    container: 'object' | 'array' | 'root';
    depth: number;
    expectedClosers: string[];
    maxLookahead: number;
    maxDepth: number;
    maxEdits: number;
}

export interface RepairStringScan {
    end: number;
    edits: RepairEdit[];
    closed: boolean;
    ambiguous?: boolean;
}
