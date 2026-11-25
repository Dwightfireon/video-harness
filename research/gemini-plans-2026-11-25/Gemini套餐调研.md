# Gemini 套餐调研：消费订阅、Workspace、API 与中国大陆可用性

> **核查日期：2026-11-25**  
> 性质：信息搜集与汇总，不推荐、不推广，不提供绕过地区限制的操作步骤。  
> 价格、额度、模型和地区规则可能变化；文中的数字以查询当日官方页面为准。  
> 置信度口径：**高**＝官方直接明文；**中**＝官方页面存在冲突、灰度或地区差异；**未确认**＝未取得官方明文。

---

## 先看结论

1. **Gemini 不是一套套餐。** 至少要分清六种产品：免费版、Google AI Plus、Google AI Pro、Google AI Ultra、Gemini for Workspace、Gemini API / Vertex AI。
2. **消费订阅按账户卖，Workspace 按席位卖，API 按 Token 用量卖。** 三者的额度不能互相兑换。
3. 美国当前标准价为：Plus **$4.99/月**、Pro **$19.99/月**或 **$199.99/年**、Ultra 5x **$99.99/月**、Ultra 20x **$199.99/月**。Ultra 仅月付。
4. Gemini App 用量是**计算量限制**，不是固定消息条数。Plus 是免费版的 2 倍，Pro 是免费版的 4 倍；Ultra 5x/20x 则是 **Pro 的 5 倍/20 倍**。
5. **中国大陆没有官方开放的消费者 Gemini App / AI Plus / Pro / Ultra 订阅。** 官方可用地区页只给大陆标注 **“Workspace only”**。
6. “能打开网页”“有海外账户”“能付款”是三件不同的事，都不等于产品在本地正式支持。
7. 学生优惠、家庭共享、试用、退款和附属功能各有独立规则；买了套餐也不代表所有 AI 功能都在当地开放。

---

## 一、先分清六个层级

| 层级 | 面向谁 | 计费对象 | 核心额度 | 与其他层级的关系 |
|---|---|---|---|---|
| Gemini 免费版 | 个人用户 | 免费 | 动态计算额度、32K 上下文 | 不是 API 免费层 |
| Google AI Plus | 个人/家庭 | 月费 | 免费版 2 倍用量、128K 上下文 | 消费订阅 |
| Google AI Pro | 个人/家庭 | 月费或年费 | 免费版 4 倍用量、1M 上下文 | 消费订阅 |
| Google AI Ultra 5x / 20x | 个人/家庭 | 月费 | Pro 的 5 倍 / 20 倍用量、1M 上下文 | 消费订阅，不是企业 Ultra |
| Gemini for Google Workspace | 组织/企业 | 每用户席位 | Workspace 功能次数、每用户 AI 额度 | 受管理员策略和组织地区约束 |
| Gemini API / Vertex AI | 开发者/企业 | 输入/输出/缓存 Token | 项目级 RPM/TPM/RPD、账单余额 | 与消费订阅额度完全分开 |

### 三个最常见的误区

- **消费订阅 ≠ API 额度。** Pro/Ultra 可能附带 Google Cloud credits，但 Gemini App 的聊天用量不会变成 API Token。
- **Workspace ≠ 个人 Pro。** 前者按组织席位、由管理员控制；后者是个人 Google Account 的消费订阅。
- **“Unlimited / 无限”宣传 ≠ 技术上无限。** 官方仍会按模型、功能、上下文、峰值和每周上限进行限制。

---

## 二、消费级价格

### 1. 美国标准价

| 套餐 | 月付 | 年付 | 相对用量 | 上下文 | 存储 |
|---|---:|---:|---|---:|---:|
| 免费版 | $0 | — | 标准 | 32K | 15 GB |
| Google AI Plus | $4.99/月 | 本次未确认 | 免费版 2 倍 | 128K | 400 GB |
| Google AI Pro | $19.99/月 | $199.99/年 | 免费版 4 倍 | 1M | 5 TB |
| Ultra 5x | $99.99/月 | 不支持 | Pro 的 5 倍 | 1M | 20 TB |
| Ultra 20x | $199.99/月 | 不支持 | Pro 的 20 倍 | 1M | 30 TB |

官方页面当时有“黑五最高 50%”的会员定向促销横幅。上表是标准价，**没有把促销价当成长期价格**。

