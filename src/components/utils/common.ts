// 通用工具：语言识别、文本宽度测量、防抖、延时、存档名清理

export type EditorContentLanguage = 'json' | 'yaml' | 'toml' | 'xml' | 'html' | 'css' | 'typescript' | 'plaintext';

// 异步延时
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 防抖函数：在 delay 毫秒内多次触发只执行最后一次
export const debounce = <T extends (...args: any[]) => any>(fn: T, delay: number) => {
    let timer: number | null = null;
    return function (this: any, ...args: Parameters<T>) {
        if (timer) {
            clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
            fn.apply(this, args);
            timer = null;
        }, delay);
    };
};

// 只在语言采样内跳过前导注释，不解析全文，也不改写编辑器内容。
const skipLeadingLanguageComments = (sample: string): number => {
    let index = 0;
    while (index < sample.length) {
        if (/\s/.test(sample[index]!)) {
            index++;
        } else if (sample.startsWith('//', index) || sample[index] === '#') {
            const end = sample.indexOf('\n', index);
            index = end < 0 ? sample.length : end + 1;
        } else if (sample.startsWith('/*', index)) {
            const end = sample.indexOf('*/', index + 2);
            index = end < 0 ? sample.length : end + 2;
        } else {
            break;
        }
    }
    return index;
};

// 根据输入内容识别语言类型
export const detectInputLanguage = (value: string): EditorContentLanguage => {
    const trimmed = value.trim();
    if (!trimmed) return 'json';

    // JSON 必须最先判断
    if (/^[\[{"]/.test(trimmed) || /^(true|false|null|-?\d)/.test(trimmed)) {
        return 'json';
    }

    const sample = trimmed.slice(0, 20000);
    const contentStart = skipLeadingLanguageComments(sample);
    if (contentStart > 0 && contentStart < sample.length) {
        const body = sample.slice(contentStart);
        // 注释后的 TOML 表头、带引号的 YAML/TOML 键仍交给原有格式识别。
        const tableHeader = /^\[\[?([^\]\r\n]+)\]?\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(body);
        const tableName = tableHeader?.[1]?.trim() ?? '';
        const bareTableName = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(tableName)
            && !/^(true|false|null|NaN|Infinity|undefined)$/.test(tableName);
        const tomlTable = tableHeader && (bareTableName
            || body.split('\n').slice(1, 80).some((line) => /^\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*\s*=/.test(line)));
        const quotedKey = /^"(?:[^"\\]|\\.)*"\s*[:=]/.test(body);
        const jsonPrimitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|$|\/|#)(?!\s*[:=])/.test(body);
        if (body[0] === '{' || (body[0] === '[' && !tomlTable)
            || (body[0] === '"' && !quotedKey) || jsonPrimitive) {
            return 'json';
        }
    }
    const sampleLines = sample.split('\n').slice(0, 80);
    const joinedSample = sampleLines.join('\n');

    if (sample.startsWith('<?xml') || (/^<[^!][^>]*>/.test(sample) && /<\/[\w:-]+>/.test(sample) && !/<html[\s>]/i.test(sample))) {
        return 'xml';
    }

    if (/<!doctype\s+html/i.test(sample) || /<(html|head|body|div|span|script|style|main|section|article|template)[\s>]/i.test(sample)) {
        return 'html';
    }

    if ((/@[a-z-]+\b/i.test(sample) || /[.#]?[a-zA-Z][^{\n]*\{/.test(sample)) && /[a-z-]+\s*:\s*[^;\n{}]+;/.test(sample)) {
        return 'css';
    }

    if (sampleLines.some((line) => /^\s*(\[\[?[^\]\n]+\]?\]|[A-Za-z0-9_.-]+\s*=\s*.+)$/.test(line.trim()))) {
        return 'toml';
    }

    if (sampleLines.some((line) => /^\s*-\s+/.test(line)) || sampleLines.some((line) => /^\s*['"]?[A-Za-z0-9_.-]+['"]?\s*:\s*/.test(line))) {
        return 'yaml';
    }

    if (joinedSample.includes('<') && joinedSample.includes('>')) {
        return 'xml';
    }

    return 'plaintext';
};

// 清理存档名称：保留英文/数字/中文及部分常见符号，最长 30 字符
export const normalizeArchiveName = (rawName: string): string => {
    // 允许：英文、数字、中文，以及部分常见符号 - _ + * / = . : @ #
    const allowedCharPattern = /[A-Za-z0-9\u4e00-\u9fa5\-\_\+\*\/=\.\:\@\#]/g;
    const matches = rawName.match(allowedCharPattern);
    if (!matches) return '';
    const normalized = matches.join('');
    return normalized.slice(0, 30);
};

// 测量文本在指定字体下的渲染宽度（带 SSR 降级估算）
export const measureTextWidth = (text: string): number => {
    if (typeof document === 'undefined') {
        // SSR 环境，使用估算
        let width = 0;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char)) {
                width += 12 * 1.2;
            } else {
                width += 12 * 0.6;
            }
        }
        return width;
    }

    // 创建临时元素测量
    const measureEl = document.createElement('span');
    measureEl.style.cssText = `
        position: absolute;
        visibility: hidden;
        white-space: nowrap;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    `;
    measureEl.textContent = text;
    document.body.appendChild(measureEl);
    const width = measureEl.offsetWidth;
    document.body.removeChild(measureEl);
    return width;
};
