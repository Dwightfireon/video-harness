# Gemini 套餐调研 · 来源与证据

核查日期：2026-11-25。价格、额度与地区规则均可能变化，报告中的数字以查询当日官方页面为准。

## 1. Google Workspace 版本与价格

### Business editions

- URL：https://knowledge.workspace.google.com/admin/getting-started/editions/business-editions
- 更新日期：2026-11-10
- 摘录：
  > “Annual/Fixed-Term Plan … $7 USD / $14 USD / $22 USD”
  >
  > “Flexible Plan … $8.40 / $16.80 / $26.40”
- 对应版本：Business Starter / Standard / Plus。
- 置信度：高。

### Workspace 定价页

- URL：https://workspace.google.com/pricing
- 访问日期：2026-11-25
- 摘录：
  > “Gemini in Workspace apps — Starter: Limited”
  >
  > “Docs/Sheets/Slides/Drive/Meet/Chat: not supported by this SKU”
- 说明：页面按访问地区显示本地币种；USD 价格以官方帮助中心表格为准。
- 浏览器核验：2026-11-25 打开页面时显示 SGD 计价（Business Starter 促销月价 S$7.52），进一步说明地区会影响展示价格。截图：`browser/workspace-pricing-sgd.png`。
- 置信度：高。

### Workspace AI 用量限制

- URL：https://knowledge.workspace.google.com/admin/generative-ai/workspace-with-gemini/about-ai-usage-limits
- URL：https://knowledge.workspace.google.com/admin/generative-ai/workspace-with-gemini/ai-expanded-access
- 更新日期：2026-11-10
- 摘录：
  > “Usage limits don't roll over, and they can't be shared with other people.”
- 关键区别：
  - Starter：Gemini App 32K 上下文；不含 Docs/Sheets/Slides/Drive/Meet/Chat 的 Gemini 侧栏。
  - Standard/Plus：Gemini App 1M 上下文；包含主要 Workspace 应用侧栏。
  - AI Expanded Access：提高额度；不适用于 Starter。
- 置信度：高。

### 旧 add-on 与 AI Ultra Access

- URL：https://support.google.com/a/answer/15730372
- URL：https://knowledge.workspace.google.com/admin/generative-ai/workspace-with-gemini/ai-ultra-access
- 更新日期：2026-11-10
- 摘录：
  > “You are no longer being charged for the add-on after January 31, 2025.”
  >
  > “AI Ultra Access is no longer available for purchase.”
- 结论：基础 Gemini 已包含在当前 Workspace 版本中；旧版 Gemini add-on 不再单独收费；AI Ultra Access 已停售。
- 置信度：高。

## 2. Gemini Developer API

### Rate limits

- URL：https://ai.google.dev/gemini-api/docs/rate-limits
- 访问日期：2026-11-25
- 摘录：
  > “Rate limits are applied per project, not per API key.”
  >
  > “Specified rate limits are not guaranteed.”
- 结论：API 限额按 Cloud 项目管理；官方不再提供一张通用固定 RPM/TPM/RPD 表，需登录 AI Studio 查看实际限额。
- 置信度：高。

### API pricing

- URL：https://ai.google.dev/gemini-api/docs/pricing
- 更新日期：2026-10-30 UTC
- 代表价格（USD / 每百万 tokens）：

| 模型 | 输入 | 输出 | 备注 |
|---|---:|---:|---|
| Gemini 4 Carbon / Argon | $2 | $10 | 优惠至 2026-11-30；2026-12-01 起 $4/$20 |
| Gemini 4 Neon | $3 | $15 | 无免费层 |
| Gemini 4 Hydrogen | $1.50 | $7.50 | 有免费层 |
| Gemini 3.1 Pro Preview | $2 / $4 | $12 / $18 | ≤200K / >200K 输入上下文 |
| Gemini 3.8 / 3.6 Flash | $0.75 | $3.75 | 优惠至 2026-12-31；2027-01-01 起 $1.50/$7.50 |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | 有免费层 |
| Gemini 3.1 Flash-Lite | $0.25 | $1.50 | 文本/图片/视频输入；音频输入 $0.50 |

- 置信度：高。

### Batch API

- URL：https://ai.google.dev/gemini-api/docs/batch-api
- 访问日期：2026-11-25
- 摘录：
  > “Asynchronously at 50% of the standard cost.”
  >
  > “Target turnaround time is 24 hours.”
- 结论：Batch 价格为标准价 50%，无免费层，有独立配额。
- 置信度：高。

