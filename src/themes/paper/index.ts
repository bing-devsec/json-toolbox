import type { AppearanceMode, ThemeDefinition } from '../contract';
import { getSharedThemeVariables, sharedDiffColors } from '../sharedVariables';
import { getPaperControlVariables, paperDark, paperLight } from './tokens';

const palettes = { light: paperLight, dark: paperDark };

const feedback: Record<AppearanceMode, Record<string, string>> = {
    "light": {
        "--theme-danger": "#963C30",
        "--theme-success": "#476145",
        "--theme-warning": "#775B20"
    },
    "dark": {
        "--theme-danger": "#F2B1A2",
        "--theme-success": "#ADCCA1",
        "--theme-warning": "#E0C58D"
    }
};

const paperTheme: ThemeDefinition = {
    id: 'paper',
    zh: '温润纸感',
    en: 'Warm Paper',
    descriptionZh: '暖纸底色、细描边与低对比，长时间整理更轻松。',
    descriptionEn: 'Warm paper surfaces, fine lines and low contrast for comfortable long sessions.',
    palettes,
    getVariables(mode) {
        const p = palettes[mode];
        return {
            ...getSharedThemeVariables(p, mode, feedback),
            ...feedback[mode],
            ...sharedDiffColors[mode],
            ...getPaperControlVariables(mode),
        };
    },
};

export default paperTheme;
