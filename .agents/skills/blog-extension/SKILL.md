---
name: blog-extension
description: 开发 JSON 浏览器扩展、修复扩展行为、同步网页 JSON 能力或验证扩展安装包；不用于仅修改网站或提交商店发布。
---

# JSON 浏览器扩展开发

源码路径相对于本扩展仓库。先确认任务是扩展专用修复，还是用户要求与网页工具同步的能力；两端的应用外壳和数据流不同。

## 修改边界

- 入口是 src/App.vue、src/components/JsonToolWorkbench.vue；JSON 引擎、composables 与 Workers 位于 src/components 下。
- 对照源码对照说明.md 与当前文件差异。它是映射线索，不是自动同步脚本；按语义比较目标模块，不从网页整文件覆盖扩展。
- 扩展是独立本地工具。保留 scripts/check-local-only.mjs 检查的无博客 API、无远程功能、无 host permissions/content scripts 以及本地 CSP；共享代码不应带入 Nuxt runtime、分享、远程获取或风控接口。
- 解析、格式化、数字字面量和转义等语义与已约定的网页能力保持兼容。行为变更添加独立预期回归；不要用 JSON.parse/stringify 当作现有引擎的等价替换。
- 保持 Worker 取消/过期响应隔离、Monaco 与事件资源清理、本地设置/存档兼容。大型文本避免无谓复制或每次键入全文扫描。
- package.json、public/manifest.json 及打包元信息只在版本任务需要时共同修改，不因代码修复自行升版或提交商店。

## 验证

- 使用 npm test，测试注册器和并发设置由项目脚本管理；选测时保留 scripts/register-typescript-tests.mjs 的加载方式。
- 使用 npm run build，覆盖类型检查、Vite 与本地处理约束检查。UI/Worker 改动在真实扩展标签页验证导入、操作、再次提交、取消和关闭。
- 只有需要安装包时运行 npm run package，再 npm run verify-package。源码变更后旧 ZIP 的成功记录无效。
- 加载已构建扩展检查入口、语言、设置/存档和受影响流程；大文件结论记录真实浏览器及文件规模，不以 Node 基准替代。
- 包装目录和跨端核对见 [扩展验证](references/parity-and-package.md)。

报告修改模块、同步范围、测试/构建与实际安装验证。外部发布按用户任务授权处理，不因本 Skill 获得发布权限。
