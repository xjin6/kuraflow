# 日本行政区划离线数据

`japan-addresses.js` 为门店地址表单提供 **47 个都道府县、1,741 个市区町村和 20 个政令指定都市下的 171 个行政区**。页面运行时直接读取静态模块，无外部接口、费用或账户依赖。下载核验日期为 **2026-10-09**；这表示本地快照获取日期，不宣称所有上游源在当天更新。

## 数据来源与授权

- [Code for Fukui / localgovjp](https://github.com/code4fukui/localgovjp)：[市区町村 JSON](https://code4fukui.github.io/localgovjp/localgovjp.json)，用于 47 个都道府县和 1,741 个市区町村的名称、JIS 代码。项目声明为 [CC0](https://creativecommons.org/publicdomain/zero/1.0/)，README 来源说明为国土地理院及 J-LIS；README 最近记录的维护为 2026-07-09（网站地址更新）。
- [日本国土地理院 / 地理院地図](https://github.com/gsi-cyberjapan/gsimaps)：[muni.js](https://raw.githubusercontent.com/gsi-cyberjapan/gsimaps/gh-pages/js/muni.js)，用于政令市的当前区代码、区名称和父市对应关系。获取时该文件最新提交为 `98ff6ca1a477d140363fcd61d2475b3f9fbe27db`（2024-01-09）。采用仓库 BSD 2-Clause 授权，完整原文见文末。
- [Geolonia / japanese-addresses](https://github.com/geolonia/japanese-addresses)：[latest.csv](https://raw.githubusercontent.com/geolonia/japanese-addresses/master/data/latest.csv) 与 [ja.json](https://geolonia.github.io/japanese-addresses/api/ja.json)，仅补全町村前的郡名。数据按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用；归属 Geolonia，由倉流按下述规则提取和重组。`latest.csv` 获取时最新提交为 `740ece6e4a19ba330e487e8ecac7969bed4730d8`（2023-07-02）。

## 重组与约束

- 使用两位都道府县代码及五位 JIS 市区町村代码，保留前导零。
- 将政令市和其行政区拆成两级。例如 `27 大阪府 → 27100 大阪市 → 27111 浪速区`。
- 东京都 23 个特别区直接放在市区町村层级，例如 `13 東京都 → 13104 新宿区`；没有虚构的“东京市”，无需第三层。
- 一般市没有区选择；郡所属町村在同一项中保留郡名，例如 `京都府 → 相楽郡精華町`。郡不是门店必须逐级选择的自治体，因此不增加单独一层。
- 上游 Code for Fukui 的旧版浜松市七区没有被复制，区数据采用 GSI 的 2024 年重组结果：`中央区 / 浜名区 / 天竜区`。
- GSI 还包含历史代码 `04423 富谷市` 和北方四岛的六个村。本模块的市区町村范围以 Code for Fukui 当前行政自治体名录的 1,741 项为准，因此不会加入这些额外记录。
- 表单行政区划后面的町名、丁目、番地、楼栋和房间仍由使用者填写；不自动猜测门店具体地址。
- 未来发生行政区划调整时应重取上游数据、核对变化并更新静态模块。已有地址保留录入时的字符串，避免更名影响历史订单。

## 前端 API

```js
import { PREFECTURES, getMunicipalities, getWards, resolveJapanAddress } from './japan-addresses.js';

// All option lists contain { code: string, name: string }; unknown parents return [].
PREFECTURES;
getMunicipalities('27');
getWards('27', '27100');

resolveJapanAddress({ prefectureCode: '27', municipalityCode: '27100', wardCode: '27111' });
// { prefecture: '大阪府', municipality: '大阪市', ward: '浪速区' }

resolveJapanAddress({ prefectureCode: '13', municipalityCode: '13104' });
// { prefecture: '東京都', municipality: '新宿区', ward: '' }
```

`resolveJapanAddress` 会拒绝缺失的父层级、跨都道府县的市区町村、跨市行政区、政令市漏选区，以及普通市区町村上携带的多余区代码。选项数组和选项对象均冻结，避免表单修改共享数据。

## 国土地理院 BSD 2-Clause 原文

```text
Copyright (c) Geospatial Information Authority of Japan
All rights reserved.
Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of
conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list
of conditions and the following disclaimer in the documentation and/or other materials
provided with the distribution.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

```
