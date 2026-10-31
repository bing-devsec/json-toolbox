import { getPaperControlVariables } from './paperTokens';
import { idePalettes, getIdeControlVariables } from './ideTokens';

/** Visual styles are independent of light/dark mode and JSON/editor state. */
export const interfaceStyles = [
    { id: 'default', controlSystem: 'legacy', zh: '经典默认', en: 'Classic Default', descriptionZh: '保留熟悉的布局与配色', descriptionEn: 'The familiar original appearance' },
    { id: 'ide', controlSystem: 'semantic', zh: '专业 IDE', en: 'Professional IDE', descriptionZh: '中性灰分区、扁平控件与代码编辑器配色', descriptionEn: 'Neutral workbench, flat controls and editor-native colors' },
    { id: 'glass', controlSystem: 'legacy', zh: '通透玻璃', en: 'Translucent Glass', descriptionZh: '通透工具栏与柔和高光，编辑区保持清晰', descriptionEn: 'Translucent controls with a clear, solid editor' },
    { id: 'retro', controlSystem: 'legacy', zh: '复古桌面', en: 'Retro Desktop', descriptionZh: '蓝灰渐变、立体按钮与经典桌面质感', descriptionEn: 'Classic gradients and tactile desktop controls' },
    { id: 'paper', controlSystem: 'semantic', zh: '温润纸感', en: 'Warm Paper', descriptionZh: '温暖底色、细线条与安静的阅读空间', descriptionEn: 'Warm surfaces and quiet, fine-lined controls' },
] as const;
export type InterfaceStyle = typeof interfaceStyles[number]['id'];
export type AppearanceMode = 'light' | 'dark';
export const normalizeInterfaceStyle = (value: unknown): InterfaceStyle =>
    interfaceStyles.some(style => style.id === value) ? value as InterfaceStyle : 'default';

export interface Palette { bg: string; surface: string; soft: string; text: string; muted: string; border: string; accent: string; editor: string; gutter?: string; currentLine?: string; selection?: string; selected: string; header: string; radius: string; shadow: string }
const palettes: Record<Exclude<InterfaceStyle, 'default'>, Record<AppearanceMode, Palette>> = {
    ide: idePalettes,
    glass: {
        light: { bg: 'linear-gradient(125deg, #dce7fa, #f0e9fa 55%, #dff2ef)', surface: '#f8faff', soft: '#eef3fc', text: '#283953', muted: '#526581', border: '#bccce2', accent: '#4168c8', editor: '#fcfdff', selected: '#e5edff', header: 'linear-gradient(110deg, #f7faffdf, #edf1ffcc)', radius: '10px', shadow: '0 6px 24px #3a537c18' },
        dark: { bg: 'linear-gradient(125deg, #14283f, #2c2340 55%, #173b3d)', surface: '#243044', soft: '#202a3d', text: '#e4edff', muted: '#b1c2dd', border: '#506384', accent: '#a9c1ff', editor: '#1b2536', selected: '#334868', header: 'linear-gradient(110deg, #33425cde, #302d48cc)', radius: '10px', shadow: '0 8px 28px #00000030' },
    },
    retro: {
        light: { bg: '#c4d5e7', surface: '#f5f7fa', soft: '#e4edf7', text: '#1e334a', muted: '#4e6379', border: '#8ca7c0', accent: '#285f99', editor: '#ffffff', selected: '#d6e8fc', header: 'linear-gradient(#f7fbff, #d1e0ef)', radius: '4px', shadow: '0 2px 5px #334b6330' },
        dark: { bg: '#192b3d', surface: '#2c4055', soft: '#24374c', text: '#edf4ff', muted: '#b8cadd', border: '#647f9a', accent: '#a9d0ff', editor: '#192838', selected: '#3b5673', header: 'linear-gradient(#405973, #2b4056)', radius: '4px', shadow: '0 2px 5px #00000040' },
    },
    paper: {
        light: { bg: '#eae5da', surface: '#faf7ef', soft: '#f1ecdf', text: '#3d3931', muted: '#706657', border: '#d6cdbd', accent: '#805735', editor: '#fffcf4', selected: '#eee2ca', header: '#f6f1e5', radius: '2px', shadow: 'none' },
        dark: { bg: '#25231f', surface: '#302d27', soft: '#292720', text: '#e9e0cf', muted: '#bfb39e', border: '#5b5447', accent: '#d7b88c', editor: '#292720', gutter: '#353127', selected: '#514634', header: '#353127', radius: '2px', shadow: 'none' },
    },
};
export const getInterfaceControlSystem = (style: InterfaceStyle) => interfaceStyles.find(item => item.id === style)?.controlSystem ?? 'legacy';

