import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { assertMonacoSvgScope, assertMonacoSvgBundleScope } from './monaco-svg-scope.mjs';

const require = createRequire(import.meta.url);
/** @param {import('node:crypto').BinaryLike} bytes */
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** @type {Record<string, string>} */
const reviewed = {
    "base/browser/ui/codicons/codicon/codicon.css": "1ce4b06d1e3b7f1a877c4ff2d2c7060deadda126be5b80f2417d6eddfed68417",
    "platform/theme/browser/iconsStyleSheet.js": "ff75812803678b5dd2c00758a35cbe954a29b645f058cdf4e9311ba4130da2e6",
    "base/browser/ui/menu/menu.js": "9b667361ef5c1b7ecfc041860cc408350a8431e3e6ffa4cbfa2ba4502400f4bb",
    "base/browser/ui/contextview/contextview.js": "38e92188f56f68da841e0807ef6bb5922d4b42b16c5b65d5bc8fc3de627589c1",
    "editor/contrib/inlineProgress/browser/inlineProgressWidget.css": "20aaebebacb82e36949c156c4264f1d21e0367563c5205137db15485c0367212"
};
const svgHash = 'ea9d73fe70ef66b5079417bd0e67d868615dcf143ae4281424c2ce342cd97817';
// Retain the parent's system-adjusted foreground in forced-color modes;
// `none` would freeze the original author color on the pseudo element.
// https://www.w3.org/TR/css-color-adjust-1/#forced-color-adjust-prop
/** @param {string} selector */
const forcedColorsSvgCSS = selector => `@media (forced-colors: active) {
    ${selector} { color: inherit; forced-color-adjust: preserve-parent-color; }
}`;

// Only the glyph drawing changes: retain DOM/classes, pointer targets, opacity,
// animation and each widget's own size/alignment/visibility declarations.
export const svgPseudoCSS = `.codicon:where([class*='codicon-'])::before {
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: top;
    background-color: currentColor;
    -webkit-mask-image: var(--json-codicon-mask, none);
    mask-image: var(--json-codicon-mask, none);
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-position: center;
    mask-position: center;
    -webkit-mask-size: contain;
    mask-size: contain;
}
${forcedColorsSvgCSS(".codicon:where([class*='codicon-'])::before")}`;

/** @param {string} source @param {string} old @param {string} replacement @param {string} label */
function replaceOnce(source, old, replacement, label) {
    if (source.split(old).length !== 2) throw new Error(`[monaco-svg] Unexpected ${label} source layout`);
    return source.replace(old, replacement);
}

/** @param {string} source @param {string} id @param {string} svgCSS @returns {string | null} */
export function patchMonacoSvg(source, id, svgCSS) {
    const path = id.split('?')[0].replaceAll('\\', '/');
    const name = Object.keys(reviewed).find(name => path.endsWith('/monaco-editor/esm/vs/' + name));
    if (!name) return null;
    if (hash(source) !== reviewed[name]) throw new Error(`[monaco-svg] Review the installed Monaco ${name} before updating SVG adaptation`);
    if (name.endsWith('/codicon.css')) {
        if (hash(svgCSS) !== svgHash) throw new Error('[monaco-svg] Regenerate and review the scoped SVG contours');
        return source.replace(/@font-face \{[\s\S]*?\}\n/, '').replace('16px/1 codicon', '16px/1 sans-serif') + '\n' + svgPseudoCSS + '\n' + svgCSS;
    }
    if (name.endsWith('/iconsStyleSheet.js')) {
        source = replaceOnce(source, "const contentVar = `--vscode-icon-${contribution.id}-content`;", "const contentVar = `--vscode-icon-${contribution.id}-content`;\n                const maskVar = `--vscode-icon-${contribution.id}-mask`;", name);
        source = replaceOnce(source,
            "rules.push(`.codicon-${contribution.id}:before { content: '${definition.fontCharacter}'; font-family: ${asCSSPropertyValue(fontContribution.id)}; }`);",
            "rules.push(`.codicon-${contribution.id}:before { content: '${definition.fontCharacter}'; font-family: ${asCSSPropertyValue(fontContribution.id)}; width: auto; height: auto; background: none; -webkit-mask: none; mask: none; }`);\n                    rootAttribs.push(`${maskVar}: none;`);", name);
        source = replaceOnce(source,
            "rootAttribs.push(`${contentVar}: '${definition.fontCharacter}'; ${fontFamilyVar}: 'codicon';`);\n                    rules.push(`.codicon-${contribution.id}:before { content: '${definition.fontCharacter}'; }`);",
            "const codepoint = definition.fontCharacter.startsWith('\\\\') ? definition.fontCharacter.slice(1).toLowerCase() : definition.fontCharacter.codePointAt(0).toString(16);\n                    const mask = `var(--json-codicon-${codepoint})`;\n                    rootAttribs.push(`${contentVar}: ''; ${fontFamilyVar}: inherit; ${maskVar}: ${mask};`);\n                    rules.push(`.codicon-${contribution.id}:before { content: ''; --json-codicon-mask: ${mask}; }`);", name);
        return source;
    }
    if (name.endsWith('/menu.js')) {
        return replaceOnce(source,
            "return `.codicon-${c.id}:before { content: '\\\\${fontCharacter.toString(16)}'; }`;",
            "return `.codicon-${c.id}:before { content: ''; --json-codicon-mask: var(--json-codicon-${fontCharacter.toString(16)}); }`;", name);
    }
    if (name.endsWith('/contextview.js')) {
        source = replaceOnce(source, 'font: normal normal normal 16px/1 codicon;', 'font: normal normal normal 16px/1 sans-serif;', name);
        return replaceOnce(source, 'const SHADOW_ROOT_CSS = /* css */ `', 'const SHADOW_ROOT_CSS = /* css */ `' + svgPseudoCSS + '\n', name);
    }
    if (name.endsWith('/inlineProgressWidget.css')) {
        return replaceOnce(source, 'content: var(--vscode-icon-x-content);', `content: var(--vscode-icon-x-content);\n    display: inline-block; width: 1em; height: 1em;\n    background-color: currentColor;\n    -webkit-mask: var(--vscode-icon-x-mask) center / contain no-repeat;\n    mask: var(--vscode-icon-x-mask) center / contain no-repeat;`, name)
            + '\n' + forcedColorsSvgCSS('.inline-progress-widget:hover .icon::before');
    }
    throw new Error('[monaco-svg] Missing reviewed adapter: ' + name);
}

/** @returns {import('vite').Plugin} */
export function monacoSvgPlugin() {
    const font = resolve('node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf');
    const svgFile = resolve('assets/icons/codicon-0.52.2.svg.css');
    const svgCSS = readFileSync(svgFile, 'utf8');
    return {
        name: 'json-tool-monaco-svg', enforce: 'pre',
        async buildStart() {
            await assertMonacoSvgScope();
            if (require('monaco-editor/package.json').version !== '0.52.2'
                || hash(readFileSync(font)) !== '0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9'
                || hash(svgCSS) !== svgHash) throw new Error('[monaco-svg] Review this Monaco/font/SVG version first');
        },
        transform(source, id) {
            const result = patchMonacoSvg(source, id, svgCSS);
            if (result === null) return null;
            this.addWatchFile(svgFile);
            return { code: result, map: null };
        },
        generateBundle(_options, bundle) {
            assertMonacoSvgBundleScope(this.getModuleIds());
            for (const file of Object.keys(bundle)) {
                if (/codicon.*\.(?:woff2?|ttf|otf)$/.test(file)) throw new Error('[monaco-svg] Unexpected icon-font production asset: ' + file);
            }
        },
    };
}
