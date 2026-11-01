import type { AppearanceMode, Palette } from '../contract';

/** Neutral workbench foundations, informed by VS Code's Dark/Light Modern themes.
 * Control roles remain independent from syntax and Diff data colors. */
export const idePalettes: Record<AppearanceMode, Palette> = {
    light: { bg: '#F8F8F8', surface: '#FFFFFF', soft: '#F8F8F8', text: '#3B3B3B', muted: '#616161', border: '#E5E5E5', accent: '#005FB8', editor: '#FFFFFF', gutter: '#F8F8F8', currentLine: '#F2F2F2', selection: '#ADD6FF', selected: '#E8E8E8', header: '#F8F8F8', radius: '3px', shadow: '0 6px 24px #00000020' },
    dark: { bg: '#181818', surface: '#222222', soft: '#181818', text: '#CCCCCC', muted: '#9D9D9D', border: '#2B2B2B', accent: '#0078D4', editor: '#1F1F1F', gutter: '#181818', currentLine: '#282828', selection: '#264F78', selected: '#094771', header: '#181818', radius: '3px', shadow: '0 6px 24px #00000060' },
};
export const ideControls = {
    light: { link: '#005FB8', button: '#F3F3F3', hover: '#E8E8E8', pressed: '#DADADA', input: '#FFFFFF', controlBorder: '#868686', primaryHover: '#0258A8', primaryPressed: '#034C91', onPrimary: '#FFFFFF', onSelected: '#1F1F1F', danger: '#B42318', dangerBackground: '#FDE7E9', disabled: '#767676', disabledBackground: '#F3F3F3', disabledBorder: '#D0D0D0', code: '#E8E8E8', success: '#237B4B', successBackground: '#E9F4ED', warning: '#795E26', warningBackground: '#FFF4CE' },
    dark: { link: '#4DAAFC', button: '#2B2B2B', hover: '#3C3C3C', pressed: '#454545', input: '#313131', controlBorder: '#7A7A7A', primaryHover: '#026EC1', primaryPressed: '#005A9E', onPrimary: '#FFFFFF', onSelected: '#FFFFFF', danger: '#F48771', dangerBackground: '#4B2727', disabled: '#777777', disabledBackground: '#252525', disabledBorder: '#3C3C3C', code: '#313131', success: '#89D185', successBackground: '#1E3624', warning: '#CCA700', warningBackground: '#3A3018' },
} as const;
export function getIdeControlVariables(mode: AppearanceMode): Record<string, string> {
    const p = idePalettes[mode], c = ideControls[mode];
    return {
        ...Object.fromEntries(Object.entries(c).map(([key, value]) => [`--ide-${key.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase())}`, value])),
        '--ide-primary': p.accent, '--ide-focus': p.accent, '--theme-accent': c.link, '--theme-on-accent': c.onPrimary, '--theme-danger': c.danger, '--theme-success': c.success, '--theme-warning': c.warning,
        '--json-tool-border-strong': c.controlBorder, '--json-tool-button-bg': c.button, '--json-tool-button-border': c.controlBorder,
        '--json-tool-button-text': p.text, '--json-tool-button-hover-bg': c.hover, '--json-tool-button-hover-border': c.controlBorder,
        '--toolbar-hover-bg': c.hover, '--toolbar-hover-fg': p.text,
        '--toolbar-active-bg': c.pressed, '--toolbar-active-fg': p.text,
        '--toolbar-hover-shadow': 'none',
        '--toolbar-active-shadow': mode === 'dark' ? 'inset 0 1px 3px rgba(0,0,0,.35)' : 'inset 0 1px 2px rgba(0,0,0,.12)',
        '--toolbar-primary-hover-bg': c.primaryHover, '--toolbar-primary-hover-fg': c.onPrimary,
        '--toolbar-primary-active-bg': c.primaryPressed, '--toolbar-primary-active-fg': c.onPrimary,
        '--toolbar-primary-hover-shadow': 'none',
        '--toolbar-primary-active-shadow': mode === 'dark' ? 'inset 0 1px 3px rgba(0,0,0,.45)' : 'inset 0 1px 3px rgba(0,0,0,.18)',
        '--toolbar-active-transform': 'none',
        '--toolbar-border': p.border, '--toolbar-divider': p.border, '--toolbar-primary-border': p.accent,
        '--json-tool-input-bg': c.input, '--json-tool-input-border': c.controlBorder, '--json-tool-input-hover-border': p.accent,
        '--json-tool-transfer-fg': p.text, '--json-tool-resizer-grip': c.controlBorder,
        '--json-tool-archive-drag': p.selected, '--json-tool-archive-scrollbar': c.controlBorder, '--json-tool-archive-scrollbar-hover': p.muted,
        '--el-button-divide-border-color': c.controlBorder, '--el-color-danger': c.danger, '--el-color-success': c.success, '--el-color-warning': c.warning,
        '--el-color-danger-light-9': c.dangerBackground, '--el-color-success-light-9': c.successBackground, '--el-color-warning-light-9': c.warningBackground,
        '--el-disabled-bg-color': c.disabledBackground, '--el-disabled-text-color': c.disabled, '--el-disabled-border-color': c.disabledBorder,
        '--el-text-color-placeholder': p.muted, '--el-switch-on-color': p.accent, '--el-switch-off-color': c.controlBorder,
    };
}
