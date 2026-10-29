import { normalizeJsonNumberLiteral, tryParseHighPrecisionWrapper } from './jsonEngine/numberLiteral';

const INITIALISMS = new Map([
    'ACL', 'API', 'ASCII', 'CPU', 'CSS', 'DNS', 'EOF', 'GUID', 'HTML', 'HTTP', 'HTTPS', 'ID', 'IP',
    'JSON', 'LHS', 'QPS', 'RAM', 'RHS', 'RPC', 'SLA', 'SMTP', 'SQL', 'SSH', 'TCP', 'TLS', 'TTL',
    'UDP', 'UI', 'UID', 'UUID', 'URI', 'URL', 'UTF8', 'VM', 'XML', 'XMPP', 'XSRF', 'XSS',
].map((value) => [value.toLowerCase(), value]));

const COMMON_FIELDS = new Set([
    'id', 'uid', 'uuid', 'name', 'title', 'type', 'status', 'code', 'message', 'msg', 'data', 'meta',
    'result', 'value', 'count', 'total', 'page', 'size', 'list', 'items', 'detail', 'description',
    'desc', 'content', 'label', 'key', 'path', 'url', 'uri', 'ip', 'host', 'port', 'user', 'userid',
    'username', 'email', 'phone', 'mobile', 'age', 'gender', 'address', 'city', 'province', 'country',
    'createdat', 'updatedat', 'deletedat', 'starttime', 'endtime', 'success', 'error', 'enabled', 'disabled',
]);

type JsonObject = Record<string, unknown>;
type GoType =
    | { kind: 'primitive'; name: string }
    | { kind: 'struct'; schema: Schema }
    | { kind: 'slice' | 'map' | 'pointer'; element: GoType };
interface Field {
    key: string;
    name: string;
    type: GoType;
    optional: boolean;
}
interface Shape { keys: string[]; kinds: string[] }
interface Schema {
    name: string;
    slot: string;
    ancestors: Schema[];
    samples: JsonObject[];
    seen: WeakSet<JsonObject>;
    shapes: Shape[];
    fields: Field[];
    queued: boolean;
}

const primitive = (name: string): GoType => ({ kind: 'primitive', name });
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNull = (value: unknown) => value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value));

const exportedName = (value: string): string => {
    const parts = value.replace(/[^a-zA-Z0-9]+/g, ' ').split(/\s+/).filter(Boolean)
        .flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || []);
    const name = parts.map((part) => INITIALISMS.get(part.toLowerCase()) || part[0]!.toUpperCase() + part.slice(1).toLowerCase()).join('') || 'Field';
    return /^\d/.test(name) ? `Field${name}` : name;
};

// Go's encoding/json reserves empty names, '-', commas, quotes and backslashes in tags.
const canUseJsonTag = (key: string): boolean => key !== '' && key !== '-' && [...key].every((char) =>
    '!#$%&()*+-./:;<=>?@[]^_{|}~ '.includes(char) || /^[\p{L}\p{Nd}]$/u.test(char),
);

const decimalSignature = (literal: string): string => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal)!;
    let digits = (match[2]! + (match[3] || '')).replace(/^0+/, '');
    if (!digits) return '0';
    const trimmed = digits.replace(/0+$/, '');
    const exponent = BigInt(match[4] || '0') - BigInt((match[3] || '').length) + BigInt(digits.length - trimmed.length);
    digits = trimmed;
    return `${match[1]}${digits}e${exponent}`;
};

const readNumberLiteral = (value: unknown): string | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;
    const protectedLiteral = tryParseHighPrecisionWrapper(value);
    return protectedLiteral === null ? null : normalizeJsonNumberLiteral(protectedLiteral);
};

const floatPreservesNumber = (literal: string): boolean => {
    const number = Number(literal);
    return Number.isFinite(number) && decimalSignature(literal) === decimalSignature(String(number));
};

