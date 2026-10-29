// 与 src/style.css 的 --json-tool-font-code 保持一致。
// 保留 macOS 的 Menlo/Monaco 和 Windows 的 Consolas，并明确中文后备字体。
export const JSON_TOOL_EDITOR_FONT_OPTIONS = {
    fontFamily: "Menlo, Monaco, Consolas, 'Droid Sans Mono', 'Liberation Mono', 'Courier New', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', monospace",
    fontWeight: 'normal',
    fontLigatures: false,
} as const;

export function getJsonToolEditorTypography(fontSize: number) {
    const effectiveSize = fontSize === 12 || fontSize === 13 || fontSize === 14 ? fontSize : 12;
    return {
        ...JSON_TOOL_EDITOR_FONT_OPTIONS,
        fontSize: effectiveSize,
        // 使用整数 CSS 像素，给中英文混排留出行间距。
        lineHeight: Math.round(effectiveSize * 1.4),
    };
}
