# 仓库结构

根目录保留 `index.html`、`package.json`、锁文件、`wrangler.jsonc`、`README.md`、`AGENTS.md` 和忽略规则。业务源码、样式、测试和工具按职责归档。

| 目录 | 用途 |
| --- | --- |
| `src/app/` | 管理端／门店端入口、平台端入口、登录启动和云端客户端 |
| `src/features/` | 按 accounts、catalogue、stores、tasks、overview、settlement、notifications、flow 分组的界面模块 |
| `src/shared/` | 前后端共用的业务模型、数量单位、日期／金额、通知和 Flow 数据逻辑 |
| `src/ui/` | 下拉／日历、动效、头像编辑、目录卡片、品牌组件 |
| `src/styles/` | 共享及功能样式；构建保持原来的 CSS 加载顺序 |
| `backend/` | Worker、账号与权限、业务存储、AI 服务；SQL 迁移继续位于 `backend/migrations/` |
| `tests/frontend/` | 前端 DOM 回归 |
| `tests/backend/` | 后端权限、存储、账号和业务回归 |
| `tests/flow/` | 本地 Copilot／Flow 服务回归 |
| `tests/fixtures/` | 测试专用素材；`tests/model.test.mjs` 为业务模型回归 |
| `scripts/build/` | 正式前端构建、PDF 引擎和字体构建 |
| `scripts/dev/` | 4173 静态演示、8787 账号开发服务、手机预览、一键登录与空种子设置 |
| `scripts/flow/` | 本地 Copilot SDK、连接、会话归档及运行桥接 |
| `scripts/lib/` | 工具共用路径配置 |
| `scripts/legacy/` | 旧 Safari／Dashboard 发布及手动检查脚本，只在明确需要时运行；其中 `qa/` 为历史浏览器检查 |
| `public/` | 对外字体、品牌、图片与 vendor 资源；根 favicon 和 Flow 图标源文件在 `public/icons/` |
| `docs/` | 产品和维护文档 |
| `design/` | 已确认的设计素材，保持现有素材包约定 |
| `private-preview/` | 私有本地数据、预览、资料与历史临时产物，Git 忽略 |
| `private-deploy/` | 私有发布工具、备份与可恢复的历史发布快照，Git 忽略 |

## 启动与构建

从项目根目录运行，命令名称和端口不变：

```sh
npm run setup:local
npm start
npm run dev:accounts
npm run build:cloud
npm test
npm run test:frontend
npm run test:backend
npm run test:flow
```

`test:flow` 包含本地 Flow runtime 测试。历史手动检查脚本不在这些自动测试命令里；不要批量执行 `scripts/legacy/`，其中包含真实发布和迁移操作。

`dist-cloud/` 和 `dist-worker/` 保留为生成目录，`.wrangler/` 保留本地 Wrangler 状态。已有账号开发数据仍位于 `private-preview/accounts-runtime/`，密钥位置和业务 localStorage 键没有变化。

## 静态 URL 与私有数据

磁盘源码路径和浏览器公开 URL 分开维护。`scripts/lib/project-paths.mjs` 声明原根文件名与现有源码路径的对应关系。4173 旧模块 URL 会重定向到新的源码 URL，让 ES module 的相对引用从正确目录解析；CSS、品牌、商品图片、PDF 引擎和字体的公开 URL 保持原样。生产页面仍使用构建后的资源，不公开源码目录。

本地真实种子保存于 `private-preview/data/business-data.js`，共用代码通过 `src/shared/business-data.js` 边界模块读取。生产构建将这个边界替换为 `src/shared/cloud-seed.js`；前端构建还检查依赖图，避免私有种子进入公开包。`setup:local` 仅在种子不存在时创建空数据，不覆盖已有文件。

原根目录 `materials/`、`materials-derived/` 已移入 `private-preview/`；原 `tmp/`、`output/` 和根预览截图放入 `private-preview/archive/`。文件保留，未清理业务资料。原 `materials/...` 本地演示 URL 继续使用明确的文件白名单。

## 维护约定

- 新功能放入对应 `src/features/<功能>/`；真正跨功能的纯业务逻辑放入 `src/shared/`，通用界面组件放入 `src/ui/`。
- 新 CSS 放入 `src/styles/` 并沿用现有加载顺序；新增公开 URL 时同步构建与本地服务映射。
- 数据库迁移和生产资源绑定保留在原位置，不因源码重组而修改账号、数据库或密钥。
- 历史发布快照保持冻结状态，历史文档里的路径代表当时版本。当前源码位置以本文件和路径配置为准。
- 目录整理的移动映射及整理前源码快照保存在本地 `private-preview/reorganization/`，供恢复与核对。
