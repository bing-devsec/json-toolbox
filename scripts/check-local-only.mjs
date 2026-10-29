import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
// Default-on JSON document capture uses only the explicitly approved HTTP(S) hosts.
assert.deepEqual([...(manifest.permissions ?? [])].sort(), ['activeTab', 'scripting', 'storage'].sort());
assert.deepEqual([...(manifest.host_permissions ?? [])].sort(), ['http://*/*', 'https://*/*'].sort());
for (const key of ['optional_host_permissions', 'content_scripts', 'optional_permissions', 'externally_connectable', 'web_accessible_resources', 'devtools_page']) {
    assert.ok(manifest[key] === undefined, `Unexpected extension capability: ${key}`);
}
assert.equal(manifest.background.type, 'module');
assert.match(manifest.content_security_policy.extension_pages, /connect-src 'self'/);
const removed = /\b(?:FetchJsonDialog|ShareDialog|BugFeedbackDialog|useClientGuard|useRuntimeConfig|useNuxtApp|navigateTo|\$fetch)\b|\/api(?:-backend)?\/|liubing\.xyz|~\//;
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(filename) : [filename];
});
for (const filename of walk(path.join(root, 'src'))) {
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), removed, `Online/blog dependency in ${filename}`);
}
for (const filename of walk(path.join(root, 'dist')).filter((name) => /\.(?:html|js)$/.test(name))) {
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /\/api\/share-json|\/api\/fetch-json|api-backend|guard_core|liubing\.xyz/, `Online dependency in bundle ${filename}`);
}
for (const filename of [manifest.background.service_worker, 'json-review-background.js', 'json-review-policy.js', 'index.html', ...Object.values(manifest.icons)]) {
    assert.ok(fs.existsSync(path.join(root, 'dist', filename)), `Missing extension resource: ${filename}`);
}
for (const filename of walk(path.join(root, 'public')).filter(name => /json-(?:capture|review).*\.js$/.test(name))) {
    execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' });
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/, `Unexpected network replay in ${filename}`);
}
console.log('Local-only check passed: no blog APIs or uploads; JSON capture uses only approved HTTP(S) website access; review invitations stay local.');