### Context caching

- URL：https://ai.google.dev/gemini-api/docs/caching?generate-content=true
- 访问日期：2026-11-25
- 摘录：
  > “Explicit caching is not supported for Gemini 4 models.”
- 结论：Gemini 4 仅支持隐式缓存；Gemini 3/2.5 的显式缓存仍为 Beta；缓存读取通常约为标准输入价的 10%。
- 置信度：高。

## 3. Vertex AI

- URL：https://cloud.google.com/vertex-ai/generative-ai/pricing
- 访问日期：2026-11-25
- 摘录：
  > “You're charged only for requests that return a 200 response code.”
- 结论：
  - Vertex AI 没有面向 Gemini 模型的永久免费 token 层。
  - Global 区域价格大多与 Developer API 相同；Non-global 区域通常高约 10%。
  - 超过 200K 输入上下文时，所有输入和输出按长上下文价格计费。
  - Batch/Flex 通常为标准价 50%。
- 置信度：高。

### Google Cloud 欢迎额度

- URL：https://cloud.google.com/free/docs/free-cloud-features
- 访问日期：2026-11-25
- 摘录：
  > “The $300 credit can't pay for Gemini platform … if you sign up … on or after November 16, 2026.”
- 结论：2026-11-16 及以后注册或升级的账户，$300 欢迎额度不能用于 Gemini 平台/Vertex AI；Gemini API in AI Studio 也被排除。
- 置信度：高。

## 4. AI Studio 与 API key

### Billing

- URL：https://ai.google.dev/gemini-api/docs/billing
- 访问日期：2026-11-25
- 摘录：
  > “AI Studio usage remains free of charge unless users link a paid API key.”
- 结论：AI Studio 界面可直接免费使用；只有链接付费 API key 或付费项目时才产生 API 费用。
- 置信度：高。

### API keys

- URL：https://ai.google.dev/gemini-api/docs/api-key
- 访问日期：2026-11-25
- 摘录：
  > “Starting May 28, 2026, all new API keys … are automatically created as auth keys.”
- 结论：新 key 默认为 authorization key；旧无限制 standard key 会被拒绝；限额按项目共享。
- 置信度：高。

### Additional Terms

- URL：https://ai.google.dev/gemini-api/docs/terms
- 生效日期：2026-03-23
- 摘录：
  > “You must be 18 years of age or older … for professional or business purposes, not for consumer use.”
- 结论：免费层可能用于改进产品并接受人工审核；付费层内容不用于改进产品；仅限官方支持地区，中国大陆不在当前支持名单。
- 置信度：高。

## 5. 消费订阅与 API 额度的区别

- URL：https://one.google.com/intl/en_us/about/google-ai-plans/
- URL：https://support.google.com/gemini/answer/16275805?hl=en
- URL：https://support.google.com/googleone/answer/16287445?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Each product has its own AI usage limits.”
- 美国个人计划 Cloud credits：
  - Google AI Pro：$10/月。
  - Ultra 5x：$40/月。
  - Ultra 20x：$100/月。
- 结论：Gemini App 订阅额度、AI Studio 界面额度、API 项目配额和 Cloud credits 是四套不同额度，不能互相直接兑换。
- 置信度：高。

## 6. 消费级套餐

### 美国官方方案页

- URL：https://one.google.com/intl/en_us/about/google-ai-plans/
- 访问日期：2026-11-25
- 摘录：
  > “Google AI Plus $4.99/mo … 400 GB storage”
  >
  > “Google AI Pro $19.99/mo … 5 TB storage”
  >
  > “Google AI Ultra … From $99.99/mo”
  >
  > “Annual ($199.99)”
- 对比表摘录：
  > “Higher Usage Limits — Two times (non-AI plans) / Four times (non-AI plans) / 5x (Pro plan) / 20x (Pro plan)”
- 浏览器核验：截图 `browser/google-ai-plans-us.png`。页面另有 Black Friday 定向促销横幅，本报告不采用促销价。
- 置信度：高。

### Gemini Apps 限额与功能可用性

- URL：https://support.google.com/gemini/answer/16275805?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Your limit refreshes every 5 hours until you reach your weekly limit.”
  >
  > “Without an AI plan — 32k tokens”
  >
  > “AI Plus — 128k tokens”
  >
  > “AI Pro & AI Ultra — 1 million tokens”
  >
  > “AI Ultra — 5x or 20x higher than AI Pro limits depending on your subscription”
