// Quick input (Ctrl+G / command palette) uses an input, unlike the editor and find widgets.
const fieldSelector = 'textarea, .quick-input-box input.input';
type MonacoInputField = HTMLTextAreaElement | HTMLInputElement;

const normalizeIdSegment = (value: string) => {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return normalized || 'field';
};

const getFieldRole = (textarea: MonacoInputField, index: number) => {
    if (textarea.matches('.quick-input-box input.input')) {
        // The quick-input label and value change as commands/line numbers change.
        return 'quick-input';
    }

    if (textarea.closest('.find-widget')) {
        const part = textarea.closest('.replace-part') ? 'replace' : textarea.closest('.find-part') ? 'find' : 'widget';
        const label = textarea.getAttribute('aria-label') || textarea.getAttribute('placeholder') || `field-${index + 1}`;
        return `find-widget-${part}-${normalizeIdSegment(label)}`;
    }

    if (textarea.classList.contains('inputarea')) {
        return 'editor-input';
    }

    const label = textarea.getAttribute('aria-label') || textarea.getAttribute('placeholder');
    if (label) {
        return normalizeIdSegment(label);
    }

    return `textarea-${index + 1}`;
};

const applyFieldAttrs = (container: HTMLElement, prefix: string) => {
    const textareas = Array.from(container.querySelectorAll<MonacoInputField>(fieldSelector));
    const roleCount = new Map<string, number>();

    textareas.forEach((textarea, index) => {
        const role = getFieldRole(textarea, index);
        const nextCount = (roleCount.get(role) || 0) + 1;
        roleCount.set(role, nextCount);

        const uniqueRole = nextCount === 1 ? role : `${role}-${nextCount}`;
        let attrValue = `${prefix}-${uniqueRole}`;

        if (!textarea.id) {
            // Existing widgets keep their IDs; inserting/replacing a sibling must not reuse one.
            const baseValue = attrValue;
            let suffix = 2;
            while (container.ownerDocument.getElementById(attrValue)) {
                attrValue = `${baseValue}-${suffix++}`;
            }
            textarea.id = attrValue;
        }
        if (!textarea.getAttribute('name')) {
            textarea.setAttribute('name', attrValue);
        }
    });
};

const shouldSyncForMutations = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches(fieldSelector) || node.classList.contains('find-widget') || node.querySelector(fieldSelector) || node.querySelector('.find-widget')) {
                return true;
            }
        }
    }

    return false;
};

export interface MonacoTextareaAttrObserver {
    disconnect: () => void;
    syncNow: () => void;
}

export const ensureMonacoTextareaAttrs = (container: HTMLElement, prefix: string): MonacoTextareaAttrObserver => {
    const syncNow = () => applyFieldAttrs(container, prefix);

    const observer = new MutationObserver((mutations) => {
        if (!shouldSyncForMutations(mutations)) return;
        syncNow();
    });

    observer.observe(container, {
        childList: true,
        subtree: true,
    });

    syncNow();

    return {
        disconnect: () => observer.disconnect(),
        syncNow,
    };
};
