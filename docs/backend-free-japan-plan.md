# 倉流日本版后台与免费部署探索

核对日期：2026-10-09，日本时间。本文是探索结果，未创建云端资源、未修改 TokenX、未部署厨房业务数据，也未查询账号实时用量或费用。

## 结论与适用范围

建议第一阶段采用 Cloudflare Workers Free + Workers Static Assets + D1 Free。少量动态商品缩略图采用 Workers KV Free，并设置容量、尺寸与上传次数限制；现有静态照片随前端发布。严格 0 元阶段暂不启用按超量计费的 R2。

该配置能实现真实多人登录、门店专属报价、库存分配、下单、配货、配送和月结数据持久化，不需要购买 VPS，也不依赖电脑持续开机。它是免费额度内的真实试运行方案，不是无限门店、无限流量、无限历史数据的承诺。

如果需要明确选定日本主数据库，或者优先降低鉴权和复杂事务的开发工作量，应改选 Cloudflare 静态前端 + Supabase Free 东京项目。D1 的 apac location hint 不保证东京或日本境内。

## TokenX 实际架构

已阅读 TokenX 的配置、Worker/EdgeOne 源码、部署记录。目录没有 .git，历史证据来自保留文档，并非 Git 版本记录；文档记载的线上验收不是本次重新测试。

1. 初期：Cloudflare Worker API + D1 SQL + Secrets，通过 workers.dev 访问。
2. 为中国大陆访问补充：dynv6 免费子域名 → 腾讯 EdgeOne Makers 边缘转发 → 原 Worker → 原 D1。
3. 腾讯层只做受限转发，没有发现腾讯虚拟机或腾讯业务数据库，D1 仍是唯一业务来源。
4. 10 月 8 日另接入 Resend Free 邮件通知，Worker + D1 outbox + cron 负责发送与重试。

日本版没有现成证据需要增加大陆专用入口，先直接访问 Cloudflare，并用日本门店 Wi-Fi 和移动网络验收。

可参考部署方式、SQL migrations、Secrets、接口检查、审计与幂等。不复制 TokenX 的单一管理员 Bearer 密钥鉴权：厨房需要独立用户、门店和厨房公司权限。

厨房新建独立 Worker、D1、图片命名空间与密钥。复用 Cloudflare 账号时，部分免费额度在账号内共享，不因新增项目得到另一份额度；上线前核对 TokenX 与厨房合计用量。

TokenX 本地证据：
- [原始方案](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/docs/cloudflare-activation-plan.md)
- [docs/cloudflare-operations.md](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/docs/cloudflare-operations.md)
- [edgeone/README.md](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/edgeone/README.md)
- [edgeone/src/relay.mjs](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/edgeone/src/relay.mjs)
- [cloudflare/wrangler.jsonc](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/cloudflare/wrangler.jsonc)
- [cloudflare/src/worker.js](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/cloudflare/src/worker.js)
- [docs/support-email-notifications.md](/Users/xinjin/Library/CloudStorage/OneDrive-Xin/Vibe/tokenx/docs/support-email-notifications.md)

## 推荐组合与费用边界

| 部分 | 第一阶段选型 | 核对到的免费额度或边界 |
| --- | --- | --- |
| 网页文件与现有照片 | Workers Static Assets | 直接静态请求免费、不限量；不应让每个静态请求都先进入 Worker |
| 后台 API | Workers Free | 100,000 次请求/日；每次调用 CPU 10 ms |
| 商品、门店、单位、报价、订单、库存流水 | D1 Free | 5,000,000 行读取/日，100,000 行写入/日；每库 500 MB、账号合计 5 GB、最多 10 库 |
| 新上传商品缩略图 | Workers KV Free | 1 GB；100,000 次读取/日，1,000 次写入/日 |
| 短期恢复 | D1 Time Travel | 免费保留 7 天，另做独立导出和恢复演练 |
| 访问地址 | workers.dev 平台子域名 | 可先零域名费用试用；官方建议业务关键生产使用正式域名 |

