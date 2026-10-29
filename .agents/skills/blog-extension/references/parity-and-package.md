# 跨端核对与安装包

## 对照范围

网页入口是同级 portal-web 的 components/JsonTool，扩展入口是本仓库 src/components。
对照 i18n、jsonEngine、Workers、largeEditor 工具、Diff 和转换功能时保留两端各自的 import、生命周期和可用功能。先定位实际同级工程；如果未检出网页工程，说明缺少跨端对照而继续能独立完成的扩展检查。

新增能力如仅获授权修改一个端，完成这一端并指出另一端是否受影响，不擅自扩展提交范围。
不移入网页的 SSR、API 代理、Nuxt 自动导入和在线分享/获取；不为同步解除本地 CSP 或增添无关权限。

## 测试与产物

- npm test 调用项目自有 TypeScript 测试注册器。定向命令示例：
    node --import ./scripts/register-typescript-tests.mjs --test --test-concurrency=2 tests/jsonFormatting.test.mjs
- npm run build 自带类型检查与 scripts/check-local-only.mjs。
- npm run package 先构建，scripts/package.mjs 产生 release/ 下的版本 ZIP 和构建信息。
- npm run verify-package 根据当前源码摘要、manifest 版本、ZIP 字节数和 SHA-256 验证产物；修改源码后应重打包再验证，不改构建信息来迎合旧 ZIP。
- 手工加载 dist/ 或解压后的包，而非包含构建目录的外层项目文件夹。确认 Chrome 没有扩展加载错误、入口能打开、Workers 可用。
- store/ 中的说明、截图或安装包更新仅在用户发布/资料任务需要时进行；本地打包成功不等于商店发布成功。