- 结论：消费额度按计算量；Ultra 的倍数是相对 Pro，不是相对免费版。
- 浏览器核验：截图 `browser/gemini-app-limits.png`。
- 置信度：高。

### 模型与 Notebook

- URL：https://support.google.com/gemini/answer/18648722?hl=en
- URL：https://support.google.com/gemininotebook/answer/16213268?hl=en
- URL：https://support.google.com/gemininotebook/answer/17670842?hl=en
- 访问日期：2026-11-25
- 摘录：
  > 免费版/Plus：Hydrogen；Pro：Hydrogen、Neon；Ultra：Hydrogen、Neon、Carbon。
  >
  > Notebook：100/500 个笔记本；每本来源 50/300/500/600 个。
- 结论：Notebook 生成功能采用计算量限制；具体模型可能灰度上线。
- 置信度：高。

### 创作、Chrome 与 Workspace

- URL：https://support.google.com/gemini/answer/16126339?hl=en
- URL：https://support.google.com/websearch/answer/16649374?hl=en
- URL：https://support.google.com/gemini/answer/17140089?hl=en
- URL：https://support.google.com/gemini/answer/16821166?hl=en
- URL：https://support.google.com/docs/answer/13607340?hl=en
- 访问日期：2026-11-25
- 摘录：
  > 视频通常 3–10 秒，Ultra 最长 15 秒；Search 图像免费 25、Plus 50、Pro 100、Ultra 1,000/日。
  >
  > Chrome auto browse 仅美国、印度。
- 结论：Search 图像额度、Gemini App 图像额度、Flow credits 是不同额度；Chrome 与 Workspace AI 子功能有独立地区清单。
- 置信度：高。

### 学生优惠

- URL：https://blog.google/innovation-and-ai/products/gemini-app/student-offer-google-ai/
- URL：https://one.google.com/offer/studentoffer8
- URL：https://support.google.com/googleone/answer/17422238?hl=en
- 日期：2026-08-19；访问 2026-11-25
- 摘录：
  > 美国符合资格学生可免费使用 Google AI Pro 12 个月；境外符合条件的 Plus 方案；香港明确排除。
  >
  > 到期自动按标准价续费。
- 置信度：高。

### 家庭共享与取消

- URL：https://support.google.com/googleone/answer/9004015?hl=en
- URL：https://support.google.com/gemini/answer/14517446?hl=en
- 访问日期：2026-11-25
- 摘录：
  > 最多 5 位家庭成员；部分 AI 额度共享；可随时取消；不退还部分账单周期费用。
- 置信度：高。

### 地区可用性

- URL：https://support.google.com/gemini/answer/13575153?hl=en
- URL：https://support.google.com/googleone/answer/16476811?hl=en
- URL：https://support.google.com/googleone/answer/16476748?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Mainland China (Workspace only)”
- 结论：中国大陆不提供消费者 Gemini App 或 AI Plus/Pro/Ultra。
- 浏览器核验：截图 `browser/gemini-available-regions.png`。
- 置信度：高。

### 各地标准月付价

| 地区 | 来源 | 日期 | 摘录 | 置信度 |
|---|---|---|---|---|
| 美国 | https://gemini.google/us/subscriptions/?hl=en | 2026-11-25 | Pro $19.99；Ultra $99.99/$199.99 | 高 |
| 英国 | https://one.google.com/intl/en_uk/about/google-ai-plans/ | 2026-11-25 | Pro £18.99；Ultra £79.99/£189.99 | 高 |
| 香港 | https://one.google.com/intl/en_hk/about/google-ai-plans/ | 2026-11-25 | Pro HK$158；Ultra HK$799/1,588 | 高 |
| 台湾 | https://one.google.com/intl/zh-TW_tw/about/google-ai-plans/ | 2026-11-25 | Pro NT$650；Ultra NT$3,300/6,500 | 高 |

### 官方页面冲突与未确认项

1. Pro 是否可在 Search AI Mode 使用 Carbon：Search 专用帮助写“Ultra only”，部分 Google One 页面仍写 Pro 可用；置信度中。
2. Project Genie 档位：美国/全球部分页面写“Ultra 专属”，英国、香港、台湾页脚写“仅 Ultra 20x”；未确认。
3. 英国、香港、台湾 Pro 年付金额：官方确认有年付选项，但匿名页面未展示金额；不推算。
4. 香港 Notebook 与部分 Workspace AI 附属功能：套餐可购买，但附属功能国家清单未列香港；以账号实际可用性为准。
5. 模型、Chrome、Tasks、Project Genie 等可能按账户、设备、年龄、地区灰度上线。