美国方案页顶部把 Plus 存储标为 400 GB，页面下方对比表另出现“400 GB or 2 TB”的表述，可能受活动或地区影响；实际存储以登录后的方案页和结账页为准。

### 2. 其他地区官方标准月付价

| 地区 | AI Pro | Ultra 5x | Ultra 20x |
|---|---:|---:|---:|
| 美国 | $19.99 | $99.99 | $199.99 |
| 英国 | £18.99 | £79.99 | £189.99 |
| 中国香港 | HK$158 | HK$799 | HK$1,588 |
| 中国台湾 | NT$650 | NT$3,300 | NT$6,500 |

中国大陆不提供消费者订阅，因此不列入价格表。以上是官方当地标价，不是汇率换算。是否含税、支付渠道和最终结账金额，以账户账单地区为准。

官方帮助确认 Pro 在部分地区有年付选项，但匿名访问的英国、香港、台湾页面没有展示确切年付金额，因此本报告不推算。上述地区的 AI Plus 标准价也未在本次公开页面完整确认。

### 3. 重点地区可用性

| 地区 | 消费者免费版 | Plus/Pro/Ultra | Notebook | Chrome 基础 / auto browse | 个人 Workspace AI | 学生优惠 |
|---|---|---|---|---|---|---|
| 美国 | 可用 | 可用 | 可用 | 可用 / 可用 | 可用 | Pro 免费 12 个月 |
| 英国 | 可用 | 可用 | 可用 | 可用 / 不可用 | 可用；部分视频功能受限 | Plus 免费 12 个月；Pro 组合优惠 |
| 中国大陆 | **仅 Workspace** | **不可用** | 未确认；官方支持清单未列 | 未确认；官方支持清单未列 | 消费者套餐不可用 | 不可用 |
| 中国香港 | 可用 | 可用 | 官方支持清单未列香港 | 可用 / 不可用 | Workspace Experiments 清单未列香港 | 明确排除 |
| 中国台湾 | 可用 | 可用 | 可用 | 可用 / 不可用 | 可用 | Plus 免费 12 个月；Pro 组合优惠 |

“套餐可购买”与“所有附属功能可用”不是一回事。Notebook、Chrome、YouTube、Home、Health、视频编辑等权益各有自己的国家、年龄或灰度条件。

---

## 三、免费版：有功能，但有限制

### 官方明确包含

- Gemini 4 Hydrogen；Auto 模式会在 Hydrogen 与轻量快速模型之间路由。
- 图像生成与编辑，主要使用 Nano Banana 2。
- Deep Research、Gemini Live、Canvas、Skills、Storybook、Connected Apps、测验/闪卡、音频概览、屏幕自动化、幻灯片生成、音乐生成等入口。
- Gemini Notebook（原 NotebookLM）基础版。
- Google Flow 的有限创意功能，包括有限的 Nano Banana Pro 使用。
- Google Account 基础 15 GB 存储。

### 主要限制

| 限制 | 说明 |
|---|---|
| 动态计算额度 | 按提示词复杂度、模型、思考强度、对话长度、附件大小等计算 |
| 刷新与周上限 | 通常每 5 小时刷新，达到每周上限后需等待重置 |
| 上下文 | 32K tokens；Plus 128K；Pro/Ultra 1M |
| 视频生成 | Gemini App 内视频生成需要付费 AI 套餐 |
| 高级图像功能 | 没有 Nano Banana Pro 的 Redo with Pro、Daily Brief、Scheduled Actions 等付费功能 |
| Deep Research | 有每日与并发限制，但官方没有公布统一的“每天 N 次” |
| Gmail AI | 免费个人账号仅在美国有部分基础 Gmail AI，不等于完整 Workspace AI |

**怎么理解：**免费版不是“每条消息固定消耗一次”。一次长文档分析、复杂代码任务或媒体生成，可能比几条短对话消耗更多额度。

---

## 四、Plus、Pro、Ultra 的权益差异

