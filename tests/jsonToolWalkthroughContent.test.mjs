import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getWalkthroughTopics } from '../src/components/utils/jsonToolWalkthroughContent.ts';

const extension = true;
const componentRoot = new URL('../src/components/', import.meta.url);
const workbench = await readFile(new URL('JsonToolWorkbench.vue', componentRoot), 'utf8');
const settings = await readFile(new URL('SettingsDialog.vue', componentRoot), 'utf8');
const contextMenu = await readFile(new URL('composables/useEditorContextMenu.ts', componentRoot), 'utf8');
const coreSteps = [
    ['settings-editor', 'settings'],
    ['settings-format', 'settings'],
    ['tool-format', 'format'],
    ['context-extract', 'extract'],
];
const metadata = ({ title, description, actionLabel, success, ...rest }) => ({ ...rest, hasSuccess: success !== undefined });

for (const isExtension of [false, true]) {
    test((isExtension ? 'extension' : 'web') + ' guide stays short, ordered and equivalent in both languages', () => {
        const zh = getWalkthroughTopics('zh', isExtension);
        const en = getWalkthroughTopics('en', isExtension);
        const expected = [...coreSteps, ...(isExtension ? [] : [['help-floating', 'floating']])];
        assert.deepEqual(zh.map(topic => [topic.id, topic.action]), expected);
        assert.deepEqual(zh.map(metadata), en.map(metadata), 'translations must target the same actions and controls');
        assert.equal(new Set(zh.map(topic => topic.id)).size, zh.length);
        for (const entries of [zh, en]) {
            for (const topic of entries) {
                for (const field of ['title', 'description', 'actionLabel']) {
                    assert.equal(typeof topic[field], 'string', topic.id + ' ' + field);
                    assert.ok(topic[field].trim(), topic.id + ' ' + field);
                }
                assert.equal(topic.section, undefined, 'the short guide no longer has a category directory');
                assert.equal(topic.details, undefined, 'each step has one explanation rather than nested detail blocks');
                assert.equal(topic.success !== undefined, topic.action !== 'settings', 'only demonstrated actions have a result message');
                if (topic.success !== undefined) assert.ok(topic.success.trim());
            }
        }
        for (const topic of zh) {
            assert.ok(topic.description.length <= 100, topic.id + ' description should fit a short guide');
            assert.doesNotMatch(topic.description, /\n/);
        }
    });
}

test('settings steps identify the real editor and formatting accordion sections', () => {
    const entries = getWalkthroughTopics('zh', extension).filter(topic => topic.action === 'settings');
    assert.deepEqual(entries.map(topic => topic.settingsSection), ['editor', 'format']);
    const tags = Array.from(settings.matchAll(/<el-collapse-item\b[^>]*>/g), match => match[0]);
    for (const topic of entries) {
        const destinations = tags.filter(tag => tag.match(/\bname="([^"]+)"/)?.[1] === topic.settingsSection);
        assert.equal(destinations.length, 1, topic.id + ' must have one accordion destination');
        assert.equal(destinations[0].match(/data-guide-section="([^"]+)"/)?.[1], topic.settingsSection);
        assert.equal(topic.target, '.settings-dialog-content [data-guide-section="' + topic.settingsSection + '"]');
    }
});

test('the format and extraction steps point to existing controls and a supported context command', () => {
    const entries = getWalkthroughTopics('zh', extension);
    const format = entries.find(topic => topic.action === 'format');
    assert.equal(format.target, '[data-guide-tool="format"]');
    assert.equal(Array.from(workbench.matchAll(/data-guide-tool="format"/g)).length, 1);
    const extract = entries.find(topic => topic.action === 'extract');
    assert.equal(extract.target, '.editor-panel-input');
    assert.match(workbench, /class="[^"]*\beditor-panel-input\b[^"]*"/);
    assert.match(contextMenu, /id:\s*'json-tool-extract-values-by-key'/, 'the introduced extraction command must exist on this platform');
});

test('the floating entry is a web-only step and uses the real floating-actions container', () => {
    const web = getWalkthroughTopics('en', false);
    const ext = getWalkthroughTopics('en', true);
    const floating = web.find(topic => topic.action === 'floating');
    assert.equal(floating.id, 'help-floating');
    assert.equal(floating.target, '.floating-actions');
    assert.equal(ext.some(topic => topic.action === 'floating'), false);
    assert.deepEqual(ext.map(topic => topic.id), web.slice(0, -1).map(topic => topic.id));
});

test('one guide instance cannot mutate future steps or another locale', () => {
    const baseline = getWalkthroughTopics('zh', false);
    const changed = getWalkthroughTopics('zh', false);
    changed[0].title = 'changed';
    changed[0].settingsSection = 'archive';
    changed.pop();
    assert.deepEqual(getWalkthroughTopics('zh', false), baseline);
    assert.equal(getWalkthroughTopics('en', true)[0].settingsSection, 'editor');
});