KV 只承载小文件，不承载价格、库存、订单和登录会话的强一致状态。按不可变图片键保存，修改图片产生新键；KV 的跨地域缓存传播可能延迟。客户端压缩图片，服务端验证格式和大小，首期可以限定单图 200 KB、每商品一张、单租户总图片 100 MB，并清理替换后不用的图片。真实 PDF 及账单不作为公开静态资源发布。

R2 是更常规的文件存储，Standard 免费额度为 10 GB-month、每月 100 万 Class A 和 1000 万 Class B 操作、免出口带宽费。但它需要开通 R2 subscription，超出免费额度按量计费。不能把它说成“永远不收费”，预算告警也不等于硬停机。若未来接受免费额度内通常 0 元但保留超额风险，再考虑替换 KV。

Workers/D1/KV 保持 Free、没有另行启用收费产品时，免费限额耗尽主要表现为拒绝服务而非自动获得收费容量。D1 官方自 2026-09-01 起明确执行免费每日读写上限，超额到下次 UTC 00:00 前请求会失败（日本时间 09:00 重置），已存数据不因此删除。需要监控用量和预警，不能拿“不会自动付费”代替业务可用性。

## 后台怎样支持现有业务

浏览器 → Worker API（验证身份、公司和门店权限）→ D1（业务事实）。图片另外经图片接口存入 KV。

- 公司：平台租户；一个厨房公司拥有自己的商品、库存、客户门店与员工。
- 账号：厨房管理员、配货员、配送员、门店采购员。订单和报价请求都在服务端绑定 tenant_id/store_id。
- 商品与单位：一个商品统一的库存基准单位，多个可售卖单位及换算关系；数据用受控精度/整数缩放表达，避免浮点累计误差。
- 报价：按厨房、门店、商品、单位保存独立单价与税率。
- 下单：一张订单同一商品只能一种单位；服务端校验售价、单位、门店额度和可用库存，锁定单价、税率与换算关系。
- 并发：幂等提交 + 数据库约束/条件更新 + 事务批次；失败整单回滚。不能网页先读库存再分别提交几个写操作。
- 配货和配送：每次操作检查允许的状态转换与权限，并保留操作记录；多人操作不能靠浏览器 localStorage 合并。
- 历史单据：原始纳品书、请求书和今后的结算记录分别保存，不把演示状态当成历史事实。

D1 batch 是事务机制，但“UPDATE 影响 0 行”不自动等于 SQL 错误：库存不足时必须显式触发事务失败/约束拒绝或使用经过验证的原子写法，不能继续插入订单。免费每次 Worker 调用最多 50 个 D1 查询，现有样例有 42 行货品，必须批量处理，不能每行分别查价、扣库存、写订单和审计。要验证 42 行和更长订单的正常/并发失败路径。

认证采用成熟身份方案。纯 Cloudflare 方案可以评估 Passkey + 管理员发一次性入店凭据，以减少邮件/SMS依赖；如果采用账号密码，要先验证安全密码哈希与 Workers Free 10 ms CPU 的适配，不能通过降低密码保护来硬凑免费额度。Supabase Auth 是另一可选的免费身份实现，会引入第二个服务。正式选型前把登录、恢复账号与厨房共享设备的使用方式一起测试。

## 保住免费额度的实现方式