const numericType = (literals: string[]): GoType => {
    if (literals.some((literal) => /[.eE]/.test(literal))) {
        return primitive(literals.every(floatPreservesNumber) ? 'float64' : 'json.Number');
    }
    const integers = literals.map((literal) => BigInt(literal));
    const fits = (min: bigint, max: bigint) => integers.every((value) => value >= min && value <= max);
    if (fits(-2147483648n, 2147483647n)) return primitive('int');
    if (fits(-9223372036854775808n, 9223372036854775807n)) return primitive('int64');
    if (fits(0n, 18446744073709551615n)) return primitive('uint64');
    return primitive('json.Number');
};

// A heterogeneous value decoded as any would turn every number into float64.
const needsRawMessage = (values: unknown[]): boolean => {
    const pending = [...values];
    const seen = new WeakSet<object>();
    while (pending.length) {
        const value = pending.pop();
        const literal = readNumberLiteral(value);
        if (literal !== null) {
            if (!floatPreservesNumber(literal)) return true;
        } else if (value && typeof value === 'object' && !seen.has(value)) {
            seen.add(value);
            for (const child of Object.values(value)) pending.push(child);
        }
    }
    return false;
};

const valueKind = (value: unknown): string => {
    if (isNull(value)) return 'unknown';
    if (readNumberLiteral(value) !== null) return 'number';
    if (Array.isArray(value)) return 'array';
    return typeof value;
};

const shapeOf = (value: JsonObject): Shape => {
    const keys = Object.keys(value).sort();
    return { keys, kinds: keys.map((key) => valueKind(value[key])) };
};
const sameShape = (left: Shape, right: Shape) => left.keys.length === right.keys.length && left.keys.every((key, i) =>
    key === right.keys[i] && (left.kinds[i] === right.kinds[i] || left.kinds[i] === 'unknown' || right.kinds[i] === 'unknown'),
);

const mapLike = (value: JsonObject): boolean => {
    const keys = Object.keys(value);
    if (!keys.length) return false;
    const indexPatterns = [/^\d+$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, /^[a-z]{2,3}(?:[-_](?:[A-Z]{2}|\d{3}|[A-Za-z]{4,8}))+$/];
    if (indexPatterns.some((pattern) => keys.every((key) => pattern.test(key)))) return true;
    const suffixPattern = /^(?:[a-z][a-z0-9]*[-_])+\d+$/i;
    const suffixes = keys.filter((key) => suffixPattern.test(key)).length;
    // A few similarly shaped business properties (billing/shipping, source/target) are not dictionary evidence.
    if (keys.length < 8 && suffixes < 2) return false;
    const values = Object.values(value).filter((child) => !isNull(child));
    if (!values.length) return false;
    let score = keys.length <= 2 ? -1 : keys.length <= 4 ? -2 : keys.length >= 8 ? 1 : 0;
    const count = (pattern: RegExp) => keys.filter((key) => pattern.test(key)).length;
    for (const pattern of [/^\d+$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i]) {
        const matches = count(pattern);
        if (matches === keys.length) score += 4;
        else if (matches >= 2 && matches >= Math.ceil(keys.length / 2)) score += 3;
    }
    const locales = count(/^[a-z]{2,3}(?:[-_](?:[A-Z]{2}|\d{3}|[A-Za-z]{4,8}))+$/);
    if (locales === keys.length) score += 3;
    else if (locales >= 2 && locales >= Math.ceil(keys.length / 2)) score += 2;
    if (suffixes >= 2 && suffixes >= Math.ceil(keys.length / 2)) score += 2;
    if (keys.filter((key) => COMMON_FIELDS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))).length >= Math.ceil(keys.length * 0.6)) score -= 3;
    const kinds = new Set(values.map((child) => isObject(child) ? JSON.stringify(shapeOf(child)) : valueKind(child)));
    if (kinds.size === 1) score += valueKind(values[0]) === 'object' ? 4 : 3;
    else score -= kinds.size >= 3 ? 3 : 1;
    return score >= 3;
};

const nullable = (type: GoType): GoType =>
    type.kind === 'struct' || (type.kind === 'primitive' && !['any', 'json.RawMessage'].includes(type.name))
        ? { kind: 'pointer', element: type } : type;

