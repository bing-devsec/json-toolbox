/** Paper's semantic control contract. Every state is explicit, in both modes.
 * Copy/download are neutral actions. Success/warning colors describe feedback,
 * not arbitrary categories of toolbar buttons. Icons always inherit control text. */
import type { Palette } from '../contract';

export interface ControlColors {
    background: string; foreground: string; border: string;
    hoverBackground: string; hoverForeground: string; hoverBorder: string;
    activeBackground: string; activeForeground: string; activeBorder: string;
}
const control = (background: string, foreground: string, border: string, hoverBackground: string, activeBackground: string, emphasis = foreground): ControlColors => ({
    background, foreground, border, hoverBackground, hoverForeground: foreground, hoverBorder: emphasis,
    activeBackground, activeForeground: foreground, activeBorder: emphasis,
});
export const paperControls = {
    light: {
        neutral: control('#FAF7EF', '#3D3931', '#958674', '#F1ECDF', '#E5DBCB', '#805735'),
        secondary: control('#FAF7EF', '#805735', '#958674', '#EFE6D6', '#E9DECC'),
        primary: control('#805735', '#FFFCF4', '#805735', '#6D482B', '#59391F', '#59391F'),
        danger: control('#FAF7EF', '#963C30', '#B65B4D', '#F5E4DF', '#EBCDC5'),
        disabled: { background: '#F1ECDF', foreground: '#8B8172', border: '#D6CDBD' },
        focus: '#805735', selectedBackground: '#EEE2CA', selectedForeground: '#6D482B',
        success: '#476145', successBackground: '#ECF0E7', warning: '#775B20', warningBackground: '#F5EDD9',
        dangerBackground: '#F5E4DF', borderStrong: '#958674', grip: '#958674',
    },
    dark: {
        neutral: control('#302D27', '#E9E0CF', '#8E806C', '#3B352B', '#4A4032', '#D7B88C'),
        secondary: control('#302D27', '#D7B88C', '#968166', '#43392B', '#514432'),
        primary: control('#D7B88C', '#292720', '#D7B88C', '#E6CBA7', '#C9A77A', '#E6CBA7'),
        danger: control('#302D27', '#F2B1A2', '#C98476', '#4B302B', '#5B352E'),
        disabled: { background: '#292720', foreground: '#8E8475', border: '#514A3E' },
        focus: '#D7B88C', selectedBackground: '#514634', selectedForeground: '#F0D8B7',
        success: '#ADCCA1', successBackground: '#283226', warning: '#E0C58D', warningBackground: '#3E3524',
        dangerBackground: '#4B302B', borderStrong: '#8E806C', grip: '#8E806C',
    },
} as const;

export const paperLight: Palette = {
    bg: '#eae5da', surface: '#faf7ef', soft: '#f1ecdf', text: '#3d3931', muted: '#706657',
    border: '#d6cdbd', borderStrong: '#958674', accent: '#805735', editor: '#fffcf4',
    selected: '#eee2ca', header: '#f6f1e5', radius: '2px', shadow: 'none',
};
export const paperDark: Palette = {
    bg: '#25231f', surface: '#302d27', soft: '#292720', text: '#e9e0cf', muted: '#bfb39e',
    border: '#5b5447', borderStrong: '#8e806c', accent: '#d7b88c', editor: '#292720',
    gutter: '#353127', selected: '#514634', header: '#353127', radius: '2px', shadow: 'none',
};

export function getPaperControlVariables(mode: 'light' | 'dark'): Record<string, string> {
    const tokens = paperControls[mode];
    const variables: Record<string, string> = {};
    const cssName = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    for (const role of ['neutral', 'secondary', 'primary', 'danger'] as const) {
        for (const [state, value] of Object.entries(tokens[role])) variables[`--paper-${role}-${cssName(state)}`] = value;
    }
    for (const [state, value] of Object.entries(tokens.disabled)) variables[`--paper-disabled-${state}`] = value;
    Object.assign(variables, {
        '--paper-focus': tokens.focus,
        '--paper-fold-background': tokens.selectedBackground, '--paper-fold-foreground': tokens.selectedForeground,
        '--paper-fold-border': tokens.focus, '--paper-fold-hover-background': tokens.secondary.hoverBackground,
        '--el-button-divide-border-color': tokens.secondary.border, '--paper-selected-bg': tokens.selectedBackground, '--paper-selected-fg': tokens.selectedForeground,
        '--json-tool-border-strong': tokens.borderStrong, '--json-tool-resizer-grip': tokens.grip,
        '--json-tool-transfer-fg': tokens.secondary.foreground,
        '--json-tool-archive-drag': tokens.selectedBackground,
        '--json-tool-archive-scrollbar': tokens.grip, '--json-tool-archive-scrollbar-hover': tokens.focus,
        '--json-tool-input-bg': tokens.neutral.background, '--json-tool-input-border': tokens.neutral.border,
        '--json-tool-input-hover-border': tokens.secondary.foreground,
        '--json-tool-diff-sync-btn-active-color': tokens.secondary.foreground,
        '--theme-danger': tokens.danger.foreground, '--theme-success': tokens.success, '--theme-warning': tokens.warning,
        '--paper-danger-bg': tokens.dangerBackground, '--paper-success-bg': tokens.successBackground, '--paper-warning-bg': tokens.warningBackground,
        '--el-color-danger': tokens.danger.foreground, '--el-color-danger-light-9': tokens.dangerBackground,
        '--el-color-success': tokens.success, '--el-color-success-light-9': tokens.successBackground,
        '--el-color-warning': tokens.warning, '--el-color-warning-light-9': tokens.warningBackground,
        '--el-disabled-bg-color': tokens.disabled.background, '--el-disabled-text-color': tokens.disabled.foreground,
        '--el-disabled-border-color': tokens.disabled.border,
        '--toolbar-hover-bg': tokens.secondary.hoverBackground, '--toolbar-hover-fg': tokens.secondary.hoverForeground,
        '--toolbar-active-bg': tokens.secondary.activeBackground, '--toolbar-active-fg': tokens.secondary.activeForeground,
        '--toolbar-hover-shadow': 'inset 0 1px 0 rgba(255,255,255,.28)',
        '--toolbar-active-shadow': mode === 'dark' ? 'inset 0 1px 3px rgba(0,0,0,.30)' : 'inset 0 1px 2px rgba(61,57,49,.18)',
        '--toolbar-primary-hover-bg': tokens.primary.hoverBackground, '--toolbar-primary-hover-fg': tokens.primary.hoverForeground,
        '--toolbar-primary-active-bg': tokens.primary.activeBackground, '--toolbar-primary-active-fg': tokens.primary.activeForeground,
        '--toolbar-primary-hover-shadow': 'none',
        '--toolbar-primary-active-shadow': mode === 'dark' ? 'inset 0 1px 3px rgba(0,0,0,.34)' : 'inset 0 1px 2px rgba(61,57,49,.24)',
        '--toolbar-active-transform': 'none',
        '--toolbar-border': tokens.secondary.border, '--toolbar-divider': tokens.secondary.border,
        '--toolbar-primary-border': tokens.primary.border,
    });
    return variables;
}
