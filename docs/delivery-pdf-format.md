# 納品書导出格式

纳品书使用已确认的横向 A4 模板（841.68 × 595.44 pt）：左上收货店名，右上发票日期和蓝色标题，下接发行方资料及方章；左侧含税金额，底部五列表格和税额合计。普通页保留 14 行的明细区，长名称和多商品自动续页。单页不增加原模板没有的订单状态或页脚；多页仅在右下角显示页数，不再在左下角打印订单编号。订单编号保留在文件元数据中。

`order-pdf.js` 只排版，不导入参考单据。单价、数量、税率沿用订单快照；含税价和未税价按 `settlement-data.js` 的既有口径处理，未知值明确显示未确定，不默认套用参考税率。未送达的单据使用“納品予定”，避免把未完成订单写成已纳品。

导出前，管理端和门店端从 `GET /api/document-profile` 读取当前厨房的发行资料。只有管理端负责人可以通过 `POST /api/document-profile` 保存 `{version, issuer}`；版本是厨房业务修订号。发行字段为 name、address、phone、representative、sealUrl。公章须先上传至当前厨房的 `/api/images`，仅支持 PNG/JPEG；不存在、跨厨房或无法读取时阻止导出。模板中不包含任何真实公司、公章、订单或负责人数据。

文档字体为本地打包的 Sans 与 Serif，避免 PDF 阅读器依赖系统字体。Serif 来自 SIL OFL 1.1 的 Noto Serif CJK SC，使用 `scripts/build-document-font.py` 转为 TrueType 并重命名；许可证在 `public/fonts/NotoSerifCJK-LICENSE.txt`。导出时用 fonteditor-core 按实际文字生成完整 TrueType 子集，再嵌入 PDF，避免 fontkit 直接子集在部分阅读器中漏字，同时保持文件紧凑。PDF 只嵌入实际所需字形。

生成字体：先取得 notofonts/noto-cjk 仓库中的 `Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Regular.otf`，在安装 fonttools 的 Python 环境运行：

```sh
python3 scripts/build-document-font.py --source /path/to/NotoSerifCJKsc-Regular.otf --output public/fonts/KuraflowDocumentSerif.ttf
```

验证命令：`node --test frontend/order-pdf.test.mjs backend/document-profile.test.mjs`。另用 Poppler 渲染最终 PDF，检查中文/日文、印章、跨页、金额和网格。参考原件、真实公章及预览导出只保存在被 Git 忽略的私有目录，不进入公共构建。

2026-10-19 已完成正式发布，并为目标厨房单独配置发行资料与方章；没有导入参考订单或本地授权。当前版本及验收回执见 `docs/cloud-deployment-status.md`。其他厨房的发行资料和印章需独立配置。