| 项目 | AI Plus | AI Pro | Ultra 5x | Ultra 20x |
|---|---|---|---|---|
| Gemini App 用量 | 免费版 2 倍 | 免费版 4 倍 | Pro 的 5 倍 | Pro 的 20 倍 |
| 模型 | Hydrogen | Hydrogen、Neon | Hydrogen、Neon、Carbon | Hydrogen、Neon、Carbon |
| 上下文 | 128K | 1M | 1M | 1M |
| Gemini Notebook | 更高界面额度 | 500 个笔记本；每本 300 个来源 | 500 个；每本 500 个来源 | 500 个；每本 600 个来源 |
| Google Flow | 高于免费版；具体 credits 未统一确认 | 1,000 credits/月 | 10,000 credits/月 | 25,000 credits/月 |
| Flow Music | 更高 | 10,000 credits/月 | 30,000 credits/月 | 30,000 credits/月 |
| 视频 | 可用；具体额度以账号为准 | Omni Flash，通常 3–10 秒 | 同 Pro | 最长可到 15 秒 |
| YouTube | 依地区/套餐 | Premium Lite 个人版 | Premium Family | Premium Family |
| Colab | 依套餐 | 200 计算单元/月 | 1,000/月 | 2,000/月 |
| Google Cloud credits | 未统一确认 | $10/月（美国） | $40/月（美国） | $100/月（美国） |
| 家庭共享 | 最多 5 人 | 同左 | 同左 | 同左 |

### 1. 模型名

- **Hydrogen**：免费版和 Plus 可使用的基础模型。
- **Neon**：2026-11-18 起向 Pro/Ultra 推出。
- **Carbon**：2026-11-10 起向 Ultra 推出。
- **Argon**：本次核验中主要出现在 API 和 Workspace AI Expanded Access 文档，不应据此写成消费者 Ultra 的默认模型。

模型可能按账户、设备、年龄和地区灰度上线，以 Gemini 模型选择器为准。

### 2. Notebook、Deep Research 与创作

- Notebook 的笔记本数量、每本来源数有明确上限；对话、音频/视频概览等生成功能采用计算量限制，每 5 小时刷新至每周上限。
- Deep Research 的付费档位有更高额度；Ultra 可使用 Carbon，并支持图表、动画、交互式图示等输出。
- Gemini App 图像额度没有统一公开的每日数量。
- **Search AI Mode 图像额度是另一套**：免费 25 张/日、Plus 50 张/日、Pro 100 张/日、Ultra 1,000 张/日。
- 个人视频生成需要付费套餐；视频通常 3–10 秒，Ultra 最长 15 秒。英国、EEA、瑞士及部分美国州暂不支持上传视频编辑或 avatar 功能。
- 印度、韩国、越南的 Notebook 输出仍会自动加可见水印。

### 3. Chrome 与 Google 应用

- **基础 Gemini in Chrome**：不要求付费套餐，13+，在支持地区逐步上线；美国、英国、香港、台湾在成人支持名单。
- **Chrome auto browse**：目前仅美国和印度，18+，需 Chrome 144+。Pro/Ultra 包含权益，但其他地区不一定可用。
- **Gemini in Gmail、Docs、Drive、Sheets、Slides、Meet、Vids**：Pro/Ultra 面向个人账号提供广泛 AI 功能。
- 官方 Workspace Experiments 国家清单包含美国、英国、台湾，不包含香港和中国大陆。因此“买了套餐”不等于每个 Workspace AI 子功能都开放。

### 4. 官方页面冲突

- Google Search 的 Carbon 帮助页写“仅 Ultra 18+”，部分 Google One 页面仍写 Pro 可在 AI Mode 使用 Carbon。**Pro 的 Search AI Mode Carbon 权益置信度为中。**
- Project Genie 的美国/全球部分页面写“Ultra 专属”，英国、香港、台湾页脚写“仅 Ultra 20x”，未确认。
- 香港可购买 Pro/Ultra，但 Notebook 国家清单和部分 Workspace AI 清单未列香港，不能把套餐可用性等同于全部附属功能可用。

---

## 五、学生优惠、家庭共享、试用与取消

### 学生优惠

官方 2026-08-19 学生方案，兑换截止 **2026-12-31**：

- **美国**：符合资格大学生可免费使用 Google AI Pro **12 个月**；需要有效支付方式；不取消则到期自动按 $19.99/月续费。
- **美国以外**：符合资格学生可免费使用 Google AI Plus **12 个月**；英国、台湾符合公开地区条件；香港、澳门明确排除；到期自动按当地 Plus 月费续费。
- 部分地区有 Pro + YouTube Premium 学生组合，最高约 70% 折扣，最长 4 年；美国示例 $8.99/月。
- 须通过 SheerID 验证，个人账号、18+；学校签发账号、家庭群组成员、第三方/Pixel Pass/Fi 用户不符合资格。
- **没有找到官方 Ultra 学生优惠。**

