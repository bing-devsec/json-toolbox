/** Button meaning is shared; each theme owns the actual colors and material. */
export interface ActionColors {
    primary: string;
    secondary: string;
    success: string;
    danger: string;
    surface: string;
    hover: string;
    active: string;
    border: string;
    disabledForeground: string;
    disabledBackground: string;
    disabledBorder: string;
}

export function getActionVariables(colors: ActionColors): Record<string, string> {
    return {
        '--action-primary-fg': colors.primary,
        '--action-secondary-fg': colors.secondary,
        '--action-success-fg': colors.success,
        '--action-danger-fg': colors.danger,
        '--action-panel-bg': colors.surface,
        '--action-panel-hover-bg': colors.hover,
        '--action-panel-active-bg': colors.active,
        '--action-panel-border': colors.border,
        '--action-disabled-fg': colors.disabledForeground,
        '--action-disabled-bg': colors.disabledBackground,
        '--action-disabled-border': colors.disabledBorder,
    };
}