1. 只让 /api/* 与受控文件接口运行 Worker，静态文件走 Static Assets。
2. 订单、报价、库存查询按 tenant/store/date 建索引，按分页或增量取数。
3. 首期用页面可见时的低频增量刷新，避免每几秒全量查询。50 个标签页、每 5 秒刷新、每天 10 小时会产生 360,000 请求；每 60 秒则约 30,000 请求，尚未计其他 API。
4. 不启用不需要的付费套餐、R2、短信、收费图像转换或 AI；照片在浏览器压缩后上传。
5. 定期导出数据库和重要单据至用户指定位置，验证可恢复。7 天恢复窗口不等于长期业务归档。
6. 多租户在 schema 中预留，不用免费账户/数据库数量硬分出无限份额度。

示例量级：50 家店、每天合计 100 单、每单 40 行，新增明细 4,000 行/日。库存更新、门店额度、审计、索引以及配货修改也计算读写；不是“4,000 行就只收 4,000 次写”。需要用真实操作脚本读 D1 的 rows_read/rows_written 与 CPU 指标，得到容量结论。不能只凭门店数量承诺够用几年。

## 可替代方案：Supabase Free 东京

免费 PostgreSQL + Auth + RLS + Storage：500 MB 数据库/项目、1 GB 文件、50,000 月活、5 GB 普通出口加 5 GB 缓存出口（分开计量）、最多 2 个活跃免费项目。可明确选择 Tokyo/ap-northeast-1 的主项目数据位置。

优点：成熟登录、SQL 事务/行锁、数据库行级权限，订单系统开发和维护更省力。缺点：一周低活跃/不活跃可能暂停，Free 无自动备份、无 uptime SLA，图像出口额度更紧。官方成本文档确认 Free 不收费，但持续超量会被限制。

默认 Auth 发信只面向项目团队预授权地址，且仅 2 封/小时，不适合直接用来给餐厅发生产邀请或密码重置邮件。可由管理员创建门店账号，并设计首次改密和管理员恢复流程；邮件功能需另配 SMTP，另外核对其免费额度。

判断：如果“日本使用”只是用户位置，Cloudflare 可以先做；如果“日本数据库”是明确要求，则优先 Supabase 东京。若最在意减少认证与数据库开发复杂度，也可从第一天选 Supabase，不必因为 TokenX 用 Cloudflare 而强行重复。

不选 Vercel Hobby 作为该商业 SaaS 的免费底座：其官方计划限定个人非商业用途。免费 VPS 的抢配额、休眠、回收与自维护也不是当前最合适的路线。

## 从原型到可试用系统的下一步

先保留现有 HTML/CSS，创建独立后端目录和 SQL migrations。

1. 分离发布包与私人原始资料。目前 business-data.js 包含采购成本、全部门店报价，materials 有真实单据；正式网页不能把这些一起静态发布，仅通过授权 API 返回需要的数据。
2. 完成账号、公司/门店权限、商品与单位、门店报价和库存分配 API。
3. 接入原子下单、逐项配货、配送状态和审计，做两店并发、重复提交、跨店越权和单位换算测试。
4. 接入受控图片上传、可恢复备份和额度提示。
5. 用非真实客户的测试数据部署免费测试环境，在日本实际设备/网络上验收，再迁入确认后的业务数据。

本次只做探索，尚未执行上述实现与部署，也没有要求用户付费或购买域名。

## 官方依据

- Workers 定价（含 KV/D1）：https://developers.cloudflare.com/workers/platform/pricing/
- Workers 限制：https://developers.cloudflare.com/workers/platform/limits/
- Static Assets 计费：https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- D1 限制：https://developers.cloudflare.com/d1/platform/limits/
- D1 定价：https://developers.cloudflare.com/d1/platform/pricing/
- D1 位置：https://developers.cloudflare.com/d1/configuration/data-location/
- D1 batch 事务：https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- D1 免费每日限制：https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- KV 读取一致性：https://developers.cloudflare.com/kv/api/read-key-value-pairs/
- R2 开通：https://developers.cloudflare.com/r2/get-started/
- R2 定价：https://developers.cloudflare.com/r2/pricing/
- workers.dev 使用建议：https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Supabase 价格：https://supabase.com/pricing
- Supabase 区域：https://supabase.com/docs/guides/platform/regions
- Supabase 成本控制：https://supabase.com/docs/guides/platform/cost-control
- Supabase 备份：https://supabase.com/docs/guides/platform/backups
- Supabase SMTP：https://supabase.com/docs/guides/auth/auth-smtp
- Vercel Hobby：https://vercel.com/docs/plans/hobby