### 家庭共享

- 最多共享给 **5 位家庭成员**，共 6 个账号。
- 成员必须与管理员**居住在同一国家**，不能跨国家共享。
- 存储、Gemini App、Notebook、Antigravity 等 AI 权益和 AI credits 可共享。
- Flow、Antigravity 等部分额度按家庭共享池计算，不是每人独立额度。
- Pro 的 YouTube Premium Lite、Home Premium、Developer Program Premium、Colab 等不可共享或仅管理员可得。
- 文件本身保持私密，不因共享存储而互相可见。
- 未成年人使用全部 AI 功能受年龄限制；英国、EEA、瑞士使用付费 Gemini App 须 18+。

### 免费试用

- 当前存在账户/地区定向试用，没有可保证的全球统一试用时长。
- 必须在试用结束前取消，否则按所在国标准月付或年付价自动收费。
- 试用权益可能与正式付费不同，例如部分 Google One 试用不含 Colab、Antigravity、YouTube Premium/Lite。
- 是否有试用、试用几天，以登录后的 Google One/Play 订阅页为准。

### 取消与续费

- 可随时通过 Gemini Settings → Manage subscription 或 Google One → Cancel membership 取消。
- 取消会停止未来付款；存储和付费权益通常持续到**当前计费周期结束**，之后才失效。
- 自动续费，直到取消；卸载应用不会取消 Google Play 订阅。
- 大多数国家/地区的 Google One 存储计划购买不可退款；取消不等于退还未使用部分。
- Google One 官方列出的退款例外包括：EEA、英国、瑞士购买后 14 天内可撤回并退款；以色列可申请按剩余天数部分退款；韩国购买后 7 天内、未开始使用可申请全额退款。
- Google Play 普通购买在 48 小时内可能符合退款条件；Google One 等 Google 自行开发产品另适用特别政策。使用 Play 余额支付的退款通常退回 Play 账户，不是现金。
- 试用必须绑定支付方式，结束时会自动收费；不想付费应在试用最后一天之前取消。
- 已有独立 YouTube Premium/Lite 不会因订阅 Pro 自动取消。
- Ultra 不能通过第三方集成账单商购买；已有第三方或 Apple 订阅通常需先取消才能切换。

---

## 六、Workspace：按席位购买

### 1. Business 版本官方 USD 参考价

| 版本 | 年付折算/用户/月 | 灵活月付/用户/月 | Gemini 概况 |
|---|---:|---:|---|
| Business Starter | $7 | $8.40 | Gemini in Gmail、Vids AI、Gemini App 标准版；不含 Docs/Sheets/Slides/Drive/Meet/Chat 侧栏 |
| Business Standard | $14 | $16.80 | 主要 Workspace 应用侧栏、Gemini App Pro 级访问、更高 Notebook 额度 |
| Business Plus | $22 | $26.40 | Gemini 能力与 Standard 基本相同，另有 Plus 专属功能 |

Enterprise Standard/Plus 与 Frontline 系列没有公开统一价格，需要联系 Google Sales。各地实际价格可能以本地币种和合同为准。

### 2. 用量限制

Workspace 限制按**用户**计算，不共享、不结转；日额度在太平洋时间午夜重置，月额度在每月 1 日重置。

| 功能 | Starter | Standard/Plus、Enterprise Standard/Plus | AI Expanded Access |
|---|---:|---:|---:|
| Gemini App 上下文 | 32K | 1M | 1M，并可用 Argon |
| Deep Research | 5 份/月 | 更高 | 最高 |
| Sheets AI function | 无 | 5,000 次/月 | 25,000 次/月 |
| Vids 数字人 | 10 个/月 | 25 个/月 | 100 个/月 |
| Vids 视频 | 200 秒/月 | 500 秒/月 | 2,000 秒/月 |
| Nano Banana Pro 图片 | 5 张/月 | 30 张/月 | 300 张/月 |
| 30 秒音乐 | 20 首/月 | 50 首/月 | 250 首/月 |

Notebook 方面：

- Starter/Frontline：100 个笔记本、每本 50 个来源、50 次聊天/日、3 个音频概览/日。
- Standard/Plus、Enterprise Standard/Plus：500 个笔记本、每本 300 个来源、500 次聊天/日、20 个音频概览/日。
- AI Expanded Access：每本 400 个来源、1,000 次聊天/日、40 个音频概览/日。

### 3. 附加许可的现状

