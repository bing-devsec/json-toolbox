import { interfaceStyles, getInterfacePalette, normalizeInterfaceStyle } from '../../themes/interfaceThemes';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const JSON_TOOL_LIGHT_THEME = 'json-tool-light-theme';
export const JSON_TOOL_DARK_THEME = 'json-tool-dark-theme';
export const JSON_TOOL_TOML_THEME = 'json-tool-toml-theme';
export const JSON_TOOL_TOML_DARK_THEME = 'json-tool-toml-dark-theme';

export type JsonToolThemeMode = 'light' | 'dark';

const currentLineHighlightColors = {
    'editor.lineHighlightBackground': '#EAF8EF',
    'editor.lineHighlightBorder': '#00000000',
};

const darkCurrentLineHighlightColors = {
    'editor.lineHighlightBackground': '#2A2D35',
    'editor.lineHighlightBorder': '#00000000',
    'editor.background': '#1E1E1E',
    'editor.foreground': '#CCCCCC',
    'editorGutter.background': '#181818',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#C6C6C6',
    'editorCursor.foreground': '#AEAFAD',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
};

export const getJsonToolThemeForLanguage = (language: string, mode: JsonToolThemeMode = 'light') => {
    const style = normalizeInterfaceStyle(typeof document === 'undefined' ? undefined : document.body.dataset.interfaceStyle);
    if (style !== 'default') return `json-tool-${style}-${mode}-${language === 'toml' ? 'toml' : 'code'}`;
    if (language === 'toml') {
        return mode === 'dark' ? JSON_TOOL_TOML_DARK_THEME : JSON_TOOL_TOML_THEME;
    }
    return mode === 'dark' ? JSON_TOOL_DARK_THEME : JSON_TOOL_LIGHT_THEME;
};

export const defineJsonToolMonacoThemes = (monacoApi: typeof Monaco) => {
    monacoApi.editor.defineTheme(JSON_TOOL_LIGHT_THEME, {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: currentLineHighlightColors,
    });

    monacoApi.editor.defineTheme(JSON_TOOL_DARK_THEME, {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: darkCurrentLineHighlightColors,
    });

    monacoApi.editor.defineTheme(JSON_TOOL_TOML_THEME, {
        base: 'vs',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '6A9955' },
            { token: 'variable', foreground: '0011FF' },
            { token: 'type.identifier', foreground: 'AF00DB' },
            { token: 'string', foreground: 'A31515' },
            { token: 'string.date', foreground: '098658' },
            { token: 'number', foreground: '098658' },
            { token: 'keyword', foreground: '0000FF' },
        ],
        colors: currentLineHighlightColors,
    });

    monacoApi.editor.defineTheme(JSON_TOOL_TOML_DARK_THEME, {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '6A9955' },
            { token: 'variable', foreground: '9CDCFE' },
            { token: 'type.identifier', foreground: '4EC9B0' },
            { token: 'string', foreground: 'CE9178' },
            { token: 'string.date', foreground: 'B5CEA8' },
            { token: 'number', foreground: 'B5CEA8' },
            { token: 'keyword', foreground: '569CD6' },
        ],
        colors: darkCurrentLineHighlightColors,
    });
    for (const style of interfaceStyles) {
        if (style.id === 'default') continue;
        for (const mode of ['light', 'dark'] as const) {
            const p = getInterfacePalette(style.id, mode)!;
            for (const language of ['code', 'toml']) {
                monacoApi.editor.defineTheme(`json-tool-${style.id}-${mode}-${language}`, {
                    base: mode === 'dark' ? 'vs-dark' : 'vs', inherit: true,
                    rules: language === 'toml' ? [
                        { token: 'comment', foreground: mode === 'dark' ? '8CAA79' : '557144' },
                        { token: 'variable', foreground: mode === 'dark' ? '9CDCFE' : '0011FF' },
                        { token: 'type.identifier', foreground: mode === 'dark' ? '4EC9B0' : 'AF00DB' },
                        { token: 'string.date', foreground: mode === 'dark' ? 'B5CEA8' : '098658' },
                        { token: 'keyword', foreground: mode === 'dark' ? '569CD6' : '0000FF' },
                        { token: 'string', foreground: mode === 'dark' ? 'CE9178' : 'A31515' },
                        { token: 'number', foreground: mode === 'dark' ? 'B5CEA8' : '098658' },
                    ] : [],
                    colors: {
                        'editor.background': p.editor, 'editor.foreground': p.text,
                        'editorGutter.background': p.gutter ?? p.editor, 'editorLineNumber.foreground': p.muted,
                        'editorLineNumber.activeForeground': p.text, 'editorCursor.foreground': p.accent,
                        'editor.lineHighlightBackground': p.currentLine ?? p.selected, 'editor.lineHighlightBorder': '#00000000',
                        'editor.selectionBackground': p.selection ?? (mode === 'dark' ? '#5B83B666' : '#8CB4E566'),
                        'editorWidget.background': p.surface, 'editorWidget.border': p.border,
                        'editorHoverWidget.background': p.surface, 'editorHoverWidget.border': p.border,
                        'input.background': p.editor, 'input.foreground': p.text,
                    },
                });
            }
        }
    }

};
