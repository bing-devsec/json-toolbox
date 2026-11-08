import type { AppearanceMode, ThemeDefinition } from '../contract';
import { getSharedThemeVariables, sharedDiffColors } from '../sharedVariables';
import { getGlassVariables, glassPalettes } from './tokens';

const palettes = glassPalettes;

const feedback: Record<AppearanceMode, Record<string, string>> = {
    "light": {
        "--theme-danger": "#b0473f",
        "--theme-success": "#2f7d5c",
        "--theme-warning": "#9a6b1f"
    },
    "dark": {
        "--theme-danger": "#f0a69c",
        "--theme-success": "#8fd0ae",
        "--theme-warning": "#e0c07a"
    }
};

const glassTheme: ThemeDefinition = {
    id: 'glass',
    zh: '柔光玻璃',
    en: 'Soft Glass',
    descriptionZh: '半透明柔光与冷蓝高光，轻盈但文字始终清晰。',
    descriptionEn: 'Translucent soft light and cool highlights without sacrificing legibility.',
    palettes,
    getVariables(mode) {
        const p = palettes[mode];
        return {
            ...getSharedThemeVariables(p, mode, feedback),
            ...feedback[mode],
            ...sharedDiffColors[mode],
            ...getGlassVariables(mode),
        };
    },
};

export default glassTheme;
