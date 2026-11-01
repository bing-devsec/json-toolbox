import type { AppearanceMode, InterfaceStyle } from './ids';

export type { AppearanceMode, InterfaceStyle } from './ids';

/** Shared shape consumed by the runtime and editor colors. Values stay in each theme. */
export interface Palette {
    bg: string;
    surface: string;
    soft: string;
    text: string;
    muted: string;
    border: string;
    borderStrong?: string;
    accent: string;
    editor: string;
    gutter?: string;
    currentLine?: string;
    selection?: string;
    selected: string;
    header: string;
    radius: string;
    shadow: string;
}

export interface ThemeDefinition {
    id: InterfaceStyle;
    zh: string;
    en: string;
    descriptionZh: string;
    descriptionEn: string;
    palettes?: Record<AppearanceMode, Palette>;
    getVariables(mode: AppearanceMode): Record<string, string>;
}