- 基础 Gemini 已包含在当前 Workspace 版本中。
- 旧版 Gemini for Workspace add-on 已于 **2025-01-31 停止收费**，不再续售。
- 当前可选加购主要是 **AI Expanded Access**，用于提高额度，不适用于 Starter；官方没有公开固定 USD 价格。
- **AI Ultra Access 已停止购买**：2026-05-05 起停售，灵活套餐于 2026-07-07 转至 AI Expanded Access。
- 不能把消费级 Google AI Ultra 当成 Workspace 企业版。

---

## 七、Gemini API、AI Studio 与 Vertex AI

### 1. API 怎么计费

Gemini Developer API 的账单由四部分组成：

1. 输入 Token。
2. 输出 Token，包含 thinking Token。
3. 缓存读取。
4. 显式缓存存储时长。

代表模型价格，单位 **USD / 每百万 Token**：

| 模型 | 输入 | 输出 | 免费层 | 备注 |
|---|---:|---:|---|---|
| Gemini 4 Carbon / Argon | $2 | $10 | 否 | 优惠至 2026-11-30；2026-12-01 起 $4/$20 |
| Gemini 4 Neon | $3 | $15 | 否 | 仅隐式缓存 |
| Gemini 4 Hydrogen | $1.50 | $7.50 | 是 | 仅隐式缓存 |
| Gemini 3.1 Pro Preview | $2 / $4 | $12 / $18 | 否 | ≤200K / >200K 输入上下文 |
| Gemini 3.8 / 3.6 Flash | $0.75 | $3.75 | 是 | 优惠至 2026-12-31；2027-01-01 起 $1.50/$7.50 |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | 是 | — |

其他计费规则：

- API 限额按 **项目而非 API key** 计算，维度为 RPM、TPM、RPD；RPD 在太平洋时间午夜重置。
- 官方现在要求登录 AI Studio 查看实际限额，不再公开一张通用固定 RPM/TPM/RPD 表，且限额不保证。
- **Batch API 为标准价 50%**，目标周转 24 小时，没有免费层。
- 缓存读取通常约为标准输入价的 10%，即约 90% 折扣。
- **Gemini 4 仅支持隐式缓存，不支持显式缓存**；Gemini 3/2.5 的显式缓存仍为 Beta。
- 旧 2.5 Pro / 2.5 Flash 已弃用；2026-12-01 起请求会自动路由到新模型并按新模型计费。

### 2. AI Studio

- AI Studio 界面可直接免费使用。
- 只有链接付费 API key 或付费项目时才产生 API 费用。
- 免费层内容可能用于改进 Google 产品，人工审核员可能查看；付费层内容不用于改进产品。
- 免费层 API key 可以使用免费层模型，但受项目级 RPM/TPM/RPD 限制。
- 2026-03-23 起新用户默认进入 Prepay，通常需预充至少 $5；余额为 0 时关联项目 key 会同时停止。
- 2026-05-28 起新 key 默认是 authorization key，旧无限制 standard key 会被拒绝。
- 条款要求年满 18 岁，定位为开发者/专业或商业用途，不是消费级使用。
- **仅限官方支持地区，中国大陆不在当前名单。**

### 3. Vertex AI

- 使用付费 Cloud Billing，没有面向 Gemini 模型的永久免费 Token 层。
- Global 区域价格大多与 Developer API 相同；Non-global 区域通常高约 10%；Priority 约为 1.8 倍；Batch/Flex 通常为 0.5 倍。
- 只有返回 HTTP 200 的请求收取输入/输出费用，4xx/5xx 不收费。
- 超过 200K 输入上下文时，所有输入和输出按长上下文价格计费。
- 2026-11-16 及以后注册或升级的账户，$300 Google Cloud 欢迎额度不能支付 Gemini 平台/Vertex AI 费用；Gemini API in AI Studio 也被排除。

### 4. 四套额度不能混用

| 额度 | 计量对象 | 不是什么 |
|---|---|---|
| Gemini App 订阅额度 | 计算量、模型、对话长度、文件大小等 | 不是 API Token |
| AI Studio 界面额度 | 模型/功能的界面使用量 | 不是 API key 的项目配额 |
| Gemini API 配额 | 项目级 RPM/TPM/RPD，按 Token 计费 | 不是消费订阅提示次数 |
| Google Cloud credits | 账单抵扣金额 | 不是调用次数，也不等于现金 |

