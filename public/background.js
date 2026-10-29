import { REVIEW_TYPE } from './json-review-policy.js';
import { createReviewController } from './json-review-background.js';
import { CAPTURE_TYPE } from './json-capture-core.js';
import { createCaptureStore } from './json-capture-store.js';
import { createCaptureController } from './json-capture-background.js';

// The normal local tool remains available in builds without the capture APIs.
const permissions = chrome.runtime.getManifest().permissions ?? [];
const configured = ['storage', 'scripting', 'activeTab'].every(name => permissions.includes(name))
    && chrome.storage?.local && chrome.storage?.session && chrome.scripting;
if (!configured) {
    chrome.action.onClicked.addListener(() => {
        void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== CAPTURE_TYPE) return false;
        sendResponse({ ok: false, code: 'NOT_CONFIGURED', error: 'JSON response capture permissions have not been configured in this extension build.' });
        return false;
    });
} else {
    const controller = createCaptureController({ chrome, store: createCaptureStore() });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== CAPTURE_TYPE) return false;
        void controller.handle(message, sender).then(sendResponse);
        // Callback form remains compatible with the extension's minimum Chrome version.
        return true;
    });
    chrome.action.onClicked.addListener(tab => { void controller.actionClicked(tab).catch(() => {}); });
    chrome.runtime.onInstalled.addListener(() => { void controller.synchronize().catch(() => {}); });
    chrome.runtime.onStartup.addListener(() => { void controller.synchronize().catch(() => {}); });
    chrome.permissions.onAdded.addListener(() => { void controller.synchronize().catch(() => {}); });
    chrome.permissions.onRemoved.addListener(() => { void controller.synchronize().catch(() => {}); });
    chrome.tabs.onRemoved.addListener(tabId => { void controller.removeTab(tabId).catch(() => {}); });
    void controller.synchronize().catch(() => {});
}


// Review counters are independent of JSON capture and never inspect editor content.
if (chrome.storage?.local) {
    const reviews = createReviewController({ chrome });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== REVIEW_TYPE) return false;
        void reviews.handle(message, sender).then(sendResponse);
        return true;
    });
    const initializeReviews = () => { void reviews.initialize().catch(() => {}); };
    chrome.runtime.onInstalled?.addListener(initializeReviews);
    chrome.runtime.onStartup?.addListener(initializeReviews);
    initializeReviews();
}
