# Gemini 套餐调研 · Workspace 与 API 证据整理

## 一、Workspace：按席位购买，Gemini 已包含在版本中

截至 2026-11-25，Google Workspace 的 Business 版本官方 USD 价格如下：

| 版本 | 年付折算/用户/月 | 灵活月付/用户/月 | Gemini 概况 |
|---|---:|---:|---|
| Business Starter | $7 | $8.40 | Gemini in Gmail、Vids AI、Gemini App 标准版；不含 Docs/Sheets/Slides/Drive/Meet/Chat 侧栏 |
| Business Standard | $14 | $16.80 | 主要 Workspace 应用侧栏、Gemini App Pro 级访问、更高 Notebook 额度 |
| Business Plus | $22 | $26.40 | Gemini 能力与 Standard 基本相同，另有 Plus 专属功能 |

Enterprise Standard/Plus 与 Frontline 系列没有公开统一价格，需要联系 Google Sales。

### 容易混淆的地方

- 旧版 Gemini for Workspace add-on 已不再单独收费。
- 当前可选加购主要是 **AI Expanded Access**，用于提高额度，且不适用于 Starter。
- **AI Ultra Access 已停止购买**，不能把消费级 Ultra 套餐当成 Workspace 企业版。
- Workspace 用量按用户计算，不共享、不结转。

## 二、Gemini Developer API：按 Token 计费

Gemini Developer API 的账单由四部分组成：

1. 输入 Token。
2. 输出 Token，包含 thinking Token。
3. 缓存读取。
4. 显式缓存存储时长。

代表模型价格（USD / 每百万 Token）：

| 模型 | 输入 | 输出 | 免费层 |
|---|---:|---:|---|
| Gemini 4 Carbon / Argon | $2 | $10 | 否 |
| Gemini 4 Neon | $3 | $15 | 否 |
| Gemini 4 Hydrogen | $1.50 | $7.50 | 是 |
| Gemini 3.1 Pro Preview | $2 / $4 | $12 / $18 | 否 |
| Gemini 3.8 / 3.6 Flash | $0.75 | $3.75 | 是 |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | 是 |

说明：

- 4 Carbon/Argon 的 $2/$10 优惠至 2026-11-30，之后变为 $4/$20。
- 3.8/3.6 Flash 的 $0.75/$3.75 优惠至 2026-12-31，之后变为 $1.50/$7.50。
- 超过 200K 输入上下文时，通常所有输入和输出都按长上下文价格计费。
- Batch API 为标准价 50%，目标周转 24 小时。
- Gemini 4 仅支持隐式缓存；显式缓存主要用于 Gemini 3/2.5。

## 三、AI Studio：界面免费，API 另算

- AI Studio 页面可直接免费使用。
- 只有链接付费 API key 或付费项目时才产生 API 费用。
- 免费层内容可能用于改进 Google 产品，人工审核员可能查看。
- 付费层内容不用于改进产品。
- API 限额按项目而非 key 计算。
- 仅限官方支持地区，中国大陆不在当前支持名单。
- 条款要求年满 18 岁，并定位为开发者/专业或商业用途。

## 四、Vertex AI：企业部署，不是永久免费 Token 层

- Vertex AI 使用付费 Cloud Billing，没有面向 Gemini 模型的永久免费 Token 层。
- 2026-11-16 及以后注册或升级的账户，$300 Google Cloud 欢迎额度不能支付 Gemini 平台/Vertex AI 费用。
- Global 区域价格大多与 Developer API 相同；Non-global 区域通常高约 10%。
- 只有返回 HTTP 200 的请求收取输入/输出费用。
- Batch/Flex 通常为标准价 50%。

## 五、四套额度不能混用

| 额度 | 是什么 | 不是什么 |
|---|---|---|
| Gemini App 订阅额度 | 按计算量、模型、对话长度等计算，通常每 5 小时刷新 | 不是 API Token 额度 |
| AI Studio 界面额度 | 模型/功能的界面使用量 | 不是 API key 的项目配额 |
| Gemini API 配额 | 项目级 RPM/TPM/RPD | 不是消费订阅提示次数 |
| Google Cloud credits | 账单抵扣金额 | 不是调用次数，也不等于现金 |

美国个人计划可能附带 Cloud credits，但金额与套餐、地区、活动有关，不能直接理解为“免费 API 额度”。
