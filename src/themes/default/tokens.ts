import type { AppearanceMode } from '../contract';

/** Keep the familiar Element palette; give small action labels readable surfaces. */
export const defaultControls = {
    light: { primary: '#1D6FCC', hover: '#1A62B5', active: '#155496', foreground: '#FFFFFF', fileForeground: '#606266' },
    dark: { primary: '#1D4F73', hover: '#28658E', active: '#143A55', foreground: '#E8F4FF', fileForeground: '#E0E0E0' },
} as const;

export function getDefaultVariables(mode: AppearanceMode): Record<string, string> {
    const c = defaultControls[mode];
    return {
        '--default-primary-bg': c.primary, '--default-primary-fg': c.foreground,
        '--default-file-transfer-fg': c.fileForeground,
        '--el-color-primary': c.primary, '--el-color-primary-light-3': c.hover, '--el-color-primary-dark-2': c.active,
        '--toolbar-hover-bg': c.hover, '--toolbar-hover-fg': c.foreground,
        '--toolbar-active-bg': c.active, '--toolbar-active-fg': c.foreground,
        '--toolbar-primary-hover-bg': c.hover, '--toolbar-primary-hover-fg': c.foreground,
        '--toolbar-primary-active-bg': c.active, '--toolbar-primary-active-fg': c.foreground,
        '--toolbar-border': c.primary, '--toolbar-primary-border': c.primary,
    };
}