美国个人计划附带的 Cloud credits：Pro $10/月、Ultra 5x $40/月、Ultra 20x $100/月。它们与 Gemini App 的“AI credits”也不是同一个东西。

---

## 八、中国大陆怎么订阅

### 1. 官方结论

**截至 2026-11-25，中国大陆没有官方开放的消费者 Gemini App / Google AI Plus / Pro / Ultra 订阅。**

官方 Gemini 可用地区页明确写有：

> “Mainland China (Workspace only)”

Google AI Pro 与 Ultra 的官方支持国家清单也均未列出中国大陆。因此：

- 普通个人账户不能依据官方规则在大陆正式订阅消费者套餐。
- 学生优惠、家庭共享、免费试用不能把大陆变成支持地区。
- 海外家庭管理员不能把 Pro/Ultra 共享给大陆家庭成员，因为家庭成员必须与管理员居住在同一国家。

### 2. 唯一带“Workspace only”的官方路径是什么

如果用户属于已购买 Google Workspace 的组织，且组织所在地区、合同、管理员策略均符合 Google 的 Workspace 规则，可以使用组织提供的 Gemini in Workspace。

这有几个限制：

- 属于企业/组织席位，不是个人 Gemini Pro/Ultra。
- 由组织管理员控制开通和策略。
- Business Starter 功能明显较少；Standard/Plus 才包含主要 Workspace 应用侧栏。
- 是否可签约、部署和使用哪些功能，以组织合同、管理员策略和 Google 地区规则为准。

Gemini Developer API / AI Studio 和 Vertex AI 也不以“消费订阅”形式向大陆个人用户提供；API 须遵守各自支持地区、账单与合规要求。

### 3. 账户地区、Play 地区、支付资料是三件事

| 项目 | 主要作用 | 官方规则 |
|---|---|---|
| Google Account 国家/地区 | 服务提供主体、适用条款、地区性要求 | 新账户按创建地；满一年账户通常按过去一年主要使用地区；可提交更正申请 |
| Google Play 国家/地区 | Play 商店内容与 Play 结算 | 首次设定后及后续变更之间至少 90 天；须身处目标地区并有当地支付方式 |
| 支付资料国家/地区 | 支付方式、税务、结算 | 通常不能直接改；搬家/旅行后需新建支付资料；新资料不会自动迁移现有服务 |

Account 地区自动更新在搬家后可能要约一年；官方没有公布手动更正申请的固定处理时限，不能把它写成“一年只能改一次”。

Play 地区变更不会自动迁移现有订阅。官方称旧订阅通常继续绑定旧支付资料；新国家也可能不提供该订阅。Play 余额不能跨新旧国家使用，Play Points 会清零，部分已购内容可能失去访问权。

### 4. 网络访问不等于订阅资格

Google 官方 FAQ 明确承认网络环境可能干扰账户地区判断，但没有说网络环境会立即改变账户地区，或能替代居住地、支付资料和产品支持地区核验。

Gemini 隐私说明写明会使用 IP 大致区域、账户 Home/Work 地址及设备精确位置。Ultra 的官方旅行限制最直接：

> “If you travel from a country where Google AI Ultra is available to a country where it is not available … you won't be able to upgrade or use Ultra until you return to a country where Ultra is supported.”

Pro 用户短暂前往不支持地区时是否立即停用，官方没有同等明确表述，不能直接套用 Ultra 的规则。但 Pro 本身也有独立国家清单，中国大陆不在其中。

### 5. 支付方式与风险边界

#### 网页订阅与 Google Play 结账

| 渠道 | 官方通用付款方式 | 需要注意 |
|---|---|---|
| Google One 网页 | 信用卡；银行账户（仅美国）；PayPal；Google Play 余额（仅部分国家/地区） | 支持清单只写“信用卡”，但同页新增付款方式步骤写“信用卡或借记卡”，存在表述冲突；实际选项依账户地区和支付资料显示 |
| Google Play | 信用卡/借记卡、运营商账单、Play 余额/礼品卡充值、PayPal、部分国家/地区本地支付方式 | “Available payment methods vary by country”；部分运营商不能支付订阅；Play 余额用于订阅也有地区限制 |

例如，Google Play 香港官方页面列出 UnionPay、AliPayHK、Octopus、PayPal 等，但这是**香港地区页面**，不能据此认定大陆用户可以使用大陆版支付宝或微信支付购买 AI Pro/Ultra。

