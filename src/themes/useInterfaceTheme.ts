import { computed, onBeforeUnmount, watch, type Ref } from 'vue';
import { getInterfaceVariables, type AppearanceMode, type InterfaceStyle } from './registry';

/** Applies only the variables a theme returns. It owns no colors or rules. */
export function useInterfaceTheme(style: Ref<InterfaceStyle>, mode: Ref<AppearanceMode>) {
    const variables = computed(() => getInterfaceVariables(style.value, mode.value));
    const body = document.body;
    const previousStyle = body.getAttribute('data-interface-style');
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
    });
    return variables;
}
