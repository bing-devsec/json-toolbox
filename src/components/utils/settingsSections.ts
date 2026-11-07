/** Settings navigation copy lives separately from preferences and editor effects. */
export const settingsSectionCopy = {
    zh: {
        theme: { title: '界面设置' },
        browser: { title: '浏览器集成' },
        editor: { title: '编辑器设置' },
        language: '界面语言',
        languageDescription: '选择插件的显示语言，切换后自动保存。',
    },
    en: {
        theme: { title: 'Interface' },
        browser: { title: 'Browser integration' },
        editor: { title: 'Editor settings' },
        language: 'Interface language',
        languageDescription: 'Choose the display language. Your choice is saved automatically.',
    },
} as const;
