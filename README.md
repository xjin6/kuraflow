# 倉流 KURAFLOW

中央厨房与门店协作系统，包含平台开户、厨房管理、门店订货、商品与采购成本、订单配货配送及月结统计。

前端使用原生 JavaScript / CSS，后端使用 Cloudflare Workers、D1 和 KV。平台、厨房与门店通过服务端校验身份与数据范围。

## 本地运行

使用 Node.js 22 或更新版本：

```sh
git clone https://github.com/xjin6/kuraflow.git
cd kuraflow
npm ci
npm run setup:local
npm run dev:accounts
```

打开 <http://localhost:8787/local-setup> 进入本地平台登录页。首次启动生成的开发平台密钥保存在本机 `private-preview/platform-key.txt`，在该登录页使用；厨房和门店账号由平台、厨房分别开通。

`setup:local` 仅在 `business-data.js` 不存在时创建空数据模块，不覆盖已有文件。账号预览使用本地 D1 / KV，数据保存在 `private-preview/`，不连接正式数据库，也不导入真实业务记录。

保有本地业务资料时，可用 `npm start` 打开 <http://127.0.0.1:4173/> 的静态业务预览。该预览使用浏览器 localStorage，与 8787 的账号预览数据独立。

## 检查与构建

```sh
npm run test:frontend
npm run test:backend
npm run build:cloud
```

正式前端构建使用 `cloud-seed.js` 的空数据定义，登录后从授权 API 加载业务数据。构建不需要本地真实资料。

`npm test` 是早期业务模型回归，依赖本机 `business-data.js` 中的历史资料样本；这些样本不随公开仓库提供。前端和后端测试可在运行 `setup:local` 后使用空数据模块执行。

## 目录

- `app.js`、各业务 UI 模块与 CSS：业务页面、共享控件和样式。
- `cloud-bootstrap.js`、`cloud-client.js`：云端登录、启动和 API 客户端。
- `platform-app.js`、`accounts-ui.js`：平台与账号管理。
- `backend/`：Worker、身份校验、业务存储、数据库迁移及测试。
- `frontend/`：前端 DOM 回归测试。
- `public/`：运行所需字体、图标、商品图片及浏览器依赖。
- `scripts/`：本地开发、构建和维护脚本。
- `docs/`：产品规则、实现说明与部署记录。

## 公开仓库范围

仓库保存程序、测试、必要静态资源和技术文档。以下内容由 `.gitignore` 排除，仅留在本机：

- 环境变量、密钥、会话、数据库文件和 `private-deploy/`、`private-preview/`。
- 含真实报价、成本、门店资料与账单的 `business-data.js`、`materials/`、`materials-derived/`。
- 依赖目录、构建产物、临时文件、备份、历史设计试稿、预览截图及导出文件。

当前部署状态见 [云端发布记录](docs/cloud-deployment-status.md)，账号规则见 [三端登录与管理员账号](docs/master-auth-release-2026-10-16.md)。`wrangler.jsonc` 记录既有资源绑定；部署到其他账号时须配置对应的 Worker、D1 与 KV。
