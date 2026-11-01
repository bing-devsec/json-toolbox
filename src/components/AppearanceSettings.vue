<template>
    <section class="appearance-settings" :aria-label="english ? 'Appearance' : '外观设置'">
        <div class="appearance-settings-heading">
            <strong :id="modeLabelId">{{ english ? 'Color mode' : '明暗模式' }}</strong>
            <div class="appearance-mode" role="group" :aria-labelledby="modeLabelId">
                <button v-for="mode in modes" :key="mode.id" type="button" :aria-pressed="themeMode === mode.id" @click="$emit('update:themeMode', mode.id)">{{ english ? mode.en : mode.zh }}</button>
            </div>
        </div>
        <div class="appearance-style-section">
            <strong :id="styleLabelId">{{ english ? 'Theme style' : '主题风格' }}</strong>
            <div class="appearance-style-list" role="group" :aria-labelledby="styleLabelId">
                <button v-for="style in interfaceStyles" :key="style.id" type="button" class="appearance-style-card" :data-style="style.id" :aria-pressed="interfaceStyle === style.id" @click="$emit('update:interfaceStyle', style.id)">
                    <span class="appearance-swatch" :class="`swatch-${style.id}`" :data-mode="themeMode" aria-hidden="true"><i></i><i></i><i></i></span>
                    <span class="appearance-style-name">{{ english ? style.en : style.zh }}</span>
                    <span class="appearance-style-description">{{ english ? style.descriptionEn : style.descriptionZh }}</span>
                </button>
            </div>
        </div>
    </section>
</template>
<script setup lang="ts">
import { computed, useId } from 'vue';
import '../themes/default/swatch.css';
import '../themes/ide/swatch.css';
import '../themes/glass/swatch.css';
import '../themes/retro/swatch.css';
import '../themes/paper/swatch.css';
import { interfaceStyles, type InterfaceStyle, type AppearanceMode } from '../themes/registry';
const props = defineProps<{ locale?: 'zh' | 'en'; interfaceStyle: InterfaceStyle; themeMode: AppearanceMode }>();
const english = computed(() => props.locale === 'en');
const appearanceId = useId();
const modeLabelId = `${appearanceId}-mode`;
const styleLabelId = `${appearanceId}-style`;
const modes = [{ id: 'light', zh: '浅色', en: 'Light' }, { id: 'dark', zh: '深色', en: 'Dark' }] as const;
defineEmits<{ 'update:interfaceStyle': [value: InterfaceStyle]; 'update:themeMode': [value: AppearanceMode] }>();
</script>
<style scoped>
.appearance-settings { display: grid; gap: 20px; margin-bottom: 20px; }
.appearance-settings-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.appearance-style-section { display: grid; gap: 12px; }
.appearance-style-list { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.appearance-style-card { display: flex; flex-direction: column; gap: 7px; text-align: left; padding: 10px; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-bg-color); color: var(--el-text-color-primary); font: inherit; cursor: pointer; }
.appearance-style-card[aria-pressed="true"] { border-color: var(--el-color-primary); box-shadow: inset 0 0 0 1px var(--el-color-primary); }
.appearance-style-card:hover { background: var(--el-fill-color-light); }
.appearance-style-card:focus-visible, .appearance-mode button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.appearance-style-name { font-size: 13px; font-weight: 600; }
.appearance-style-description { font-size: 11px; line-height: 1.5; color: var(--el-text-color-secondary); }
.appearance-swatch { position: relative; height: 44px; display: flex; gap: 4px; align-items: flex-end; padding: 6px; box-sizing: border-box; overflow: hidden; }
.appearance-swatch i { width: 18px; height: 9px; flex: 0 0 auto; display: block; }
.appearance-mode { display: flex; gap: 4px; }.appearance-mode button { padding: 4px 10px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-bg-color); color: var(--el-text-color-primary); font: inherit; }
.appearance-mode button[aria-pressed="true"] { color: var(--el-color-primary); border-color: var(--el-color-primary); background: var(--el-fill-color-light); }
@media (max-width: 700px) { .appearance-style-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
