import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
    entryPoints: ['src/components/utils/monacoTextareaAttrs.ts'],
    bundle: true, platform: 'node', format: 'cjs', write: false,
});

// Only DOM tree/selector/observer mechanics are simulated; the production helper runs unchanged.
function fixture() {
    const observers = [];
    const document = {};
    const queueMutation = (record) => {
        for (const observer of observers) {
            const { target, options } = observer;
            if (target && options.childList && (target === record.target || (options.subtree && target.contains(record.target)))) {
                observer.records.push(record);
            }
        }
    };
    const simpleMatch = (element, selector) => {
        const parts = selector.split('.');
        const tag = parts.shift();
        return (!tag || element.tagName === tag.toUpperCase()) && parts.every(name => element.classList.contains(name));
    };
    class Element {
        constructor(tagName = 'div', className = '') {
            this.tagName = tagName.toUpperCase();
            this.className = className;
            this.children = [];
            this.parentNode = null;
            this.ownerDocument = document;
            this.attributes = new Map();
            this.scans = 0;
            this.value = '';
            this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
        }
        get id() { return this.getAttribute('id') ?? ''; }
        set id(value) { this.setAttribute('id', value); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        matches(selector) {
            return selector.split(',').some(branch => {
                const parts = branch.trim().split(/\s+/);
                if (!simpleMatch(this, parts.pop())) return false;
                let ancestor = this.parentNode;
                while (parts.length) {
                    const part = parts.pop();
                    while (ancestor && !simpleMatch(ancestor, part)) ancestor = ancestor.parentNode;
                    if (!ancestor) return false;
                    ancestor = ancestor.parentNode;
                }
                return true;
            });
        }
        closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
        querySelectorAll(selector) {
            this.scans++;
            const found = [];
            const visit = element => {
                for (const child of element.children) {
                    if (child.matches(selector)) found.push(child);
                    visit(child);
                }
            };
            visit(this);
            return found;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        appendChild(child) {
            child.remove();
            this.children.push(child);
            child.parentNode = this;
            queueMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
            return child;
        }
        remove() {
            if (!this.parentNode) return;
            const parent = this.parentNode;
            parent.children.splice(parent.children.indexOf(this), 1);
            this.parentNode = null;
            queueMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
        }
    }
    class MutationObserver {
        constructor(callback) { this.callback = callback; this.records = []; this.target = null; observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
        disconnect() { this.target = null; this.records.length = 0; }
    }
    const body = new Element('body');
    document.getElementById = id => {
        const visit = node => node.id === id ? node : node.children.map(visit).find(Boolean);
        return visit(body) ?? null;
    };
    const container = body.appendChild(new Element('div', 'editor-container'));
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, HTMLElement: Element, MutationObserver });
    const { ensureMonacoTextareaAttrs } = module.exports;
    const element = (tag, className = '', attrs = {}) => {
        const node = new Element(tag, className);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        return node;
    };
    const quickInput = (parent = container) => {
        const widget = element('div', 'quick-input-widget');
        const box = widget.appendChild(element('div', 'quick-input-box'));
        const input = box.appendChild(element('input', 'input', { role: 'combobox', 'aria-label': 'Type a line number', 'aria-controls': 'quickInput_list' }));
        parent.appendChild(widget);
        return { widget, box, input };
    };
    const flush = () => {
        for (const observer of observers) {
            if (observer.target && observer.records.length) observer.callback(observer.records.splice(0));
        }
    };
    return { body, container, element, quickInput, flush, observers, ensureMonacoTextareaAttrs };
}

const assertNamed = (field, expected) => {
    assert.equal(field.id, expected);
    assert.equal(field.getAttribute('name'), expected);
};

test('initial quick input receives stable identifiers without changing its value or ARIA contract', () => {
    const f = fixture();
    const { input } = f.quickInput();
    input.value = ':125:4';
    const handle = f.ensureMonacoTextareaAttrs(f.container, 'monaco-input-editor');
    assertNamed(input, 'monaco-input-editor-quick-input');
    assert.equal(input.value, ':125:4');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), 'quickInput_list');
    input.setAttribute('aria-label', 'Current Line: 125. Type another line number.');
    input.value = '>command';
    handle.syncNow();
    assertNamed(input, 'monaco-input-editor-quick-input');
    assert.equal(input.value, '>command');
    assert.equal(f.observers[0].target, f.container);
    assert.equal(f.observers[0].options.attributes, undefined);
});

test('late quick input is discovered inside a newly inserted wrapper and on direct input insertion', () => {
    const f = fixture();
    f.ensureMonacoTextareaAttrs(f.container, 'editor');
    const { input, box } = f.quickInput();
    assert.equal(input.id, '');
    f.flush();
    assertNamed(input, 'editor-quick-input');
    const second = box.appendChild(f.element('input', 'input'));
    f.flush();
    assertNamed(second, 'editor-quick-input-2');
});

