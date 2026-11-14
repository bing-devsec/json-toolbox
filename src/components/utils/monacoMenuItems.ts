const MENU_ITEM_SELECTOR = '.monaco-menu-container [role="menuitem"]';

/** Monaco may render its menu in an open shadow-root-host outside the editor. */
export function getMonacoMenuItems(): HTMLElement[] {
    if (typeof document === 'undefined') return [];
    const items = new Set<HTMLElement>(document.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
    for (const host of document.querySelectorAll<HTMLElement>('.shadow-root-host')) {
        for (const item of host.shadowRoot?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []) {
            items.add(item);
        }
    }
    return [...items];
}