## 7. 中国大陆、账户地区与服务条款

### Gemini 官方可用地区

- URL：https://support.google.com/gemini/answer/13575153?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Mainland China (Workspace only)”
- 结论：中国大陆不提供消费者 Gemini App / AI Plus / Pro / Ultra。
- 浏览器核验：截图 `browser/gemini-available-regions.png`。
- 置信度：高。

### Google Account 地区

- URL：https://policies.google.com/faq?hl=en
- URL：https://policies.google.com/country-association-form?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “When you create a new account, we associate your account with a region based on where you created your Google Account.”
  >
  > “Frequent travel doesn't generally affect the region associated with your account. If you move to a new region, it can take about a year …”
  >
  > “If the region associated with your account doesn't correspond to your region of residence …”
- 补充：FAQ 还说明，网络环境可能造成账户地区误判。
- 结论：账户地区不是任意选择国家的开关；手动更正有官方表单，但公开页面未写明固定处理时限。
- 置信度：高。

### Google Play 国家/地区

- URL：https://support.google.com/googleplay/answer/7431675?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “You must wait at least 90 days … You must also wait at least 90 days between each subsequent change.”
  >
  > “To set up a new country or region, you must be in that location and have a payment method from the new country or region.”
- 结论：Play 地区与 Account 地区、支付资料是不同设置；现有订阅不会自动迁移到新支付资料。
- 浏览器核验：截图 `browser/google-play-country-rules.png`。
- 置信度：高。

### 支付资料

- URL：https://support.google.com/googlepay/answer/7644003?hl=en
- URL：https://support.google.com/googlepay/answer/7644076?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Country or region: You can't change this setting.”
  >
  > “If you create a new payments profile, it won't affect payments for your current services.”
- 置信度：高。

### 家庭共享

- URL：https://support.google.com/families/answer/6317858?hl=en
- URL：https://support.google.com/googleone/answer/9004015?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Live in the same country as the family manager.”
- 结论：不能通过海外家庭管理员跨国家共享给大陆成员。
- 置信度：高。

### Ultra 旅行限制

- URL：https://support.google.com/gemini/answer/16275805?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “If you travel from a country where Google AI Ultra is available to a country where it is not available … you won't be able to upgrade or use Ultra until you return to a country where Ultra is supported.”
- 置信度：高。

### 服务条款

- URL：https://policies.google.com/terms?hl=en
- 日期：2026-07-30 生效
- URL：https://play.google.com/about/play-terms.html
- 日期：2026-07-29 版本
- URL：https://one.google.com/terms-of-service
- 日期：2026-10-01 最后修改
- 访问日期：2026-11-25
- 摘录：
  > “But not all services mentioned may be available in your country.”
  >
  > “hacking or bypassing our systems or protective measures”
  >
  > “hiding or misrepresenting who you are in order to violate these terms”
- 限定：没有找到“仅使用某种网络环境即违规”的专门条款；以技术手段隐藏真实所在地、虚假居住或支付地区规避支持范围，可能落入一般条款，置信度中高，不构成法律意见。

## 8. 付款方式

### Google One 网页付款

- URL：https://support.google.com/googleone/answer/9003634?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Credit card; Bank account (US only); PayPal; Google Play balance (Selected countries/regions only).”
- 补充：同页新增付款方式步骤写“信用卡或借记卡”，但支持清单只单列信用卡。
- 结论：这是 Google One 通用清单；AI Pro/Ultra 具体显示项仍依地区和支付资料。
- 置信度：高（通用清单）；中（具体 AI 套餐显示项）。

### Google Play 付款方式

- URL：https://support.google.com/googleplay/answer/2651410?hl=en
- URL：https://support.google.com/googleplay/answer/2476088?hl=en
- 香港示例：https://support.google.com/googleplay/answer/2651410?co=GENIE.CountryCode%3DHK&hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Available payment methods vary by country.”
  >
  > “Some mobile phone carriers can't be used to pay for subscriptions.”
- 香港页面列出 UnionPay、AliPayHK、Octopus、PayPal 等；不能把 AliPayHK 等同于大陆支付宝。
- 结论：Play 通用方式包括信用卡/借记卡、运营商账单、Play 余额/礼品卡充值、PayPal 和部分本地方式；订阅有额外限制。
- 置信度：高（随地区变化）；中（AI Pro/Ultra 的 Play 专属完整清单未找到）。