#### 大陆用户相关的支付结论

| 项目 | 官方核查结论 |
|---|---|
| 中国大陆发行银行卡 | **未确认**。官方按国家/地区和卡组织列示，没有“大陆发行银行卡”支持名单；也不能仅凭名单缺失断言所有大陆卡在一切情形下绝对不可用 |
| 大陆版支付宝 | **未确认**。Google One 清单没有支付宝；Play 香港页面写的是 AliPayHK，不等同于大陆支付宝 |
| 微信支付 | **未确认**。本次核查的 Google One、Google Play、Google Pay 官方帮助没有微信支付购买 AI Pro/Ultra 的明文 |

Pro/Ultra 的官方支持地区名单不含中国大陆，因此即使某张卡在技术上能通过授权，也不等于大陆消费者有正式订阅资格。

#### 礼品卡、Play 余额与虚拟卡

- Google Play 礼品卡兑换后进入 **Google Play balance**，不是独立的订阅支付工具。
- Google One 网页清单中的 Play 余额仅限部分国家/地区。Play 官方还写明“部分订阅不接受 Stored Value”：按访问日表格，美国未把 subscriptions 列入可用范围，澳大利亚则列出 subscriptions。
- 因此，礼品卡/余额能否支付 AI Pro/Ultra **必须看账号的 Play 国家和结账页实际选项**，不能给出统一的“能/不能”。
- Split Payment（余额＋另一支付方式）仅用于首次订阅或升级支付；后续续费只使用主支付方式及备用支付方式，不再自动拆用余额。
- **Google Play 官方明确不支持虚拟信用卡（VCC）。**
- 官方没有“所有境外实体卡一律禁止”的统一表述；境外实体卡能否使用取决于发行国、卡组织、卡种、账号国家和具体产品。

#### 风险边界

- 海外实体卡或第三方账单即使偶然能完成付款，也不代表产品在当地正式支持；还可能遇到卡组织、发卡行、3-D Secure、账单国家和风控限制。Google Play 明确不支持虚拟信用卡。
- Google 条款写明并非所有服务在所有国家提供，并禁止绕过系统/保护措施，以及为违约而隐藏或虚报身份。
- 没有找到“仅使用某种网络环境即违规”的专门条款；但以技术手段隐藏真实所在地、虚假居住资料或虚报支付地区规避支持范围，可能落入一般条款。这是基于条款文本的解释，不构成法律意见。
- 风险包括付款失败、订阅被取消、退款困难、账户安全验证、家庭组和 Play 余额受限等。本报告不提供任何绕过步骤。

### 6. 给大陆用户的官方口径总结

| 想使用的东西 | 官方状态 | 说明 |
|---|---|---|
| 消费者 Gemini App 免费版 | 不支持普通个人消费版本 | 地区页只列 Workspace |
| AI Plus / Pro / Ultra | 不支持 | 无正式订阅入口 |
| Gemini in Workspace | 仅组织路径 | 需符合 Workspace 合同、地区和管理员规则 |
| AI Studio / Gemini API | 不在官方支持地区名单 | 不是消费订阅的替代入口 |
| 海外账户 + 海外支付 | 不等于官方支持 | 有条款、风控与持续使用风险 |

---

## 九、订阅前核对清单

1. **实际地区**：当前居住/使用地区是否在产品官方支持名单？
2. **产品类型**：买的是个人订阅、Workspace 席位，还是 API 用量？
3. **账户与支付**：Account 地区、Play 地区、支付资料是否一致？
4. **附属功能**：模型、Notebook、Chrome、YouTube、视频等是否有独立地区/年龄限制？
5. **账单规则**：月付/年付、试用自动续费、取消时间、退款规则是否确认？
6. **额度口径**：看到的是计算量、credits、Token、GB/TB 存储，还是席位？
7. **数据条款**：免费层与付费层的数据使用、人工审核、保留规则是否清楚？

---

## 十、来源与变化提示

### 消费级

