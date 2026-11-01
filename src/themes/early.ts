import { getInterfaceVariables, normalizeInterfaceStyle } from './registry';
import type { AppearanceMode } from './ids';

const appliedVariables = new Set<string>();

/** Releases the variables written by the early boot phase.
 * Called when the workbench takes over, so a later theme switch never restores them. */
export function clearEarlyTheme(): void {
    if (typeof document === 'undefined') return;
    for (const key of appliedVariables) document.body.style.removeProperty(key);
    appliedVariables.clear();
}

/** Applies the persisted theme before the async workbench (and its skeleton) renders.
 * This is application plumbing only; it contains no colors. */
export function applyStoredTheme(): void {
    clearEarlyTheme();
    if (typeof document === 'undefined' || typeof localStorage === 'undefined') return;
    let style = normalizeInterfaceStyle(undefined);
    let mode: AppearanceMode = 'light';
    try {
        const raw = JSON.parse(localStorage.getItem('json-tool-settings') || 'null');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            style = normalizeInterfaceStyle(raw.interfaceStyle);
            mode = raw.themeMode === 'dark' ? 'dark' : 'light';
        }
    } catch {
        // Unreadable preferences fall back to the default appearance.
    }
    const body = document.body;
    body.dataset.interfaceStyle = style;
    body.classList.toggle('json-tool-theme-dark', mode === 'dark');
    for (const [key, value] of Object.entries(getInterfaceVariables(style, mode))) {
        body.style.setProperty(key, value);
        appliedVariables.add(key);
    }
}
