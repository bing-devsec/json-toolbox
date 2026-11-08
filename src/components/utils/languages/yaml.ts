import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const register = (monacoApi: typeof monaco) => {
    monacoApi.languages.register({ id: 'yaml' });
    // 使用行状态记录块标量的动态缩进，避免正文被按普通 YAML 结构分词。
    class YamlState implements monaco.languages.IState {
        constructor(
            readonly blockIndent: number | null = null,
            readonly contentIndent: number | null = null,
            readonly pendingIndent: number | null = null,
        ) {}
        clone(): YamlState {
            return new YamlState(this.blockIndent, this.contentIndent, this.pendingIndent);
        }
        equals(other: monaco.languages.IState): boolean {
            return other instanceof YamlState && this.blockIndent === other.blockIndent
                && this.contentIndent === other.contentIndent && this.pendingIndent === other.pendingIndent;
        }
    }
    const blockHeader = /[|>](?:[+-][1-9]?|[1-9][+-]?)?(?=$|[ \t]+(?:#.*)?$)/y;
    // 沿用普通键、引号和标量的匹配顺序；sticky 正则从当前位置读取，避免反复复制长行。
    const rules: [RegExp, string][] = [
        [/\s+/y, 'white'],
        [/#.*$/y, 'comment'],
        [/-(?=\s|$)/y, 'keyword'],
        [/"(?:[^"\\]|\\.)*"(?=[ \t]*:)/y, 'type'],
        [/'(?:[^']|'')*'(?=[ \t]*:)/y, 'type'],
        [/[^\s:#\[\]{},'"][^:#\[\]{},'"]*(?=:(?:\s|$))/y, 'type'],
        [/(?:true|false|null|~)(?=\s*(?:$|#|[,\]}]))/iy, 'keyword'],
        [blockHeader, 'string'],
        [/"(?:[^"\\]|\\.)*"/y, 'string'],
        // YAML 单引号使用两个单引号转义；反斜杠在其中是普通文本。
        [/'(?:[^']|'')*'/y, 'string'],
        [/[+-]?(?:0x[0-9a-f]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\.(?:inf|nan))(?=\s*(?:$|#|[,\]}]))/iy, 'number'],
        [/[:{}\[\],&*?]/y, 'delimiter'],
        [/[^\s"'\[\]{},][^\s\[\]{},]*(?:[ \t]+[^\s#\[\]{},]+)*/y, 'string'],
    ];
    monacoApi.languages.setTokensProvider('yaml', {
        getInitialState: () => new YamlState(),
        tokenize(line, previousState) {
            const state = previousState as YamlState;
            const indent = /^ */.exec(line)![0].length;
            const blank = /^[ \t]*$/.test(line);
            if (state.blockIndent !== null) {
                if (blank || indent >= (state.contentIndent ?? state.blockIndent + 1)) {
                    return {
                        tokens: [{ startIndex: 0, scopes: 'string.yaml' }],
                        // 空行不决定正文缩进，也不结束块标量。
                        endState: blank || state.contentIndent !== null ? state
                            : new YamlState(state.blockIndent, indent),
                    };
                }
            }
            const inheritedIndent = state.blockIndent === null && state.pendingIndent !== null
                && (blank || indent > state.pendingIndent || line.trimStart().startsWith('#'))
                ? state.pendingIndent : null;
            let blockIndent = inheritedIndent ?? indent;
            let keyIndent = indent;
            let pendingIndent = inheritedIndent;
            let nextState: YamlState | null = null;
            const tokens: monaco.languages.IToken[] = [];
            let offset = 0;
            while (offset < line.length) {
                let length = 1;
                let scopes = '';
                for (const [pattern, type] of rules) {
                    pattern.lastIndex = offset;
                    const match = pattern.exec(line);
                    if (!match) continue;
                    length = match[0].length;
                    scopes = `${type}.yaml`;
                    if (type !== 'white' && type !== 'comment') {
                        pendingIndent = null;
                        if (type === 'type') {
                            keyIndent = blockIndent = offset;
                        } else if (type === 'keyword' && match[0] === '-') {
                            blockIndent = offset;
                            pendingIndent = offset;
                        } else if (type === 'delimiter' && match[0] === ':') {
                            pendingIndent = keyIndent;
                        } else if (pattern === blockHeader) {
                            const explicitIndent = /[1-9]/.exec(match[0]);
                            nextState = new YamlState(blockIndent,
                                explicitIndent ? blockIndent + Number(explicitIndent[0]) : null);
                        }
                    }
                    break;
                }
                if (tokens.at(-1)?.scopes !== scopes) tokens.push({ startIndex: offset, scopes });
                offset += length;
            }
            return { tokens, endState: nextState ?? new YamlState(null, null, pendingIndent) };
        },
    });
};
