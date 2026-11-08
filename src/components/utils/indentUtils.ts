// 缩进检测与重排

// 从内容中检测缩进大小（以空格数为单位）
// fallback: 当无法识别时返回的默认值
export const detectIndentSize = (content: string, fallback: number = 4): number => {
    let minIndent = Infinity;
    let start = 0;
    while (start < content.length) {
        const newline = content.indexOf('\n', start);
        const end = newline < 0 ? content.length : newline;
        let cursor = start;
        while (cursor < end && cursor - start <= 16 && content.charCodeAt(cursor) === 32) cursor++;
        const indent = cursor - start;
        // Preserve the original /^( +)\S/ semantics: tabs and other whitespace do not count.
        if (indent > 0 && indent <= 16 && cursor < end && /\S/.test(content[cursor])) {
            minIndent = Math.min(minIndent, indent);
            if (minIndent === 1) return 1;
        }
        if (newline < 0) break;
        start = newline + 1;
    }
    return minIndent <= 8 ? minIndent : fallback;
};

// 重新格式化JSON字符串的缩进，保持内容不变（不解析转义序列）
export const reformatJsonIndentation = (jsonString: string, newIndentSize: number): string => {
    // 目标：仅调整缩进显示，不解析或改变字符串中的转义序列
    // Find the minimum leading whitespace without retaining one string per line.
    const whitespace = /\s/;
    let currentIndentSize = Infinity;
    let lineStart = 0;
    while (lineStart < jsonString.length) {
        const newline = jsonString.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? jsonString.length : newline;
        let cursor = lineStart;
        while (cursor < lineEnd && (jsonString.charCodeAt(cursor) === 32 || whitespace.test(jsonString[cursor]))) cursor++;
        // Whitespace-only lines do not contribute to the minimum indentation.
        if (cursor > lineStart && cursor < lineEnd) {
            currentIndentSize = Math.min(currentIndentSize, cursor - lineStart);
            if (currentIndentSize === 1) break;
        }
        if (newline < 0) break;
        lineStart = newline + 1;
    }

    // 如果没有可检测的缩进，直接返回原文
    if (currentIndentSize === Infinity) return jsonString;

    // 使用最小缩进作为当前缩进单位
    if (currentIndentSize === newIndentSize) return jsonString;

    // Match trim() whitespace, with an ASCII fast path for ordinary JSON lines.
    const isWhitespace = (index: number): boolean => {
        const code = jsonString.charCodeAt(index);
        return code === 32 || (code >= 9 && code <= 13)
            || (code > 127 && whitespace.test(jsonString[index]));
    };
    // Join small batches instead of retaining a string/rope for every input line.
    const chunks: string[] = [];
    const parts: string[] = [];
    const indentCache: string[] = [];
    lineStart = 0;
    while (lineStart < jsonString.length) {
        const newline = jsonString.indexOf('\n', lineStart);
        const lineEnd = newline < 0 ? jsonString.length : newline;
        let start = lineStart;
        let end = lineEnd;
        while (start < end && isWhitespace(start)) start++;
        while (end > start && isWhitespace(end - 1)) end--;
        if (start < end) {
            const originalIndentLen = start - lineStart;
            const level = Math.floor(originalIndentLen / currentIndentSize);
            // Bound the cache; non-number callers must retain per-line coercion.
            const cacheable = typeof newIndentSize === 'number' && level < 64;
            let newIndent = cacheable ? indentCache[level] : undefined;
            if (newIndent === undefined) {
                newIndent = ' '.repeat(level * newIndentSize);
                if (cacheable) indentCache[level] = newIndent;
            }
            parts.push(newIndent + jsonString.slice(start, end));
        }
        if (newline >= 0) parts.push('\n');
        if (parts.length >= 2048) {
            chunks.push(parts.join(''));
            parts.length = 0;
        }
        if (newline < 0) break;
        lineStart = newline + 1;
    }
    if (parts.length) chunks.push(parts.join(''));
    return chunks.join('');
};
