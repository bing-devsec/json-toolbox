import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import {
    auditElementButtonApplicationSource, auditElementButtonApplication,
    auditElementButtonDependencies, pruneUnusedElementButtonColors, elementButtonColorsPlugin,
} from '../scripts/vite/element-button-colors.mjs';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'node_modules/element-plus/es/components/button/src/button-custom.mjs');
const original = readFileSync(file, 'utf8');
const patched = pruneUnusedElementButtonColors(original, file);
const vue = template => `<template>${template}</template><script setup>import { ElButton, ElDropdown } from 'element-plus';</script>`;

// Freeze the reviewed application evidence, rather than asserting only absence of a
// token in the output. Native walkthrough controls do not consume Element buttons;
// the two welcome buttons remain audited. The dependency closure includes optional dialogs.
test('current 59 button sites and the complete 334-module closure satisfy the invariant', () => {
    const result = auditElementButtonApplication(root);
    assert.equal(result.buttonCount, 59);
    assert.equal(result.modules, 334);
    assert.deepEqual(result.consumers, [
        'components/dropdown/src/dropdown.vue_vue_type_script_lang.mjs',
        'components/message-box/src/index.vue_vue_type_script_lang.mjs',
    ]);
    assert(result.files >= 150);
});

test('source guard rejects direct and forwarded colors, aliases, defaults and indirect consumers', () => {
    const failures = [
        vue('<el-button color="red" />'), vue('<ElButton :color="color" />'),
        vue('<el-button v-bind="props" />'), vue('<el-button :[key]="value" />'),
        vue('<el-button v-bind:[key]="value" />'),
        vue('<ButtonWrapper :color="color" />'), vue('<ButtonWrapper v-bind="attrs" />'),
        vue('<el-dropdown :button-props="props" />'), vue('<ElDropdown split-button />'),
        vue('<el-button ref="button" />'), vue('<component :is="target" />'),
        vue('<div is="vue:ElButton" />'),
        `<script setup>import { ElButton as Button } from 'element-plus';</script>`,
        `<script setup>import ElementPlus from 'element-plus';</script>`,
        `<script setup>import * as ElementPlus from 'element-plus';</script>`,
        `<script setup>import { ElColorPicker } from 'element-plus';</script>`,
        `<script setup>import { ElConfigProvider } from 'element-plus';</script>`,
        `<script setup>import ElButton from 'element-plus/es/components/button/index.mjs';</script>`,
        `<script setup>import { ElButton } from 'element-plus'; ElButton.props.color.default='red';</script>`,
        `<script setup>import { ElButton } from 'element-plus'; const props = ElButton.props;</script>`,
        `<script setup>import { h } from 'vue'; h('el-button', {color:'red'});</script>`,
        `<script setup>import { h as render } from 'vue';</script>`,
        `<script setup>import * as Vue from 'vue';</script>`,
        `<script setup>import Vue from 'vue'; Vue.h('el-button');</script>`,
        `<script setup>import { h as make, resolveComponent as resolve } from '@vue/runtime-core'; make(resolve('ElButton'),{color:'red'});</script>`,
        `<script setup>import * as Vue from '@vue/runtime-dom'; Vue['h']('el-button');</script>`,
        `<script setup>import {h} from 'vue'; const make=h;</script>`,
        `<template src="./Button.html"></template><script setup>import {ElButton} from 'element-plus';</script>`,
        `<template><div /></template><script src="./Button.js"></script>`,
        `<template lang="pug">el-button(color="red")</template>`,
        `<script setup lang="tsx">const button = <Button color="red" />;</script>`,
        `<script setup>createVNode(component, props);</script>`,
        `<script setup>resolveComponent('ElButton');</script>`,
        `<script setup>someComponent.setPropsDefaults({color:'red'});</script>`,
        `<script setup>app.component('x', definition);</script>`,
        `<script setup>app.use(ElementPlus);</script>`,
        `<script setup>import('element-plus');</script>`,
        `<script setup>import ThirdPartyButton from 'new-vue-button-library';</script>`,
        `<script setup>import ThirdPartyButton from 'element-plus-wrapper';</script>`,
        `<script setup>import ButtonWrapper from '../scripts/ButtonWrapper.vue';</script>`,
        `<script setup>import ButtonWrapper from '~/types/ButtonWrapper';</script>`,
        `<script setup>require('element-plus');</script>`,
        `<script setup>import Element = require('element-plus');</script>`,
        `<script setup>export { h as make } from 'vue';</script>`,
        `<script setup>import(packageName);</script>`,
        `<script setup>app['use'](ElementPlus);</script>`,
        `<script setup>export { ElButton } from 'element-plus';</script>`,
    ];
    for (const source of failures) assert.throws(() => auditElementButtonApplicationSource(source, '/app/Test.vue'), /element-button-colors/, source);
    assert.throws(() => auditElementButtonApplicationSource(`export const render=()=> <Button color="red" />;`, '/app/Button.tsx'), /JSX/);
    assert.throws(() => auditElementButtonApplicationSource(`export const render=()=> <Button {...props} />;`, '/app/Button.jsx'), /JSX/);
    assert.doesNotThrow(() => auditElementButtonApplicationSource(vue('<el-button type="primary" :loading="busy" :style="theme" @click="run" />'), '/app/Test.vue'));
    assert.doesNotThrow(() => auditElementButtonApplicationSource(`import {type UploadFile} from 'element-plus';`, '/app/types.ts'));
});