test('input, preview and both Diff editors keep separate quick-input identifiers', () => {
    const f = fixture();
    const prefixes = ['monaco-input-editor', 'monaco-output-editor', 'monaco-diff-left-editor', 'monaco-diff-right-editor'];
    const inputs = prefixes.map(prefix => {
        const root = f.body.appendChild(f.element('div'));
        f.ensureMonacoTextareaAttrs(root, prefix);
        return f.quickInput(root).input;
    });
    f.flush();
    inputs.forEach((input, index) => assertNamed(input, `${prefixes[index]}-quick-input`));
    assert.equal(new Set(inputs.map(input => input.id)).size, 4);
});

test('editor, find and replace textarea identifiers retain their previous naming and existing attributes', () => {
    const f = fixture();
    const editor = f.container.appendChild(f.element('textarea', 'inputarea'));
    const findWidget = f.container.appendChild(f.element('div', 'find-widget'));
    const find = findWidget.appendChild(f.element('div', 'find-part')).appendChild(f.element('textarea', '', { 'aria-label': 'Find' }));
    const replace = findWidget.appendChild(f.element('div', 'replace-part')).appendChild(f.element('textarea', '', { placeholder: 'Replace' }));
    const existing = f.container.appendChild(f.element('textarea', '', { id: 'existing-text-id', name: 'existing-text-name' }));
    const onlyId = f.container.appendChild(f.element('textarea', '', { id: 'existing-id-only', 'aria-label': 'Named field' }));
    const { input } = f.quickInput();
    input.id = 'monaco-supplied-input-id';
    input.setAttribute('name', 'monaco-supplied-input-name');
    f.ensureMonacoTextareaAttrs(f.container, 'editor');
    assertNamed(editor, 'editor-editor-input');
    assertNamed(find, 'editor-find-widget-find-find');
    assertNamed(replace, 'editor-find-widget-replace-replace');
    assert.equal(existing.id, 'existing-text-id');
    assert.equal(existing.getAttribute('name'), 'existing-text-name');
    assert.equal(onlyId.id, 'existing-id-only');
    assert.equal(onlyId.getAttribute('name'), 'editor-named-field');
    assert.equal(input.id, 'monaco-supplied-input-id');
    assert.equal(input.getAttribute('name'), 'monaco-supplied-input-name');
});

test('replacing an earlier same-role field cannot duplicate a surviving field ID', () => {
    const f = fixture();
    const first = f.quickInput();
    const second = f.quickInput();
    f.ensureMonacoTextareaAttrs(f.container, 'editor');
    const survivingId = second.input.id;
    first.widget.remove();
    const replacement = f.quickInput();
    f.flush();
    assert.equal(second.input.id, survivingId);
    assert.notEqual(replacement.input.id, survivingId);
    assert.ok(replacement.input.id);
    assert.equal(replacement.input.getAttribute('name'), replacement.input.id);
    assert.equal(new Set(f.container.querySelectorAll('input').map(input => input.id)).size, 2);
});

test('generated quick-input identifiers also avoid IDs owned outside the editor container', () => {
    const f = fixture();
    f.body.appendChild(f.element('div', '', { id: 'editor-quick-input' }));
    const { input } = f.quickInput();
    f.ensureMonacoTextareaAttrs(f.container, 'editor');
    assertNamed(input, 'editor-quick-input-2');
});

test('unrelated inputs, hidden quick-picker checkboxes and rendering rows do not trigger a container rescan', () => {
    const f = fixture();
    const { widget } = f.quickInput();
    f.ensureMonacoTextareaAttrs(f.container, 'editor');
    const scans = f.container.scans;
    const unrelated = f.container.appendChild(f.element('input', 'input', { type: 'text' }));
    const checkAll = widget.appendChild(f.element('input', 'quick-input-check-all', { type: 'checkbox' }));
    const row = f.container.appendChild(f.element('div', 'view-line'));
    row.appendChild(f.element('span', 'mtk1'));
    f.flush();
    assert.equal(f.container.scans, scans);
    assert.equal(unrelated.id, '');
    assert.equal(unrelated.getAttribute('name'), null);
    assert.equal(checkAll.id, '');
    assert.equal(checkAll.getAttribute('name'), null);
});

test('disconnect drops queued mutations and stops future attribute updates', () => {
    const f = fixture();
    const handle = f.ensureMonacoTextareaAttrs(f.container, 'editor');
    const queued = f.quickInput().input;
    handle.disconnect();
    f.flush();
    const later = f.quickInput().input;
    f.flush();
    assert.equal(queued.id, '');
    assert.equal(later.id, '');
    assert.equal(f.observers[0].target, null);
    assert.equal(f.observers[0].records.length, 0);
});