export const getInterfacePalette = (style: InterfaceStyle, mode: AppearanceMode) => style === 'default' ? null : palettes[style][mode];
export function getInterfaceVariables(style: InterfaceStyle, mode: AppearanceMode): Record<string, string> {
    const p = getInterfacePalette(style, mode);
    if (!p) return {};
    return {
        '--json-tool-bg': p.bg, '--json-tool-surface': p.surface, '--json-tool-surface-soft': p.soft,
        '--json-tool-surface-raised': p.surface, '--json-tool-surface-header': p.header, '--json-tool-surface-status': p.header,
        '--json-tool-border': p.border, '--json-tool-toolbar-border': p.border, '--json-tool-text': p.text, '--json-tool-text-muted': p.muted,
        '--json-tool-gutter-bg': p.gutter ?? p.soft, '--json-tool-editor-bg': p.editor, '--json-tool-current-line': p.currentLine ?? p.selected, '--json-tool-shadow': p.shadow,
        '--json-tool-archive-hover': p.soft, '--json-tool-archive-active': p.selected, '--json-tool-archive-active-hover': p.selected,
        '--json-tool-button-bg': p.surface, '--json-tool-button-border': p.border, '--json-tool-button-text': p.text,
        '--json-tool-button-hover-bg': p.selected, '--json-tool-button-hover-border': p.accent,
        '--json-tool-diff-center-bg': p.surface, '--json-tool-diff-center-border': p.border,
        '--json-tool-diff-sync-btn-color': p.muted, '--json-tool-diff-sync-btn-hover-color': p.accent, '--json-tool-diff-sync-btn-active-color': p.accent,
        '--json-tool-diff-nav-bg': p.surface, '--json-tool-diff-nav-border': p.border, '--json-tool-diff-nav-divider': p.border,
        '--json-tool-diff-nav-text': p.text, '--json-tool-diff-nav-status-bg': p.soft, '--json-tool-diff-nav-action-hover': p.selected,
        '--json-tool-diff-nav-action-active': p.selected,
        '--theme-accent': p.accent, '--theme-selected': p.selected, '--theme-radius': p.radius, '--theme-header': p.header,
        '--el-color-primary': p.accent, '--el-color-primary-light-3': p.accent, '--el-color-primary-light-5': p.border,
        '--el-color-primary-light-7': p.selected, '--el-color-primary-light-8': p.selected, '--el-color-primary-light-9': p.selected,
        '--el-bg-color': p.surface, '--el-bg-color-overlay': p.surface, '--el-fill-color-blank': p.surface,
        '--el-fill-color': p.soft, '--el-fill-color-light': p.soft, '--el-fill-color-lighter': p.soft,
        '--el-text-color-primary': p.text, '--el-text-color-regular': p.text, '--el-text-color-secondary': p.muted,
        '--el-border-color': p.border, '--el-border-color-light': p.border, '--el-border-color-lighter': p.border,
        '--el-border-radius-base': p.radius, '--el-box-shadow-light': p.shadow,
        ...(style === 'paper' ? getPaperControlVariables(mode) : {}),
        ...(style === 'ide' ? getIdeControlVariables(mode) : {}),
    };
}
