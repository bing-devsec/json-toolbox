# Extension appearance architecture

Only the browser extension uses these modules. Do not copy the blog application shell into this project.

- `interfaceThemes.ts`: ordered style catalog, validated persisted IDs, and light/dark palettes. The `default` style returns no overrides, preserving the original Element Plus appearance.
- `useInterfaceTheme.ts`: reactive CSS-variable application to the workbench and body, including teleported menus/dialogs. Restores its owned variables on unmount. Does not read JSON, recreate editors or change font metrics.
- `interfaceThemes.css`: shared Element Plus/workbench adaptation followed by material-specific rules. Scope every rule to a non-default style. Glass effects stay on stationary controls; editor backgrounds remain solid.
- `AppearanceSettings.vue`: localized, keyboard-accessible selection UI. Both appearance dimensions use the existing settings persistence; older/invalid style records fall back to `default`.
- `monacoThemes.ts`: registers all palette/language variants once. Resolves the window-scoped style for normal editors, Diff editors and later language activation, preserving TOML token rules. Switching uses Monaco's theme API and preserves models and undo history.

To add a style, extend the catalog and palettes, add material rules/preview swatch, then validate settings compatibility, both color modes, teleported controls, editor/Diff language activation and real browser interaction. No new dependencies or extension permissions are required.

## 温润纸感：颜色与交互规范

纸感的浅色和深色分别设计。`paperTokens.ts` 是按钮颜色的唯一来源；`paperControls.css` 只引用语义变量，不新增颜色字面量。旧深色组件覆盖不再作用于纸感，避免另一套蓝灰色覆盖此合同。其他主题仍沿用原有材质，后续逐个完善。

### 操作层级

| 类型 | 使用位置 | 浅色背景 / 前景 | 深色背景 / 前景 |
| --- | --- | --- | --- |
| primary | 格式化、对话框主要确认 | `#805735` / `#FFFCF4` | `#D7B88C` / `#292720` |
| secondary | 压缩、转义、转换、转移到输入、上传 | `#FAF7EF` / `#805735` | `#302D27` / `#D7B88C` |
| neutral | 设置、复制、下载、普通导航 | `#FAF7EF` / `#3D3931` | `#302D27` / `#E9E0CF` |
| danger | 清空、删除 | `#FAF7EF` / `#963C30` | `#302D27` / `#F2B1A2` |

- 每个类型均定义默认、hover、active 三组背景／前景／边框；disabled 使用独立中性色，不通过 opacity 把整颗按钮和图标一起冲淡。具体数值见类型化 tokens，不在组件中重新选择颜色。
- SVG 使用 `currentColor` 并继承按钮前景；焦点统一为主题强调色的 2px outline。转移按钮属于 secondary，不因 Element Plus 的 primary 类型误用实色填充。
- 成功和警告的颜色仅用于对应反馈；复制成功之前，复制按钮本身仍是中性辅助操作。
- 单选、复选、开关、下拉选中态使用同一强调色与选中表面。深色不沿用原来的固定蓝色。
- 可用状态文字与按钮背景的对比度测试目标为 4.5:1；默认按钮边界、焦点与表面对比度目标为 3:1。禁用状态由专用 tokens 管理，不作为可用状态对比度结论。
- JSON 语法高亮、Diff 新增／删除、错误提示继续表达数据语义，不统一涂成棕色。

### 五种风格共用的结构

顶部只由 `.tool-bar-wrapper` 绘制一条 1px 分隔线；内层 `.tool-bar` 无边框、无投影。所有风格使用相同内边距和高度，不再由 IDE 添加 2px 彩边或由玻璃额外包一层 padding。材质仅控制表面颜色和纹理。


### 组合控件与设置入口