test('reviewed workbench shell is the only permitted dynamic component', () => {
    const name = resolve(root, 'src/App.vue');
    const source = readFileSync(name, 'utf8');
    assert.doesNotThrow(() => auditElementButtonApplicationSource(source, name));
    assert.throws(() => auditElementButtonApplicationSource(source.replace(':is="workbench"', ':is="ElButton"'), name), /dynamic component/);
    assert.throws(() => auditElementButtonApplicationSource(source, '/other/Loader.vue'), /dynamic component/);
});

test('adapter only removes TinyColor and its unreachable branch, preserving the no-color path', () => {
    assert(!patched.includes('@ctrl/tinycolor'));
    assert(!patched.includes('function darken('));
    for (const fragment of [
        'const _disabled = useFormDisabled();', 'const ns = useNamespace("button");',
        'return computed(() => {', 'let styles = {};', 'let buttonColor = props.color;', 'return styles;',
    ]) assert(patched.includes(fragment), fragment);
    assert(patched.includes('if (buttonColor) throw new Error('));
    assert.throws(() => pruneUnusedElementButtonColors(original + '\n', file), /Unreviewed button/);
    assert.equal(pruneUnusedElementButtonColors('unrelated', '/app/button-custom.mjs'), null);
    assert.equal(pruneUnusedElementButtonColors(original, file.replaceAll('/', '\\') + '?v=1'), patched);
});

test('dependency guard refuses unreviewed releases and root exports before transforming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'element-colors-guard-'));
    try {
        const dep = join(dir, 'node_modules/element-plus');
        mkdirSync(join(dep, 'es'), { recursive: true });
        writeFileSync(join(dep, 'package.json'), JSON.stringify({version:'2.13.8'}));
        assert.throws(() => auditElementButtonDependencies(dir), /Unreviewed Element Plus/);
        writeFileSync(join(dep, 'package.json'), JSON.stringify({version:'2.13.7'}));
        writeFileSync(join(dep, 'es/index.mjs'), '// new indirect consumer');
        assert.throws(() => auditElementButtonDependencies(dir), /Unreviewed Element Plus/);
        const plugin = elementButtonColorsPlugin();
        plugin.configResolved({root:dir});
        const warnings=[];
        plugin.buildStart.call({warn:message=>warnings.push(message)});
        assert.equal(warnings.length,1);
        assert.match(warnings[0], /Keeping the original/);
        assert.equal(plugin.transform(original,file),null,'Unreviewed usage retains the original implementation');
    } finally { rmSync(dir, {recursive:true, force:true}); }
    const plugin = elementButtonColorsPlugin();
    assert.equal(plugin.apply, 'build');
    plugin.configResolved({root});
    const warnings=[];
    assert.doesNotThrow(() => plugin.buildStart.call({warn:message=>warnings.push(message)}));
    assert.deepEqual(warnings,[],'Current usage must actually enable specialization');
    assert.equal(plugin.transform(original, file).code, patched);
});

