import { ElMessage, type MessageHandler } from 'element-plus';
import { h } from 'vue';
import './jsonToolMessage.css';

const MESSAGE_CUSTOM_CLASS = 'json-tool-message';
const MESSAGE_INSET = 15;
const POSITION_VARIABLES = [
    '--json-tool-message-center-y',
    '--json-tool-message-right',
    '--json-tool-message-width',
] as const;

type MessageType = 'success' | 'error' | 'warning' | 'info';
const activeMessages = new Set<{ handler?: MessageHandler }>();
let releaseToolbar: (() => void) | undefined;
let refreshToolbar: (() => void) | undefined;
let messageDocument: Document | undefined;
let messageStack: HTMLElement | undefined;

/** Keep fading DOM nodes in flow until Element Plus removes them after the transition. */
const getMessageStack = () => {
    if (messageStack) return messageStack;
    const ownerDocument = messageDocument ?? (typeof document === 'undefined' ? undefined : document);
    if (!ownerDocument) return undefined;
    const stack = ownerDocument.createElement('div');
    stack.className = 'json-tool-message-stack';
    (ownerDocument.body).appendChild(stack);
    messageStack = stack;
    return stack;
};

/** Release only this workbench's messages; each active result has its own lifetime. */
const closeActiveMessages = () => {
    const previous = [...activeMessages];
    activeMessages.clear();
    previous.forEach(entry => entry.handler?.close());
};

/** Keep messages on body (above dialogs), anchored to the toolbar's viewport bounds.
 * Ancestor size changes cover the import notice appearing, wrapping and closing.
 * No polling or editor-scroll listener is needed. */
export const bindJsonToolMessageToolbar = (toolbar: HTMLElement): (() => void) => {
    releaseToolbar?.();
    const document = toolbar.ownerDocument;
    const view = document.defaultView;
    if (!view) return () => {};
    const style = document.body.style;
    const previous = POSITION_VARIABLES.map(name => [name, style.getPropertyValue(name)] as const);
    let disposed = false;
    const write = (name: string, value: number) => {
        const text = String(value) + 'px';
        if (style.getPropertyValue(name) !== text) style.setProperty(name, text);
    };
    const update = () => {
        if (disposed) return;
        const rect = toolbar.getBoundingClientRect();
        if (rect.height <= 0 || rect.width <= 0) return;
        write(POSITION_VARIABLES[0], rect.top + rect.height / 2);
        write(POSITION_VARIABLES[1], Math.max(0, view.innerWidth - rect.right) + MESSAGE_INSET);
        write(POSITION_VARIABLES[2], Math.max(0, rect.width - MESSAGE_INSET * 2));
    };
    const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(update) : undefined;
    // The toolbar can move without resizing when its flex ancestors shrink for a notice.
    let element: HTMLElement | null = toolbar;
    while (element && element !== document.body) {
        observer?.observe(element);
        element = element.parentElement;
    }
    view.addEventListener('resize', update);
    view.addEventListener('scroll', update);
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        view.removeEventListener('resize', update);
        view.removeEventListener('scroll', update);
        for (const [name, value] of previous) {
            if (value) style.setProperty(name, value);
            else style.removeProperty(name);
        }
        closeActiveMessages();
        messageStack?.remove();
        messageStack = undefined;
        refreshToolbar = undefined;
        messageDocument = undefined;
        if (releaseToolbar === dispose) releaseToolbar = undefined;
    };
    releaseToolbar = dispose;
    refreshToolbar = update;
    messageDocument = document;
    update();
    return dispose;
};

export const globalNotify = (type: MessageType, message: string, duration?: number) => {
    refreshToolbar?.();
    const entry: { handler?: MessageHandler } = {};
    activeMessages.add(entry);
    entry.handler = ElMessage({
        message: h('span', { title: message }, message),
        type,
        ...(duration === undefined ? {} : { duration }),
        placement: 'top-right',
        appendTo: getMessageStack(),
        customClass: MESSAGE_CUSTOM_CLASS,
        onClose: () => {
            activeMessages.delete(entry);
        },
    });
};

export const showMessageSuccess = (message: string, duration?: number) => globalNotify('success', message, duration);
export const showMessageError = (message: string, duration?: number) => globalNotify('error', message, duration);
export const showMessageWarning = (message: string, duration?: number) => globalNotify('warning', message, duration);
export const showMessageInfo = (message: string, duration?: number) => globalNotify('info', message, duration);
