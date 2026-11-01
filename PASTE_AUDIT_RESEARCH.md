# Lighthouse 粘贴告警调研

调研日期：2026-11-01。范围：本仓库的 Monaco Editor 0.52.2 与 Lighthouse 13.6.0 `paste-preventing-inputs` 检查。仅核对代码和官方资料；本调研没有修改运行时代码、依赖、构建配置或已有未提交改动，没有提交或推送。

## 结论

当前没有足够证据支持“完整消除此告警，同时保持现有输入机制且没有回归风险”的修复。建议保留 Monaco 原生粘贴链路，并将这一项记录为自动检查与复杂编辑器实现不匹配的例外；这不是“插件不允许用户粘贴”的证据。

只读预览区可以单独研究公开选项 `domReadOnly`，使原生 DOM 的只读属性与实际只读行为一致。但它不能解决可编辑输入区的告警，也不能单独把该二元检查变为通过。本轮不为了减少报告行数启用该选项；若以后作为只读语义改进实施，应验证复制、选择、查找、键盘导航、辅助技术以及只读／可编辑切换。

以上结论综合了检查器与编辑器源码，以及当前实现的小样本浏览器验证；不声称已证明所有浏览器、所有输入法或百万行粘贴的行为。

## 实际检测的是什么

Lighthouse 获取页面里的 `textarea`、`input`、`select`，对于原生 `readOnly` 不为真的元素，派发一个可取消的合成 `paste` 事件，并将事件是否被取消写入 `preventsPaste`。这一事件没有提供实际剪贴板正文。随后，审计只检查 `preventsPaste`，并不会读取 Monaco 模型，确认用户文本是否真的插入成功。因此，此检查能识别普通表单中禁用粘贴的处理器，但不能仅凭该结果区分“阻止粘贴”和“接管浏览器默认粘贴后交由编辑器模型处理”。

