import { onBeforeUnmount, type Ref } from 'vue';
import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { monacoApi, createMonacoWorker } from '../utils/monacoRuntime';
import { createJsonLanguageActivation } from '../utils/jsonLanguageActivation';
import {
    defineJsonToolMonacoThemes,
    getJsonToolThemeForLanguage,
    type JsonToolThemeMode,
} from '../utils/monacoThemes';

/**
 * 集中管理 JSON 工具的 Monaco Worker、主题与可选语言贡献。
 * themeMode 是当前明暗主题；返回值提供环境初始化、语言注册与按需加载能力。
 */
export const useMonacoLanguageRegistry = (themeMode: Ref<JsonToolThemeMode>) => {
    let jsonLanguageActivation: ReturnType<typeof createJsonLanguageActivation> | undefined;
    let diagnosticsEnabled = true;
    const configureJsonLanguageFeatures = (enabled: boolean) => {
        diagnosticsEnabled = enabled;
        jsonLanguageActivation?.setDiagnosticsEnabled(enabled);
    };
    onBeforeUnmount(() => jsonLanguageActivation?.dispose());
    const registeredLanguages = new Set<string>();
    let goContributionPromise: Promise<unknown> | null = null;
    let typescriptContributionPromise: Promise<unknown> | null = null;

    const registerYamlLanguage = () => {
        if (registeredLanguages.has('yaml')) return;
        registeredLanguages.add('yaml');
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

    const registerXmlLanguage = () => {
        if (registeredLanguages.has('xml')) return;
        registeredLanguages.add('xml');
        monacoApi.languages.register({ id: 'xml' });
        monacoApi.languages.setMonarchTokensProvider('xml', {
            tokenizer: {
                root: [
                    [/<!--/, 'comment', '@comment'],
                    [/<\?xml/, 'metatag', '@processing'],
                    [/<\/?[\w:\-.]+/, 'tag', '@tag'],
                    [/[^<]+/, ''],
                ],
                comment: [
                    [/-->/, 'comment', '@pop'],
                    [/[^-]+/, 'comment'],
                    [/-/, 'comment'],
                ],
                processing: [
                    [/\?>/, 'metatag', '@pop'],
                    [/[^\?]+/, 'metatag'],
                    [/\?/, 'metatag'],
                ],
                tag: [
                    [/\s+/, 'white'],
                    [/[\w:\-.]+(?=\s*=)/, 'attribute.name'],
                    [/=/, 'delimiter'],
                    [/"[^"]*"/, 'attribute.value'],
                    [/'[^']*'/, 'attribute.value'],
                    [/\/?>/, 'tag', '@pop'],
                ],
            },
        });
    };

    const registerHtmlLanguage = () => {
        if (registeredLanguages.has('html')) return;
        registeredLanguages.add('html');
        monacoApi.languages.register({ id: 'html' });
        monacoApi.languages.setMonarchTokensProvider('html', {
            tokenizer: {
                root: [
                    [/<!--/, 'comment', '@comment'],
                    [/<\!DOCTYPE/, 'metatag', '@doctype'],
                    [/<\/?[\w:-]+/, 'tag', '@tag'],
                    [/[^<]+/, ''],
                ],
                comment: [
                    [/-->/, 'comment', '@pop'],
                    [/[^-]+/, 'comment'],
                    [/-/, 'comment'],
                ],
                doctype: [
                    [/>/, 'metatag', '@pop'],
                    [/[^>]+/, 'metatag'],
                ],
                tag: [
                    [/\s+/, 'white'],
                    [/[\w:-]+(?=\s*=)/, 'attribute.name'],
                    [/=/, 'delimiter'],
                    [/"[^"]*"/, 'attribute.value'],
                    [/'[^']*'/, 'attribute.value'],
                    [/\/?>/, 'tag', '@pop'],
                ],
            },
        });
    };

    const registerCssLanguage = () => {
        if (registeredLanguages.has('css')) return;
        registeredLanguages.add('css');
        monacoApi.languages.register({ id: 'css' });
        monacoApi.languages.setMonarchTokensProvider('css', {
            tokenizer: {
                root: [
                    [/\s+/, 'white'],
                    [/\/\*/, 'comment', '@comment'],
                    [/@[a-z-]+/i, 'keyword'],
                    [/[.#]?[a-zA-Z_][\w-]*(?=\s*[\{,])/, 'tag'],
                    [/\{/, 'delimiter.bracket', '@rulebody'],
                ],
                comment: [
                    [/\*\//, 'comment', '@pop'],
                    [/[^*]+/, 'comment'],
                    [/\*/, 'comment'],
                ],
                rulebody: [
                    [/\s+/, 'white'],
                    [/\/\*/, 'comment', '@comment'],
                    [/[a-z-]+(?=\s*:)/i, 'attribute.name'],
                    [/:/, 'delimiter'],
                    [/"[^"]*"/, 'string'],
                    [/'[^']*'/, 'string'],
                    [/#{0,1}[0-9a-fA-F]{3,8}\b/, 'number.hex'],
                    [/-?\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms|deg)?\b/, 'number'],
                    [/[a-z-]+\(/i, 'keyword'],
                    [/;/, 'delimiter'],
                    [/\}/, 'delimiter.bracket', '@pop'],
                ],
            },
        });
    };

    const registerTomlLanguage = () => {
        if (registeredLanguages.has('toml')) return;
        registeredLanguages.add('toml');
        monacoApi.languages.register({ id: 'toml' });
        monacoApi.languages.setMonarchTokensProvider('toml', {
            tokenizer: {
                root: [
                    [/#.*$/, 'comment'],
                    [/^\s*\[.+?\]\s*$/, 'type.identifier'],
                    [/^\s*\[\[.+?\]\]\s*$/, 'type.identifier'],
                    [/\b(true|false)\b/, 'keyword'],
                    [/\b\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?\b/, 'string.date'],
                    [/\[/, { token: 'delimiter.bracket', next: '@inline_array' }],
                    [/^[a-zA-Z_][a-zA-Z0-9_\-]*/, 'variable'],
                    [/=/, 'delimiter'],
                    [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],
                    [/-?\d+\.?\d*([eE][+-]?\d+)?/, 'number'],
                ],
                inline_array: [
                    [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
                    [/,/, 'delimiter'],
                    [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],
                    [/-?\d+\.?\d*([eE][+-]?\d+)?/, 'number'],
                    [/\b(true|false)\b/, 'keyword'],
                    [/\s+/, 'white'],
                ],
            },
        });
    };

    /** 注册项目自定义的轻量语言分词器；language 是 Monaco 语言 ID，无返回值。 */
    const ensureMonacoLanguageRegistered = (language: string): void => {
        switch (language) {
            case 'yaml':
                registerYamlLanguage();
                break;
            case 'xml':
                registerXmlLanguage();
                break;
            case 'html':
                registerHtmlLanguage();
                break;
            case 'css':
                registerCssLanguage();
                break;
            case 'toml':
                registerTomlLanguage();
                break;
        }
    };

    /** 按语言动态加载 Monaco 官方贡献；language 是语言 ID，Promise 在贡献可用后完成。 */
    const loadMonacoLanguageContribution = async (language: string): Promise<void> => {
        ensureMonacoLanguageRegistered(language);
        if (language === 'go') {
            if (!goContributionPromise) {
                goContributionPromise = import('monaco-editor/esm/vs/basic-languages/go/go.contribution');
            }
            await goContributionPromise;
        } else if (language === 'typescript') {
            if (!typescriptContributionPromise) {
                typescriptContributionPromise = import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution');
            }
            await typescriptContributionPromise;
        }
    };

    /** 初始化 Monaco 的 Worker 路由和项目主题，无输入参数与返回值。 */
    const initializeMonacoEnvironment = (): void => {
        if (typeof window === 'undefined') return;
        jsonLanguageActivation ??= createJsonLanguageActivation(
            monacoApi.editor,
            configuration => monacoApi.languages.json.jsonDefaults.setModeConfiguration(configuration),
            diagnosticsEnabled,
        );
        window.MonacoEnvironment = {
            getWorker(_, label): Worker {
                return createMonacoWorker(label);
            },
        };

        defineJsonToolMonacoThemes(monacoApi);
        monacoApi.editor.setTheme(getJsonToolThemeForLanguage('json', themeMode.value));
    };

    return {
        ensureMonacoLanguageRegistered,
        loadMonacoLanguageContribution,
        initializeMonacoEnvironment,
        configureJsonLanguageFeatures,
    };
};
