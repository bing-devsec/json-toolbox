# Monaco 图标：按需 SVG

扩展使用与 json-web 相同的 52 个 SVG mask，覆盖当前审查的 80 个图标标识。JetBrains Mono 用于编辑器文字，SVG 用于折叠、查找替换、菜单等 Monaco 图标。

图形来自 Monaco 0.52.2 的 Codicon TTF；原始字体 SHA-256 为 `0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9`。SVG 保留轮廓坐标和 advance，不保留字体 hint。MIT 许可证保存在 `assets/fonts/LICENSE.codicon.txt`，并通过 `public/fonts/LICENSE.codicon.txt` 随扩展安装包提供。

`vite.config.ts` 使用 `monacoSvgPlugin()`，适配基础图标、动态别名、菜单独立样式、Shadow DOM 菜单及 inlineProgress 取消图标；高对比度模式继承系统调整后的前景。生产构建拒绝输出 Codicon 字体资源。

`reports/monaco-svg-scope.json` 按扩展的 `src/components` 入口生成，核对 626 个依赖文件及应用动态入口。新增 Monaco 功能或升级依赖时，需要重新审查模块及图标范围，不能直接复制网页的路径和文件摘要。

只读生成依赖清单：

```sh
node scripts/collect-monaco-icon-scope.mjs .
```

维护 SVG 时使用 Python fonttools==4.65.0；普通构建不依赖 Python。`python3 scripts/convert-monaco-svg.py` 校验现有 SVG，追加 `--write` 才重新生成。

变更后运行 `npm test`、`npm run build`，在真实扩展页检查编辑、预览、Diff、折叠、查找替换、跳转行、右键菜单以及明暗和高对比度模式。新安装包运行 `npm run verify-package`。
