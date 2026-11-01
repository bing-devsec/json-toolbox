export const INTERFACE_STYLE_IDS = ['default', 'ide', 'glass', 'retro', 'paper'] as const;
export type InterfaceStyle = (typeof INTERFACE_STYLE_IDS)[number];
export type AppearanceMode = 'light' | 'dark';

export const normalizeInterfaceStyle = (value: unknown): InterfaceStyle =>
    INTERFACE_STYLE_IDS.includes(value as InterfaceStyle) ? value as InterfaceStyle : 'default';