- 纸感的层级选择和折叠按钮作为一个 group：统一 32px 外框、同底色、同强调色，子控件不再绘制独立边框或 inset shadow；内部使用 1px 宽、上下各留 7px 的低对比短分隔线，沿用明暗主题语义色并降低禁用状态的存在感；鼠标聚焦不绘制外围光圈；键盘导航保留下拉选项高亮与按钮焦点提示。折叠色由 paperTokens.ts 中 `--paper-fold-*` 定义，默认 Element Plus 的绿色控件保持其原有语义。
- 按钮组嵌套下拉按钮必须明确设置 divider token，不沿用实色按钮组的白色分界。
- 纸感设置面板头尾无额外边框；分区关系由标题、间距和手风琴边界表达。
- 插件不再渲染悬浮语言／主题面板，已删除专用组件、位置计算及测试。语言入口位于通用设置，继续由 App.vue 持有和保存 locale；SettingsDialog 仅发送事件，不复制持久化逻辑。主题和明暗模式继续位于外观设置。

### 设置面板信息架构

主题设置（theme）、通用设置（settings）、编辑器设置（editor）、格式化（format）、去除转义（unescape）、排序（sort）、存档（archive）七个分区共用一个 accordion。

- 通用：语言、JSON 响应自动打开、工具栏功能可见性。编辑器：字号、语法检查、换行、同步／粘性滚动、缩略图。缩进归入格式化。
- 首次打开全部收起；当前会话重新打开保留上次分区，Diff 隐藏不适用的分区并清理无效展开项。
- settingsLayout.css 只管理弹窗布局、分区间距和滚动，不定义主题颜色。settingsSections.ts 管理新增分区文案，设置值和编辑器副作用仍由原 composables 管理。
- 保留原有双列卡片（窄屏单列），卡片内标题／控件同排、说明在下。固定页头页尾，内容区域滚动；主题收起时显示当前选择。

### 纸感深色编辑器分区

行号区使用调色板的 gutter 色，与正文背景区分；Monaco 注册色与 CSS 覆盖共用同一来源。右侧以 inset 1px 分隔线划分区域，不改变行号、折叠箭头的宽度及点击范围。输入、预览与 Diff 编辑器沿用同一规则。

Diff 中间同步面板的背景、两侧边线和同步箭头由 interfaceThemes.ts 的调色板变量统一提供，不能只适配顶部导航。自定义主题的这些变量覆盖组件原有默认值；默认 Element Plus 继续使用原来的配色。

### 排序弹窗与演示引导

排序方向卡片、字段标签、Popover 的头尾及内部参数卡片均使用现有 surface/text/border 语义色。纸感主题不叠加旧的黑灰色演示覆盖。参数值使用选中背景与强调色，步骤圆点及目标脉冲描边也跟随强调色。SortDemoStep 显式声明主要按钮 type，执行、继续及完成操作使用 primary；上一步、重试保留 secondary 层级，不比较回调函数身份决定样式。

## 专业 IDE：中性工作区与控件语义

- ideTokens.ts 提供明暗基础调色板和普通、主要、危险、禁用等控件角色；ideControls.css 只消费变量，保持现有编辑布局和模型生命周期。参考 [VS Code Dark Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json) 与 [Light Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/light_modern.json) 的中性工作区分区和按钮配色，根据本工具的可读性要求调整边界。不是两个 IDE 的整套界面复刻。
- 深色为石墨灰工作区与近黑编辑区；浅色为白色编辑区、浅灰外壳。普通工具按钮中性化，格式化和对话框确认使用主要蓝色，清空/删除使用危险前景色。蓝色不铺满工具栏和面板。
- 文字强调色与实心按钮蓝色分开：深色链接/说明标题使用更亮的蓝色，主要按钮使用深蓝＋白字；选中菜单使用独立的 onSelected，保证对比度。当前行背景和文本选区也分开，不把列表选中色直接铺在当前行上。
- interfaceStyles 声明 controlSystem，由 useInterfaceTheme 在 body 上同步 data-theme-controls。已实现语义适配的 IDE 和纸感不再叠加旧暗色覆盖；默认、玻璃、复古继续走原有路径。卸载时恢复该属性，与颜色变量一起清理。新增语义主题只更新注册信息，避免每条旧 CSS 继续追加主题名字排除条件。
- 验收按临时主题清单覆盖按钮组、折叠组合、设置卡片、脱敏字段候选/帮助说明、排序弹窗/演示与 Diff 中间同步区；模式切换和主题切回也要核查。