const typeText = (type: GoType): string => {
    switch (type.kind) {
        case 'primitive': return type.name;
        case 'struct': return type.schema.name;
        case 'slice': return `[]${typeText(type.element)}`;
        case 'map': return `map[string]${typeText(type.element)}`;
        case 'pointer': return `*${typeText(type.element)}`;
    }
};

export const convertJsonToGo = (input: unknown): string => {
    const usedTypeNames = new Set(['Root']);
    const slots = new Map<string, Schema>();
    const pending: Schema[] = [];
    const shapeCache = new WeakMap<JsonObject, Shape>();
    const shape = (value: JsonObject): Shape => {
        let result = shapeCache.get(value);
        if (!result) { result = shapeOf(value); shapeCache.set(value, result); }
        return result;
    };
    const uniqueTypeName = (preferred: string, root: boolean): string => {
        const base = exportedName(preferred);
        if (root) return 'Root';
        let name = base, suffix = 2;
        while (usedTypeNames.has(name)) name = `${base}${suffix++}`;
        usedTypeNames.add(name);
        return name;
    };
    const appendSamples = (schema: Schema, objects: JsonObject[]): boolean => {
        let changed = false;
        for (const object of objects) {
            if (schema.seen.has(object)) continue;
            schema.seen.add(object);
            schema.samples.push(object);
            const candidate = shape(object);
            if (!schema.shapes.some((known) => sameShape(known, candidate))) schema.shapes.push(candidate);
            changed = true;
        }
        if (changed && !schema.queued) { schema.queued = true; pending.push(schema); }
        return changed;
    };
    const appendRecursiveSamples = (schema: Schema, objects: JsonObject[]) => {
        if (!appendSamples(schema, objects)) return;
        // Gather matching descendants in one walk, avoiding a full rebuild for each recursion level.
        const descendants: unknown[] = objects.flatMap((object) => Object.values(object));
        const visited = new WeakSet<object>(objects);
        while (descendants.length) {
            const value = descendants.pop();
            if (!value || typeof value !== 'object' || visited.has(value)) continue;
            visited.add(value);
            if (isObject(value) && schema.shapes.some((known) => sameShape(known, shape(value)))) appendSamples(schema, [value]);
            for (const child of Object.values(value)) descendants.push(child);
        }
    };
    const unknownType = (values: unknown[]) => primitive(needsRawMessage(values) ? 'json.RawMessage' : 'any');

    const infer = (values: unknown[], preferred: string, slot: string, ancestors: Schema[]): GoType => {
        const nonNull = values.filter((value) => !isNull(value));
        if (!nonNull.length) return primitive('any');
        const kinds = new Set(nonNull.map(valueKind));
        let type: GoType;
        if (kinds.size !== 1) {
            type = unknownType(values);
        } else if (kinds.has('number')) {
            type = numericType(nonNull.map((value) => readNumberLiteral(value)!));
        } else if (kinds.has('string') || kinds.has('boolean')) {
            type = primitive(kinds.has('string') ? 'string' : 'bool');
        } else if (kinds.has('array')) {
            const elements: unknown[] = [];
            for (const array of nonNull as unknown[][]) for (const element of array) elements.push(element);
            type = { kind: 'slice', element: infer(elements, slot === '$' ? 'Item' : preferred, `${slot}/[]`, ancestors) };
        } else if (kinds.has('object')) {
            const objects = nonNull as JsonObject[];
            const nonEmpty = objects.filter((object) => Object.keys(object).length);
            // Decide once for the whole sample group, and retain every key if any tag is unrepresentable.
            if (objects.some((object) => Object.keys(object).some((key) => !canUseJsonTag(key))) || (nonEmpty.length > 0 && nonEmpty.every(mapLike))) {
                const mapValues: unknown[] = [];
                for (const object of objects) for (const value of Object.values(object)) mapValues.push(value);
                type = { kind: 'map', element: infer(mapValues, `${preferred}Value`, `${slot}/{}`, ancestors) };
            } else {
                const ancestor = [...ancestors].reverse().find((schema) => objects.some((object) =>
                    schema.shapes.some((known) => sameShape(known, shape(object))),
                ));
                let schema = ancestor || slots.get(slot);
                if (ancestor) {
                    appendRecursiveSamples(ancestor, objects);
                } else {
                    if (!schema) {
                        schema = {
                            name: uniqueTypeName(preferred, slot === '$'), slot, ancestors,
                            samples: [], seen: new WeakSet(), shapes: [], fields: [], queued: false,
                        };
                        slots.set(slot, schema);
                    }
                    appendSamples(schema, objects);
                }
                type = { kind: 'struct', schema: schema! };
            }
        } else {
            type = unknownType(values);
        }
        return values.some(isNull) ? nullable(type) : type;
    };

    const root = infer([input], 'Root', '$', []);
    for (let index = 0; index < pending.length; index++) {
        const schema = pending[index]!;
        schema.queued = false;
        const samples = [...schema.samples];
        const fieldValues = new Map<string, unknown[]>();
        for (const sample of samples) for (const [key, value] of Object.entries(sample)) {
            let values = fieldValues.get(key);
            if (!values) { values = []; fieldValues.set(key, values); }
            values.push(value);
        }
        const reservedNames = new Set([...fieldValues.keys()].map(exportedName));
        const names = new Set<string>();
        schema.fields = [...fieldValues].map(([key, values]) => {
            const base = exportedName(key);
            let name = base, suffix = 2;
            while (names.has(name)) {
                do { name = `${base}${suffix++}`; } while (reservedNames.has(name) || names.has(name));
            }
            names.add(name);
            const optional = values.length < samples.length;
            let type = infer(values, key, `${schema.slot}/${JSON.stringify(key)}`, [...schema.ancestors, schema]);
            if (optional) {
                if (values.some(isNull)) {
                    // RawMessage distinguishes an absent field (nil) from explicit null (the bytes "null").
                    type = primitive('json.RawMessage');
                } else if (type.kind !== 'pointer') {
                    type = { kind: 'pointer', element: type };
                }
            }
            return { key, name, type, optional };
        });
    }

    // Emit only reachable definitions; provisional map/struct choices may have left obsolete schemas.
    const types: GoType[] = [root];
    const reachable: Schema[] = [];
    const visited = new Set<Schema>();
    let importsJson = false;
    for (let index = 0; index < types.length; index++) {
        const type = types[index]!;
        if (type.kind === 'primitive') {
            if (type.name.startsWith('json.')) importsJson = true;
        } else if (type.kind === 'struct') {
            if (!visited.has(type.schema)) {
                visited.add(type.schema);
                reachable.push(type.schema);
                for (const field of type.schema.fields) types.push(field.type);
            }
        } else {
            types.push(type.element);
        }
    }

    // A struct-by-value cycle is illegal in Go. Slices, maps and pointers already break that cycle.
    const state = new Map<Schema, 'visiting' | 'done'>();
    for (const start of reachable) {
        if (state.has(start)) continue;
        const stack = [{ schema: start, index: 0 }];
        state.set(start, 'visiting');
        while (stack.length) {
            const frame = stack[stack.length - 1]!;
            const field = frame.schema.fields[frame.index++];
            if (!field) { state.set(frame.schema, 'done'); stack.pop(); continue; }
            if (field.type.kind !== 'struct') continue;
            const target = field.type.schema;
            if (state.get(target) === 'visiting') field.type = { kind: 'pointer', element: field.type };
            else if (!state.has(target)) { state.set(target, 'visiting'); stack.push({ schema: target, index: 0 }); }
        }
    }

    const definitions = reachable.reverse().map((schema) => {
        const fields = schema.fields.map((field) => {
            const tag = JSON.stringify(`${field.key}${field.optional ? ',omitempty' : ''}`);
            return `    ${field.name} ${typeText(field.type)} \`json:${tag}\``;
        });
        return `type ${schema.name} struct {\n${fields.length ? fields.join('\n') + '\n' : ''}}`;
    });
    if (root.kind !== 'struct') {
        const externalAlias = root.kind === 'primitive' && root.name.startsWith('json.') ? '= ' : '';
        definitions.push(`type Root ${externalAlias}${typeText(root)}`);
    }
    return `${importsJson ? 'import "encoding/json"\n\n' : ''}${definitions.join('\n\n')}`;
};