证据：[本机 Lighthouse 13.6 Inputs gatherer](/Users/binary/.npm/_npx/ba16b138af87a83e/node_modules/lighthouse/core/gather/gatherers/inputs.js:65)、[本机审计实现](/Users/binary/.npm/_npx/ba16b138af87a83e/node_modules/lighthouse/core/audits/dobetterweb/paste-preventing-inputs.js:43)。官方说明也将这一检查描述为观察粘贴事件是否被自定义处理器阻止：[Chrome 的检查说明](https://developer.chrome.com/docs/lighthouse/best-practices/paste-preventing-inputs/)。

## Monaco 0.52.2 的实际输入链路

本机安装源码显示：`TextAreaInput` 收到 `paste` 后先取消浏览器默认行为，再读取 `clipboardData`。没有剪贴板数据时返回；有数据时读取正文与附带元信息，并发出编辑器自己的粘贴事件。`TextAreaHandler` 接收该事件后，把文本、整行粘贴标记、多光标元信息和来源模式交给 `ViewController.paste`。本项目的 `inputEditor.onDidPaste` 是粘贴后的缩进同步，没有在该回调中禁止粘贴。

这解释了为什么审计中的空合成事件会被取消，而正常用户粘贴仍可由编辑器处理。Monaco 将文本与编辑历史保存在模型中，DOM 输入代理并不是整个文档的原生文本框；官方 README 也说明了模型与编辑器视图的区别。

证据：[TextAreaInput](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/node_modules/monaco-editor/esm/vs/editor/browser/controller/textAreaInput.js:280)、[TextAreaHandler](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/node_modules/monaco-editor/esm/vs/editor/browser/controller/textAreaHandler.js:247)、[项目粘贴后回调](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/src/components/JsonToolWorkbench.vue:2931)、[官方模型与视图说明](https://github.com/microsoft/monaco-editor/blob/main/README.md#models)。

## 方案比较

| 方案 | 对当前机制的影响 | 判断 |
| --- | --- | --- |
| 删除或跳过 Monaco 原生 `preventDefault` | 浏览器默认粘贴与模型粘贴会形成不同的输入路径，改变代理 textarea、事件及选区处理关系；可能涉及重复输入、撤销分组、整行／多光标粘贴等。具体故障形态没有在本轮打补丁验证 | 不满足保持现有机制的要求 |
| 将空 `clipboardData` 检查提前到 `preventDefault` 之前 | 可避免取消无剪贴板正文的合成事件；常规有效粘贴路径有可能保持一致，但会修改第三方内部事件语义。本轮没有实现或验证这个补丁，也没有证据证明对所有集成方式无影响 | 可讨论为上游事件处理改进；本轮不将其当作已验证的产品修复 |
| 对 `isTrusted` 或 Lighthouse 环境设置特别分支 | 让审计和真实用户走不同路径，并未证明真实剪贴板功能有所改善；也会改变自动化事件行为 | 不作为产品修复采用 |
| 把所有 textarea 标成只读、隐藏或从检查中移走 | 可编辑输入区会失去准确语义或正常输入／辅助技术行为 | 不采用 |
| 仅给真正只读的预览使用 `domReadOnly` | 是公开 API，可使 DOM 只读属性与编辑器状态一致；但改变了原生文本框行为，仍需独立验证；输入区继续触发告警 | 可作为以后独立语义改进候选，不能宣称完整解决 |
| 升级并启用 EditContext | 当前 0.52.2 没有该输入通道配置；需要版本升级和项目构建适配。它改变输入机制且存在浏览器／输入法／剪贴板兼容性验证工作 | 不为本次提分直接迁移 |
| 保持编辑器，记录审计例外 | 保留既有模型、粘贴、撤销与大文件路径 | 本轮建议 |

表格中的风险属于源码推断与兼容性评估，不是本轮已复现的具体用户故障；没有为了研究而把上述高风险补丁写入工程。

## `domReadOnly` 的边界

该选项从 Monaco 0.24 已公开存在，0.52.2 的 `monaco.d.ts` 也包含它。默认值为 false，与控制模型编辑权限的 `readOnly` 不同。当前安装版 `TextAreaHandler._ensureReadOnlyAttribute` 在 `domReadOnly` 与 `readOnly` 同时为真时，为输入代理写入原生 `readonly`；该函数也用于通过只读属性禁止 IME composition。因此，它不是一个对浏览器行为完全没有影响的报告开关。

Lighthouse 会跳过原生只读字段，故给预览区正确表达只读状态可以减少该区的误报；可编辑输入区仍会被检查，而审计是“存在任一被取消的字段则失败”，所以分数不因此恢复。

证据：[当前公开类型](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/node_modules/monaco-editor/monaco.d.ts:3213)、[只读属性实现](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/node_modules/monaco-editor/esm/vs/editor/browser/controller/textAreaHandler.js:572)、[官方历史变更](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md#0240-12052021)。

## 升级与 EditContext 不能当作已验证的低风险修复

官方 changelog 将 Edit Context Support 列为 0.53.0 的新增功能；当前 0.52.2 类型和安装源码中没有可直接启用的 EditContext 选项。后续 0.55.0 调整了语言命名空间，0.56.0 重组了 ESM 入口。这些变化需要迁移核对，不能只改版本号就保证与当前自定义集成兼容。[官方 changelog](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md)

微软自己的 vscode-documentdb 项目曾记录：从 0.54.0 降回 0.52.2 以修复键盘粘贴回归，并单独追踪后续升级。这个案例证明相关版本曾出现输入兼容性回归，不能据此推断最新版本仍然存在相同问题，也不能推断升级一定消除 Lighthouse 的这一审计。[微软项目的升级任务与回归记录](https://github.com/microsoft/vscode-documentdb/issues/469)

本项目另有对特定 Monaco 源文件进行指纹检查和转换的构建适配，以及大文件折叠扩展。源码升级会涉及这些适配重新审查；官方也只把 `monaco.d.ts` 声明为版本化公共 API，其他内部结构可能随版本变化。[本地构建适配](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/scripts/vite/monaco-single-editor.mjs:3)、[大文件折叠适配](/Users/binary/Desktop/博客网站/blogWebsite/json-toolbox/scripts/vite/monaco-large-folding.mjs:1)、[官方支持边界](https://github.com/microsoft/monaco-editor/blob/main/README.md#installing)。

## 验证范围和后续门槛

本调研代理完成本机安装源码核对与官方资料研究，没有修改运行时代码或进行升级，没有新建服务或操作 4179 预览。主任务另在现有预览的编辑器中执行了以下真实浏览器检查，结果文件已核对：

| 现有实现的检查 | 观察结果 |
| --- | --- |
| 原生粘贴含中文与 emoji 的 JSON | 编辑器得到 `{"text":"中文🙂","n":1}` |
| 撤销该次粘贴 | 恢复为空 |
| 重做该次粘贴 | 恢复相同 JSON |
| 选中内容后粘贴替换 | 得到 `{"replacement":true}` |
| 撤销替换 | 恢复此前的 JSON |
| 用真实鼠标 Alt+点击建立双光标，在两行 `foo` 后粘贴 `X` | 两行都变为 `fooX` |
| 单次撤销双光标粘贴 | 两行都恢复 `foo` |

证据：[主任务浏览器检查记录](/Users/binary/Documents/ChatGPT/博客网站/Monaco粘贴告警调研-2026-11-01/current-paste-checks.json)。这些检查证明当前实现中上述粘贴路径可以工作；它们没有测试任何修复补丁，也不代表中文输入法组合输入、大文件或百万行粘贴验证。中文字符来自剪贴板，不能据此声称 IME 已通过。

若以后单独迁移 Monaco／输入通道，应覆盖普通粘贴、替换选区、连续撤销重做、整行复制粘贴、多光标元信息、右键与键盘粘贴、中文 IME、只读预览的复制与查找、模式和语言切换，以及具有明确文件规模的真实浏览器大文本粘贴。小样本成功不能代替这组验证。