### 大陆银行卡、支付宝、微信支付

- URL：https://support.google.com/googleone/answer/16476811?hl=en
- URL：https://support.google.com/googleone/answer/16476748?hl=en
- URL：https://support.google.com/googlepay/answer/12429287?hl=zh-Hans
- 访问日期：2026-11-25
- 结论：
  - 大陆发行银行卡：未确认。
  - 大陆版支付宝：未确认；官方出现的是香港 AliPayHK。
  - 微信支付：未确认。
- 限定：不能把“未找到支持明文”改写成“官方明确支持”，也不宜仅凭名单缺失断言所有情形绝对不可用。
- 置信度：高（未确认状态）。

### 礼品卡、Play 余额与 Split Payment

- URL：https://support.google.com/googleplay/answer/3423011?hl=en
- URL：https://support.google.com/googleplay/answer/6080850?hl=en
- URL：https://support.google.com/googleplay/answer/2476088?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “When you redeem a gift card, the gift card amount gets added to your Google Play balance.”
  >
  > “Some subscriptions do not accept Stored Value.”
  >
  > “The Split Payment option applies only to the initial subscription sign up or upgrade payment.”
- 结论：礼品卡不能直接作为订阅支付方式；兑换成余额后仅在部分地区、结账页提供选项时才可能支付订阅。Split Payment 不自动延续到后续续费。
- 置信度：高（条件规则）；对 AI 档位为中高，因为结论由 Google One 支付规则推出。

### 取消、退款与试用

- URL：https://support.google.com/googleone/answer/9056360?hl=en
- URL：https://support.google.com/googleone/answer/2736362?hl=en
- URL：https://support.google.com/googleone/answer/9155746?hl=en
- URL：https://support.google.com/googleplay/answer/7018481?hl=en
- URL：https://support.google.com/googleplay/answer/15574908?hl=en
- URL：https://support.google.com/googleplay/answer/2476088?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “You can cancel your Google One membership plan at any time.”
  >
  > “In most countries or regions, Google storage plan purchases are non-refundable.”
  >
  > “If you are based in the European Economic Area, UK or Switzerland, you have the option to withdraw your Google One membership within 14 days of purchase.”
  >
  > “When you uninstall the app, your subscription won't cancel.”
- 结论：取消停止未来付款，权益通常到周期结束；Google One 大多数地区不退款；EEA/英国/瑞士、以色列、韩国有例外；试用结束自动收费。
- 置信度：高。

### 虚拟信用卡与付款失败

- URL：https://support.google.com/googleplay/answer/2651410?co=GENIE.CountryCode%3DUS&hl=en
- URL：https://support.google.com/googleplay/answer/1267137?hl=en
- 访问日期：2026-11-25
- 摘录：
  > “Google Play can't be used with … Virtual Credit Cards (VCC).”
  >
  > “Expired credit cards or old billing addresses are a common reason for payments not to work properly.”
- 其他官方失败条件：余额不足、发卡行限制、支付资料停用或需身份验证、卡被盗/需验证/不符合资格、Play 国家与居住国不一致、卡种/卡组织不受支持。
- 置信度：高。

## 9. 浏览器截图索引

截图日期均为 2026-11-25。截图只证明页面当时展示的内容，不代表实际登录账户、付款、试听或发布审阅已完成。

| 文件 | 页面 | 核验重点 |
|---|---|---|
| `browser/google-ai-plans-us.png` | Google One 美国 AI 方案页 | Plus/Pro/Ultra 与美国标准价入口 |
| `browser/gemini-app-limits.png` | Gemini Apps 限额帮助 | 计算量限制、每 5 小时刷新、年龄要求 |
| `browser/gemini-available-regions.png` | Gemini 可用地区 | “Mainland China (Workspace only)” |
| `browser/workspace-pricing-sgd.png` | Workspace 定价页 | 页面按访问地区显示 SGD 计价 |
| `browser/gemini-api-pricing.png` | Gemini API 定价页 | 模型 Token 价格 |
| `browser/gemini-api-rate-limits.png` | Gemini API 限额页 | 按项目而非 key 限额 |
| `browser/gemini-api-terms.png` | Gemini API 附加条款 | 年龄、用途与数据条款 |
| `browser/google-play-country-rules.png` | Google Play 国家/地区帮助 | 90 天规则、当地支付方式、家庭组限制 |
