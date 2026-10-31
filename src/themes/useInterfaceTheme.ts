import { computed, onBeforeUnmount, watch, type Ref } from 'vue';
import { getInterfaceVariables, getInterfaceControlSystem, type AppearanceMode, type InterfaceStyle } from './interfaceThemes';

/** Scope variables to the workbench and body (Element Plus teleports menus/dialogs there).
 * Does not touch models, editor options, font metrics or JSON processing. */
export function useInterfaceTheme(style: Ref<InterfaceStyle>, mode: Ref<AppearanceMode>) {
    const variables = computed(() => getInterfaceVariables(style.value, mode.value));
    const body = document.body;
    const previousStyle = body.getAttribute('data-interface-style');
    const previousControls = body.getAttribute('data-theme-controls');
    const previousVariables = new Map<string, string>();
    let applied: string[] = [];
    const restoreVariables = () => {
        for (const key of applied) {
            const old = previousVariables.get(key);
            if (old) body.style.setProperty(key, old);
            else body.style.removeProperty(key);
        }
        applied = [];
    };
    watch([style, variables], () => {
        restoreVariables();
        body.dataset.interfaceStyle = style.value;
        body.dataset.themeControls = getInterfaceControlSystem(style.value);
        for (const [key, value] of Object.entries(variables.value)) {
            if (!previousVariables.has(key)) previousVariables.set(key, body.style.getPropertyValue(key));
            body.style.setProperty(key, value);
            applied.push(key);
        }
    }, { immediate: true, flush: 'sync' });
    onBeforeUnmount(() => {
        restoreVariables();
        if (previousStyle === null) body.removeAttribute('data-interface-style');
        else body.setAttribute('data-interface-style', previousStyle);
        if (previousControls === null) body.removeAttribute('data-theme-controls');
        else body.setAttribute('data-theme-controls', previousControls);
    });
    return variables;
}
