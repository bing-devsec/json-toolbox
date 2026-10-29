# JSON 浏览器扩展开发入口

本仓库是独立本地 JSON 扩展。按当前 `package.json`、`public/manifest.json` 和源码确认版本与能力，保留已有工作区改动。

扩展开发、网页能力同步及安装包验证使用 [blog-extension](.agents/skills/blog-extension/SKILL.md)。

- 共享 JSON 语义不等于共享 Nuxt 应用外壳；对照同级 `portal-web` 的对应模块，按任务范围同步。
- 保留 `scripts/check-local-only.mjs` 的本地处理与 CSP 约束，不能顺带引入博客 API、远程权限或 content scripts。
- `npm test` 使用项目注册器；`npm run build` 包含类型检查、本地约束校验及构建元信息。
- 只有需要安装包时再运行 `npm run package`、`npm run verify-package`，以当前源码生成的新包为证据。
- UI、Worker 与性能变更需要对应真实扩展页面检查；普通文案不要求百万行测试。
- 开发任务不会自动授权版本发布、商店提交、Git 提交或推送。
