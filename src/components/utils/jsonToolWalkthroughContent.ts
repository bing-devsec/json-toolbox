export interface WalkthroughTopic {
    id: string;
    title: string;
    description: string;
    actionLabel: string;
    success?: string;
    action: 'settings' | 'format' | 'extract' | 'floating';
    target: string;
    settingsSection?: string;
}

type Translation = readonly [zh: string, en: string];
type TopicDefinition = Omit<WalkthroughTopic, 'title' | 'description' | 'actionLabel' | 'success'> & {
    title: Translation;
    description: Translation;
    actionLabel: Translation;
    success?: Translation;
};

const topics: readonly TopicDefinition[] = [
    {
        id: 'settings-editor', action: 'settings', settingsSection: 'editor',
        target: '.settings-dialog-content [data-guide-section="editor"]',
        title: ['编辑器设置', 'Editor settings'],
        description: ['字号和换行改善阅读体验；粘性滚动会把父级字段固定在顶部，方便查看嵌套结构。', 'Text size and wrap improve readability. Sticky Scroll keeps parent fields at the top while you explore nested data.'],
        actionLabel: ['查看编辑器设置', 'View editor settings'],
    },
    {
        id: 'settings-format', action: 'settings', settingsSection: 'format',
        target: '.settings-dialog-content [data-guide-section="format"]',
        title: ['格式化设置', 'Formatting settings'],
        description: ['缩进和数组换行决定输出样式；JSON 修复用于尝试处理无法直接解析的内容。', 'Indentation and array wrapping control the output. JSON Repair can attempt to fix content that cannot be parsed.'],
        actionLabel: ['查看格式化设置', 'View formatting settings'],
    },
    {
        id: 'tool-format', action: 'format', target: '[data-guide-tool="format"]',
        title: ['格式化、折叠与转移', 'Format, fold and transfer'],
        description: ['先格式化到预览区，再按第 2 层折叠，最后用内容转移把结果和折叠状态一起带回编辑区。', 'Format into the preview, fold at level 2, then transfer the result and its folded state back to the input.'],
        actionLabel: ['执行格式化', 'Run formatting'],
        success: ['结果已转移到编辑区，第 2 层的折叠状态也已保留，预览区已清空。', 'The result is now in the input with its level 2 folds preserved. The preview is empty.'],
    },
    {
        id: 'context-extract', action: 'extract', target: '.editor-panel-input',
        title: ['按 Key 提取 Value', 'Extract values by key'],
        description: ['右键菜单中的“按 key 提取 value”能递归查找同名字段。这个示例按 name 提取三个名字，结果汇总到预览区。', 'The context menu’s Extract Values by Key action searches nested data for matching fields. This example extracts three name values into the preview.'],
        actionLabel: ['提取 name 的值', 'Extract name values'],
        success: ['三个 name 值已提取到预览区。', 'The three name values are now in the preview.'],
    },
    {
        id: 'help-floating', action: 'floating', target: '.floating-actions',
        title: ['问题反馈与浏览器扩展', 'Feedback and browser extension'],
        description: ['网页边缘的悬浮入口可以拖动贴边。点击展开后，可反馈问题与建议，或打开浏览器扩展页面。', 'Drag the floating control to either edge of the page. Click it to send feedback or open the browser extension page.'],
        actionLabel: ['展开悬浮入口', 'Show the floating control'],
        success: ['已展开，可查看“问题与建议”和“浏览器扩展”。', 'The Feedback and Browser extension entries are now visible.'],
    },
];

export function getWalkthroughTopics(locale: 'zh' | 'en', extension: boolean): WalkthroughTopic[] {
    const index = locale === 'en' ? 1 : 0;
    return topics.filter(topic => !extension || topic.id !== 'help-floating').map(topic => {
        const { title, description, actionLabel, success, ...metadata } = topic;
        return {
            ...metadata,
            title: title[index],
            description: description[index],
            actionLabel: actionLabel[index],
            ...(success ? { success: success[index] } : {}),
        };
    });
}
