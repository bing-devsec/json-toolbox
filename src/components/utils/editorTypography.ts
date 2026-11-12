// 与 src/style.css 的 --json-tool-font-code 保持一致。
// 优先使用随扩展提供的 JetBrains Mono，保留系统等宽及中文后备字体。
export const JSON_TOOL_EDITOR_FONT_OPTIONS = {
    fontFamily: "'JetBrains Mono', Menlo, Monaco, Consolas, 'Droid Sans Mono', 'Liberation Mono', 'Courier New', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', monospace",
    fontWeight: 'normal',
    fontLigatures: false,
} as const;

export function getJsonToolEditorTypography(fontSize: number) {
    const effectiveSize = fontSize === 12 || fontSize === 13 || fontSize === 14 ? fontSize : 12;
    return {
        ...JSON_TOOL_EDITOR_FONT_OPTIONS,
        fontSize: effectiveSize,
        // 紧凑行距：12/13/14px 字号对应 16/18/20px 行高。
        lineHeight: { 12: 16, 13: 18, 14: 20 }[effectiveSize],
    };
}
