import defaultTheme from './default';
import ideTheme from './ide';
import glassTheme from './glass';
import retroTheme from './retro';
import paperTheme from './paper';
import { INTERFACE_STYLE_IDS, normalizeInterfaceStyle } from './ids';
import type { AppearanceMode, InterfaceStyle } from './ids';
import type { Palette, ThemeDefinition } from './contract';

/** Registry only dispatches. It contains no colors and no visual rules. */
export const themes: readonly ThemeDefinition[] = [defaultTheme, ideTheme, glassTheme, retroTheme, paperTheme];

export const interfaceStyles = themes.map(({ id, zh, en, descriptionZh, descriptionEn }) => ({
    id, zh, en, descriptionZh, descriptionEn,
}));

export { INTERFACE_STYLE_IDS, normalizeInterfaceStyle };
export type { AppearanceMode, InterfaceStyle, Palette, ThemeDefinition };

export const getThemeDefinition = (id: InterfaceStyle): ThemeDefinition =>
    themes.find(theme => theme.id === id) ?? defaultTheme;

export const getInterfaceVariables = (style: InterfaceStyle, mode: AppearanceMode): Record<string, string> =>
    getThemeDefinition(style).getVariables(mode);

export const getInterfacePalette = (style: InterfaceStyle, mode: AppearanceMode): Palette | null =>
    getThemeDefinition(style).palettes?.[mode] ?? null;
