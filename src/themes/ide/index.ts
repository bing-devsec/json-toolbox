import type { AppearanceMode, Palette, ThemeDefinition } from '../contract';
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

const diffColors: Record<AppearanceMode, Record<string, string>> = {
    "light": {
        "--json-tool-diff-delete-bg": "rgba(215, 58, 73, 0.11)",
        "--json-tool-diff-insert-bg": "rgba(102, 184, 255, 0.16)",
        "--json-tool-diff-inline-delete": "rgba(215, 58, 73, 0.26)",
        "--json-tool-diff-inline-insert": "rgba(102, 184, 255, 0.34)",
        "--json-tool-diff-spacer-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.78)",
        "--json-tool-diff-spacer-delete-bg": "rgba(252, 239, 241, 0.94)",
        "--json-tool-diff-spacer-delete-stripe": "rgba(215, 58, 73, 0.18)",
        "--json-tool-diff-spacer-insert-bg": "rgba(237, 248, 255, 0.96)",
        "--json-tool-diff-spacer-insert-stripe": "rgba(84, 165, 240, 0.16)",
        "--json-tool-diff-center-bg": "#f2f4f7",
        "--json-tool-diff-center-border": "#dde3ea",
        "--json-tool-diff-sync-btn-color": "#7b8491",
        "--json-tool-diff-sync-btn-hover-color": "#4b5563",
        "--json-tool-diff-sync-btn-active-color": "#d48a12"
    },
    "dark": {
        "--json-tool-diff-delete-bg": "rgba(102, 58, 60, 0.26)",
        "--json-tool-diff-insert-bg": "rgba(56, 88, 132, 0.24)",
        "--json-tool-diff-inline-delete": "rgba(134, 68, 72, 0.48)",
        "--json-tool-diff-inline-insert": "rgba(63, 106, 164, 0.5)",
        "--json-tool-diff-spacer-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.03)",
        "--json-tool-diff-spacer-delete-bg": "rgba(57, 40, 42, 0.92)",
        "--json-tool-diff-spacer-delete-stripe": "rgba(168, 88, 92, 0.2)",
        "--json-tool-diff-spacer-insert-bg": "rgba(38, 48, 63, 0.92)",
        "--json-tool-diff-spacer-insert-stripe": "rgba(97, 145, 209, 0.22)",
        "--json-tool-diff-center-bg": "#20242b",
        "--json-tool-diff-center-border": "#303743",
        "--json-tool-diff-sync-btn-color": "#9aa3af",
        "--json-tool-diff-sync-btn-hover-color": "#d1d5db",
        "--json-tool-diff-sync-btn-active-color": "#f0b84a"
    }
};

const baseVariables = (p: Palette, mode: AppearanceMode): Record<string, string> => {
    const f = feedback[mode];
    return {
        '--json-tool-bg': p.bg,
        '--json-tool-surface': p.surface,
        '--json-tool-surface-soft': p.soft,
        '--json-tool-surface-raised': p.surface,
        '--json-tool-surface-header': p.header,
        '--json-tool-surface-status': p.header,
        '--json-tool-border': p.border,
        '--json-tool-border-strong': p.borderStrong ?? p.border,
        '--json-tool-toolbar-border': p.border,
        '--json-tool-text': p.text,
        '--json-tool-text-muted': p.muted,
        '--json-tool-gutter-bg': p.gutter ?? p.soft,
        '--json-tool-editor-bg': p.editor,
        '--json-tool-current-line': p.currentLine ?? p.selected,
        '--json-tool-shadow': p.shadow,
        '--json-tool-archive-hover': p.soft,
        '--json-tool-archive-active': p.selected,
        '--json-tool-archive-active-hover': p.selected,
        '--json-tool-archive-drag': p.selected,
        '--json-tool-archive-scrollbar': p.borderStrong ?? p.border,
        '--json-tool-archive-scrollbar-hover': p.muted,
        '--json-tool-button-bg': p.surface,
        '--json-tool-button-border': p.border,
        '--json-tool-button-text': p.text,
        '--json-tool-button-hover-bg': p.selected,
        '--json-tool-button-hover-border': p.accent,
        '--json-tool-input-bg': p.surface,
        '--json-tool-input-border': p.borderStrong ?? p.border,
        '--json-tool-input-hover-border': p.accent,
        '--json-tool-transfer-bg': p.soft,
        '--json-tool-transfer-fg': p.accent,
        '--json-tool-resizer-grip': p.borderStrong ?? p.border,
        '--json-tool-diff-center-bg': p.surface,
        '--json-tool-diff-center-border': p.border,
        '--json-tool-diff-nav-bg': p.surface,
        '--json-tool-diff-nav-border': p.border,
        '--json-tool-diff-nav-divider': p.border,
        '--json-tool-diff-nav-text': p.text,
        '--json-tool-diff-nav-status-bg': p.soft,
        '--json-tool-diff-nav-action-hover': p.selected,
        '--json-tool-diff-nav-action-active': p.selected,
        '--json-tool-diff-nav-action-disabled': `color-mix(in srgb, ${p.muted} 58%, transparent)`,
        '--json-tool-diff-sync-btn-color': p.muted,
        '--json-tool-diff-sync-btn-hover-color': p.accent,
        '--json-tool-diff-sync-btn-active-color': p.accent,
        '--theme-accent': p.accent,
        '--theme-selected': p.selected,
        '--theme-radius': p.radius,
        '--theme-header': p.header,
        '--theme-on-accent': mode === 'dark' ? '#17202e' : '#ffffff',
        '--theme-danger': f['--theme-danger'],
        '--theme-success': f['--theme-success'],
        '--theme-warning': f['--theme-warning'],
        '--el-color-primary': p.accent,
        '--el-color-primary-light-3': p.accent,
        '--el-color-primary-light-5': p.border,
        '--el-color-primary-light-7': p.selected,
        '--el-color-primary-light-8': p.selected,
        '--el-color-primary-light-9': p.selected,
        '--el-color-danger': f['--theme-danger'],
        '--el-color-success': f['--theme-success'],
        '--el-color-warning': f['--theme-warning'],
        '--el-color-danger-light-9': `color-mix(in srgb, ${f['--theme-danger']} 14%, ${p.surface})`,
        '--el-color-success-light-9': `color-mix(in srgb, ${f['--theme-success']} 14%, ${p.surface})`,
        '--el-color-warning-light-9': `color-mix(in srgb, ${f['--theme-warning']} 14%, ${p.surface})`,
        '--el-button-divide-border-color': p.border,
        '--el-bg-color': p.surface,
        '--el-bg-color-overlay': p.surface,
        '--el-fill-color-blank': p.surface,
        '--el-fill-color': p.soft,
        '--el-fill-color-light': p.soft,
        '--el-fill-color-lighter': p.soft,
        '--el-text-color-primary': p.text,
        '--el-text-color-regular': p.text,
        '--el-text-color-secondary': p.muted,
        '--el-border-color': p.border,
        '--el-border-color-light': p.border,
        '--el-border-color-lighter': p.border,
        '--el-border-radius-base': p.radius,
        '--el-box-shadow-light': p.shadow,
    };
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
            ...baseVariables(p, mode),
            ...feedback[mode],
            ...diffColors[mode],
            ...getIdeControlVariables(mode),
        };
    },
};

export default ideTheme;
