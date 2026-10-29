import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getSourceInfo, sha256 } from './package-info.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-info.json'), 'utf8'));
if (info.version !== pkg.version || info.sourceSha256 !== getSourceInfo(root).sourceSha256) {
    throw new Error('dist 与当前源码不一致，请执行 npm run package 重新构建');
}
const release = path.join(root, 'release');
fs.mkdirSync(release, { recursive: true });
const filename = `json-tool-extension-${pkg.version}.zip`;
const output = path.join(release, filename);
const infoOutput = path.join(release, filename.replace(/\.zip$/, '.build-info.json'));
const checksumOutput = output + '.sha256';
for (const artifact of [output, infoOutput, checksumOutput]) {
    if (fs.existsSync(artifact)) throw new Error(`Refusing to overwrite ${artifact}. Increment the extension version before packaging.`);
}
execFileSync('zip', ['-q', '-r', output, '.', '-x', '*.DS_Store'], { cwd: path.join(root, 'dist') });
const packageInfo = {
    ...info,
    packagedAt: new Date().toISOString(),
    packageFile: filename,
    packageBytes: fs.statSync(output).size,
    packageSha256: sha256(fs.readFileSync(output)),
};
fs.writeFileSync(infoOutput, JSON.stringify(packageInfo, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(checksumOutput, `${packageInfo.packageSha256}  ${filename}\n`, { flag: 'wx' });
console.log(`Extension package: ${output}`);
console.log(`SHA-256: ${packageInfo.packageSha256}`);
