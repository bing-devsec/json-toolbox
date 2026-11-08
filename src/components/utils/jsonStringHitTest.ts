import { visit } from 'jsonc-parser';

export interface JsonStringOffsets {
    offset: number;
    length: number;
}

const stopVisit = Symbol('stop JSON string hit test');
const maxPrefixLength = 256 * 1024;

// Only opt into a prefix parse when a short, local line scan suggests a string.
// Without this gate, a double-click on a number near EOF would scan the document
// once here and again in the AST fallback. Long/minified lines stay on the
// original path. A false negative only skips the optimization, never the lookup.
const mayHitStringOnLine = (content: string, targetOffset: number): boolean => {
    const maxLinePrefix = 2048;
    let lineStart = targetOffset;
    while (lineStart > 0) {
        const previous = content.charCodeAt(lineStart - 1);
        if (previous === 10 || previous === 13) break;
        if (targetOffset - lineStart >= maxLinePrefix) return false;
        lineStart--;
    }

    let inString = false;
    let escaped = false;
    let atStringEnd = false;
    for (let offset = lineStart; offset < targetOffset; offset++) {
        const character = content.charCodeAt(offset);
        if (inString) {
            if (escaped) escaped = false;
            else if (character === 92) escaped = true;
            else if (character === 34) {
                inString = false;
                atStringEnd = offset + 1 === targetOffset;
            }
        } else if (character === 34) {
            inString = true;
        } else if (character === 47) {
            // Comment context is uncertain without parsing earlier lines.
            return false;
        }
    }
    return inString || atStringEnd || content.charCodeAt(targetOffset) === 34;
};

/**
 * A conservative fast path for the editor's primary UTF-16 offset. The visitor
 * uses the same parser/options as parseTree, without building a document tree.
 * A successful callback identifies the first string covering that offset,
 * including its right boundary, just like the existing depth-first AST search.
 * Later syntax errors cannot remove an already emitted string from that tree.
 *
 * A parse error, non-string token, or missed offset is deliberately inconclusive:
 * callers must retain the AST search, including its offset-minus-one retry.
 * Only the first 256 Ki UTF-16 units are eligible. Truncating the visitor input
 * also bounds scanning of a huge unterminated token/comment; a truncated token
 * is inconclusive and falls back. No document tree or prefix is cached.
 */
export const findJsonStringRangeByPrefix = (content: string, targetOffset: number): JsonStringOffsets | null => {
    if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset > content.length) return null;
    if (targetOffset > maxPrefixLength) return null;
    if (!mayHitStringOnLine(content, targetOffset)) return null;

    let matched: JsonStringOffsets | null = null;
    const stopAtOrBefore = (offset: number) => {
        if (targetOffset <= offset) throw stopVisit;
    };
    const onString = (_value: string, offset: number, length: number) => {
        if (targetOffset <= offset + length) {
            if (targetOffset >= offset && length >= 2) matched = { offset, length };
            throw stopVisit;
        }
    };

    try {
        visit(content.length > maxPrefixLength ? content.slice(0, maxPrefixLength) : content, {
            onObjectBegin: stopAtOrBefore,
            onArrayBegin: stopAtOrBefore,
            onObjectEnd: stopAtOrBefore,
            onArrayEnd: stopAtOrBefore,
            onObjectProperty: onString,
            onLiteralValue: (value, offset, length) => {
                if (typeof value === 'string') onString(value, offset, length);
                else stopAtOrBefore(offset + length);
            },
            onSeparator: (_separator, offset) => stopAtOrBefore(offset),
            onComment: (offset, length) => stopAtOrBefore(offset + length),
            onError: () => { throw stopVisit; },
        }, {
            allowTrailingComma: true,
            disallowComments: false,
            allowEmptyContent: true,
        });
    } catch (error) {
        if (error !== stopVisit) throw error;
    }

    return matched;
};
