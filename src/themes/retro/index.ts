import type { AppearanceMode, ThemeDefinition } from '../contract';
import { getSharedThemeVariables, sharedDiffColors } from '../sharedVariables';
import { getRetroVariables, retroPalettes } from './tokens';

const palettes = retroPalettes;

const feedback: Record<AppearanceMode, Record<string, string>> = {
    "light": {
        "--theme-danger": "#b03a2e",
        "--theme-success": "#4f7a3a",
        "--theme-warning": "#a86b00"
    },
    "dark": {
        "--theme-danger": "#e08c82",
        "--theme-success": "#9ccf85",
        "--theme-warning": "#d7b25f"
    }
};

const retroTheme: ThemeDefinition = {
    id: 'retro',
    zh: '复古桌面',
    en: 'Retro Desktop',
    descriptionZh: '2010 桌面客户端式蓝色标题栏与立体按钮。',
    descriptionEn: '2010 desktop-style blue title bars and raised controls.',
    palettes,
    getVariables(mode) {
        const p = palettes[mode];
        return {
            ...getSharedThemeVariables(p, mode, feedback),
            ...feedback[mode],
            ...sharedDiffColors[mode],
            ...getRetroVariables(mode),
        };
    },
};

export default retroTheme;