test('real Vue SSR output matches for 448 button combinations and group/slot use; TinyColor leaves dependency graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'element-colors-render-'));
    try {
        const modules = [];
        for (const prune of [false, true]) {
            const result = await build({
                absWorkingDir:root, entryPoints:['element-plus/es/components/button/index.mjs'],
                bundle:true, write:false, format:'esm', platform:'node', metafile:true,
                define:{'process.env.NODE_ENV':'"production"'}, drop:['console'],
                plugins:[{name:'button-color-render-test',setup(builder){
                    builder.onResolve({filter:/^vue$/}, () => ({path:resolve(root,'node_modules/vue/index.mjs'),external:true}));
                    if (prune) builder.onLoad({filter:/\/button-custom\.mjs$/}, args => ({contents:pruneUnusedElementButtonColors(readFileSync(args.path,'utf8'),args.path),loader:'js'}));
                }}],
            });
            assert.equal(Object.keys(result.metafile.inputs).some(name=>name.includes('@ctrl/tinycolor')), !prune);
            const output = join(dir, prune ? 'patched.mjs' : 'original.mjs');
            writeFileSync(output, result.outputFiles[0].text);
            modules.push(await import(pathToFileURL(output).href));
        }
        const render = (module, props, grouped=false) => renderToString(createSSRApp({render:()=>grouped
            ? h(module.ElButtonGroup,{type:'warning',size:'small'},()=>h(module.ElButton,props,()=>['中','文']))
            : h(module.ElButton,props,{default:()=>['Action'],icon:()=>h('svg',{'data-icon':'test'})})}));
        let count=0;
        for (const type of ['', 'primary', 'success', 'warning', 'danger', 'info', 'text']) {
            for (const size of ['', 'small', 'default', 'large']) {
                for (let flags=0;flags<16;flags++) {
                    const props={type,size,disabled:Boolean(flags&1),loading:Boolean(flags&2),plain:Boolean(flags&4),dark:Boolean(flags&8),
                        color: flags&1 ? undefined : '', round:Boolean(flags&2),text:Boolean(flags&4),link:Boolean(flags&8),
                        nativeType:flags%2?'submit':'button','aria-label':'Test',class:'unchanged',style:{color:'var(--theme-button-color)'}};
                    assert.equal(await render(modules[0],props),await render(modules[1],props),JSON.stringify(props));count++;
                }
            }
        }
        assert.equal(count,448);
        for (const props of [{}, {circle:true}, {bg:true,text:true}, {dashed:true}, {tag:'a',href:'#test'}, {autoInsertSpace:true}, {nativeType:'reset'}]) {
            assert.equal(await render(modules[0],props,true),await render(modules[1],props,true));
        }
        assert.match(await render(modules[0],{color:'#f00'}),/--el-button-bg-color/);
        // This source invariant is build-time enforced. A runtime bypass also fails
        // visibly rather than silently losing a newly requested arbitrary color.
        const app=createSSRApp({render:()=>h(modules[1].ElButton,{color:'#f00'},()=>['x'])});
        app.config.warnHandler=()=>{};
        await assert.rejects(renderToString(app),/Unexpected button color/);
    } finally { rmSync(dir,{recursive:true,force:true}); }
});
