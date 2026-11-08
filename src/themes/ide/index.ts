import type { AppearanceMode, ThemeDefinition } from '../contract';
import { getSharedThemeVariables, sharedDiffColors } from '../sharedVariables';
import { getIdeControlVariables, idePalettes } from './tokens';

const palettes = idePalettes;

const feedback: Record<AppearanceMode, Record<string, string>> = {
    "light": {
        "--theme-danger": "#B42318",
        "--theme-success": "#237B4B",
        "--theme-warning": "#795E26"
    },
    "dark": {
        "--theme-danger": "#F48771",
        "--theme-success": "#89D185",
        "--theme-warning": "#CCA700"
    }
};

const ideTheme: ThemeDefinition = {
    id: 'ide',
    zh: '专业 IDE',
    en: 'Professional IDE',
    descriptionZh: 'VS Code 式中性灰、扁平控件，长时间处理更安静。',
    descriptionEn: 'VS Code-like neutral greys and flat controls for long, quiet sessions.',
    palettes,
    getVariables(mode) {
        const p = palettes[mode];
        return {
            ...getSharedThemeVariables(p, mode, feedback),
            ...feedback[mode],
            ...sharedDiffColors[mode],
            ...getIdeControlVariables(mode),
        };
    },
};

export default ideTheme;