- [美国 Google AI 方案页](https://one.google.com/intl/en_us/about/google-ai-plans/)
- [英国方案页](https://one.google.com/intl/en_uk/about/google-ai-plans/)
- [香港方案页](https://one.google.com/intl/en_hk/about/google-ai-plans/)
- [台湾方案页](https://one.google.com/intl/zh-TW_tw/about/google-ai-plans/)
- [Gemini Apps 限额与功能可用性](https://support.google.com/gemini/answer/16275805?hl=en)
- [Gemini 模型说明](https://support.google.com/gemini/answer/18648722?hl=en)
- [Notebook 套餐](https://support.google.com/gemininotebook/answer/16213268?hl=en) / [Notebook 用量](https://support.google.com/gemininotebook/answer/17670842?hl=en)
- [视频生成](https://support.google.com/gemini/answer/16126339?hl=en) / [Search 图像额度](https://support.google.com/websearch/answer/16649374?hl=en)
- [Chrome 可用性](https://support.google.com/gemini/answer/17140089?hl=en) / [Chrome auto browse](https://support.google.com/gemini/answer/16821166?hl=en)
- [学生优惠公告](https://blog.google/innovation-and-ai/products/gemini-app/student-offer-google-ai/) / [学生优惠帮助](https://support.google.com/googleone/answer/17422238?hl=en)
- [家庭共享](https://support.google.com/googleone/answer/9004015?hl=en) / [取消管理](https://support.google.com/gemini/answer/14517446?hl=en)

### Workspace 与 API

- [Workspace Business editions](https://knowledge.workspace.google.com/admin/getting-started/editions/business-editions)
- [Workspace 定价](https://workspace.google.com/pricing)
- [Workspace AI 用量限制](https://knowledge.workspace.google.com/admin/generative-ai/workspace-with-gemini/about-ai-usage-limits)
- [AI Expanded Access](https://knowledge.workspace.google.com/admin/generative-ai/workspace-with-gemini/ai-expanded-access)
- [Gemini API 定价](https://ai.google.dev/gemini-api/docs/pricing)
- [API 限额](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Batch API](https://ai.google.dev/gemini-api/docs/batch-api)
- [Context caching](https://ai.google.dev/gemini-api/docs/caching?generate-content=true)
- [Vertex AI 定价](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [AI Studio Billing](https://ai.google.dev/gemini-api/docs/billing) / [API keys](https://ai.google.dev/gemini-api/docs/api-key) / [Additional Terms](https://ai.google.dev/gemini-api/docs/terms)

### 地区、账户与条款

- [Gemini 可用地区](https://support.google.com/gemini/answer/13575153?hl=en)
- [Pro 可用地区](https://support.google.com/googleone/answer/16476811?hl=en)
- [Ultra 可用地区](https://support.google.com/googleone/answer/16476748?hl=en)
- [Google Account 地区 FAQ](https://policies.google.com/faq?hl=en)
- [Google Play 国家/地区](https://support.google.com/googleplay/answer/7431675?hl=en)
- [支付资料管理](https://support.google.com/googlepay/answer/7644003?hl=en)
- [Google One 付款方式](https://support.google.com/googleone/answer/9003634?hl=en)
- [Google Play 付款方式](https://support.google.com/googleplay/answer/2651410?hl=en)
- [Play 余额订阅适用地区](https://support.google.com/googleplay/answer/6080850?hl=en)
- [Google One 退款规则](https://support.google.com/googleone/answer/9056360?hl=en)
- [Google 服务条款](https://policies.google.com/terms?hl=en)，2026-07-30 生效
- [Google Play 服务条款](https://play.google.com/about/play-terms.html)，2026-07-29 版本
- [Google One 附加条款](https://one.google.com/terms-of-service)，2026-10-01 最后修改

以上页面访问日期均为 **2026-11-25**。帮助页未标更新日时，以访问日期为准。

### 尚未确认

- 英国、香港、台湾 Pro 的确切年付金额。
- 上述地区 AI Plus 的标准价与完整权益。
- Pro 是否拥有 Search AI Mode Carbon。
- Project Genie 的 Ultra 档位。
- 香港 Notebook 与部分 Workspace AI 附属功能。
- 中国大陆 Notebook 与基础 Chrome 的官方可用性；现有清单未列，不能据此直接判定不可用。
- Gemini App、Notebook、Deep Research 的精确每日次数；目前官方以动态计算限制为主。
- Google Account 手动地区更正申请的固定处理时限。
- 具体账户实际显示的付款方式，以及 AI Pro/Ultra 在 Google Play 的专属完整支付清单；官方只提供通用规则。
- 大陆银行卡、大陆版支付宝、微信支付用于 AI Pro/Ultra 的官方支持范围；未取得支持明文。

更完整的摘录、置信度和截图索引见同目录 `sources.md` 与 `browser/`。
