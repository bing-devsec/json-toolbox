import { getActionVariables } from '../actionTokens';
import type { AppearanceMode } from '../contract';

/** Keep the familiar Element palette; give small action labels readable surfaces. */
export const defaultControls = {
    light: { primary: '#1D6FCC', hover: '#1A62B5', active: '#155496', foreground: '#FFFFFF' },
    dark: { primary: '#1D4F73', hover: '#28658E', active: '#143A55', foreground: '#E8F4FF' },
} as const;

/** Keep docked content flat; floating surfaces use a restrained depth ramp. */
const elevation = {
    light: {
        workbench: '0 1px 2px rgba(31,45,61,.04), 0 4px 12px rgba(31,45,61,.05)',
        popover: '0 2px 4px rgba(31,45,61,.06), 0 8px 20px rgba(31,45,61,.10)',
        dialog: '0 4px 8px rgba(31,45,61,.06), 0 16px 36px rgba(31,45,61,.12)',
    },
    dark: {
        workbench: '0 1px 2px rgba(0,0,0,.12), 0 4px 12px rgba(0,0,0,.14)',
        popover: '0 2px 4px rgba(0,0,0,.20), 0 8px 20px rgba(0,0,0,.22)',
        dialog: '0 4px 8px rgba(0,0,0,.20), 0 16px 36px rgba(0,0,0,.28)',
    },
} as const;

export function getDefaultVariables(mode: AppearanceMode): Record<string, string> {
    const c = defaultControls[mode];
    const depth = elevation[mode];
    return {
        ...getActionVariables(mode === 'dark' ? {
            primary: '#91C7FF', secondary: '#C2CAD5', success: '#9DD6A5', danger: '#FFB0A6',
            surface: '#303238', hover: '#3B3E45', active: '#464A52', border: '#626771',
            disabledForeground: '#777C85', disabledBackground: '#282A2F', disabledBorder: '#41454C',
        } : {
            primary: '#1D5FA6', secondary: '#505D70', success: '#286B40', danger: '#AD3434',
            surface: '#F8FAFC', hover: '#EEF2F7', active: '#E1E7EF', border: '#C8D0DB',
            disabledForeground: '#A1A8B2', disabledBackground: '#F2F4F7', disabledBorder: '#DFE4EB',
        }),
        '--toolbar-main-bg': c.primary, '--toolbar-main-fg': c.foreground,
        '--toolbar-main-hover-fg': c.foreground, '--toolbar-main-active-fg': c.foreground,
        '--default-primary-bg': c.primary, '--default-primary-fg': c.foreground,
        '--default-workbench-shadow': depth.workbench,
        '--default-popover-shadow': depth.popover,
        '--default-dialog-shadow': depth.dialog,
        '--el-color-primary': c.primary, '--el-color-primary-light-3': c.hover, '--el-color-primary-dark-2': c.active,
        '--toolbar-hover-bg': c.hover, '--toolbar-hover-fg': c.foreground,
        '--toolbar-active-bg': c.active, '--toolbar-active-fg': c.foreground,
        '--toolbar-border': c.primary,
    };
}
