# Gemini 套餐调研 · 消费者层级证据整理

核查日期：2026-11-25。本节只讨论个人 Google Account 使用的 Gemini App 与 Google One 消费级订阅，不包含 Workspace 席位和 API 账单。

## 一、先看结论

1. 当前美国消费层级不只“免费版 + Pro/Ultra”，还有 **Google AI Plus**。完整顺序是：免费版 → Plus → Pro → Ultra 5x → Ultra 20x。
2. Gemini App 的“2 倍、4 倍”是相对免费版的**计算用量**；Ultra 5x/20x 的“5 倍、20 倍”是相对 **AI Pro**。它们都不是固定消息条数，也不是 API Token。
3. Pro 可月付或年付；Ultra 5x/20x 目前只支持月付。
4. 中国大陆官方仅支持 Workspace，不提供消费者 Gemini App、AI Plus/Pro/Ultra。
5. 套餐可购买，不等于所有附属功能在该地区都可用。模型、Chrome、Notebook、YouTube 等权益各有自己的地区和年龄门槛。

## 二、价格与账单周期

### 1. 各地官方标准月付价

| 地区 | AI Plus | AI Pro | Ultra 5x | Ultra 20x |
|---|---:|---:|---:|---:|
| 美国 | $4.99/月 | $19.99/月 | $99.99/月 | $199.99/月 |
| 英国 | 未在本次公开页面确认 | £18.99/月 | £79.99/月 | £189.99/月 |
| 中国香港 | 未在本次公开页面确认 | HK$158/月 | HK$799/月 | HK$1,588/月 |
| 中国台湾 | 未在本次公开页面确认 | NT$650/月 | NT$3,300/月 | NT$6,500/月 |
| 中国大陆 | 不提供消费者订阅 | 不提供 | 不提供 | 不提供 |

以上为官方当地标价，不是汇率换算；是否含税及最终金额以账户账单地区和结账页为准。美国页面当时有“黑五最高 50%”的账户定向促销横幅，本报告不把促销价当标准价。

### 2. 年付与促销

- **AI Pro 美国年付：$199.99/年**，约合 $16.67/月。
- 官方帮助确认部分地区 Pro 有年付选项，但匿名访问的英国、香港、台湾页面没有显示确切年付金额，本报告不推算。
- **Ultra 5x/20x 仅月付**。美国官方页原文：“Ultra plans are billed monthly only”。
- 学生优惠、家庭共享和定向试用另受资格限制，不能把宣传横幅理解为所有账户自动享有。

## 三、免费版到底包含什么

### 包含

- Gemini 4 Hydrogen；Auto 模式会在 Hydrogen 与轻量快速模型之间路由。
- 图像生成与编辑，主要使用 Nano Banana 2。
- Deep Research、Gemini Live、Canvas、Skills、Storybook、Connected Apps、测验/闪卡、音频概览、屏幕自动化、幻灯片生成、音乐生成等入口。
- Gemini Notebook（原 NotebookLM）基础版。
- Google Flow 的有限创意功能，包括有限的 Nano Banana Pro 使用。
- Google Account 基础 15 GB 存储。

### 限制

- 用量按**计算量**计算。提示词复杂度、模型、思考强度、对话长度、附件大小都会影响消耗。
- 额度通常每 **5 小时**刷新，达到每周上限后需等待重置。
- 上下文窗口 **32K tokens**；Pro/Ultra 为 **1M tokens**。
- **Gemini App 内视频生成需要付费 AI 套餐**，免费版不能使用。
- 免费版没有 Nano Banana Pro 的“Redo with Pro”、Daily Brief、Scheduled Actions 等付费功能。
- Deep Research 有每日与并发限制，但官方未公开统一的“每天 N 次”，高需求时可能先受限。
- 免费个人账号只有在美国可使用部分基础 Gmail AI 功能，例如 Help me write、Suggested Replies；这不等于完整 Workspace AI。

**理解要点：**“有功能入口”不等于“无限使用”。免费版的限制主要来自动态计算额度、上下文长度和特定功能门槛，而不是简单的聊天条数。

## 四、Plus、Pro、Ultra 对比

| 项目 | AI Plus | AI Pro | Ultra 5x | Ultra 20x |
|---|---|---|---|---|
| 美国月付 | $4.99 | $19.99 | $99.99 | $199.99 |
| Gemini App 用量 | 免费版 2 倍 | 免费版 4 倍 | Pro 的 5 倍 | Pro 的 20 倍 |
| 上下文 | 128K | 1M | 1M | 1M |
| Gemini App 模型 | Hydrogen | Hydrogen、Neon | Hydrogen、Neon、Carbon | Hydrogen、Neon、Carbon |
| 存储 | 400 GB | 5 TB；部分地区/旧方案可能为 10 TB | 20 TB | 30 TB |
| Gemini Notebook | 更高界面额度；笔记本/来源数需以账号页面为准 | 500 个笔记本、每本 300 个来源 | 500 个、每本 500 个来源 | 500 个、每本 600 个来源 |
| Google Flow | 高于免费版，确切 credits 未在本次确认 | 1,000 credits/月 | 10,000 credits/月 | 25,000 credits/月 |
| Flow Music | 更高 | 10,000 credits/月 | 30,000 credits/月 | 30,000 credits/月 |
| 视频生成 | 可用；确切 credits 未在本次确认 | Gemini Omni Flash，通常 3–10 秒 | 同 Pro | 最长可到 15 秒 |
| YouTube | 依地区/套餐 | Premium Lite 个人版 | Premium Family | Premium Family |
| Colab | 依套餐 | 200 计算单元/月 | 1,000/月 | 2,000/月 |
| Google Cloud credits | 依地区/套餐，未统一确认 | $10/月（美国个人方案） | $40/月（美国） | $100/月（美国） |
| 家庭共享 | 最多 5 位家庭成员 | 同左 | 同左 | 同左 |

### 模型名怎么理解

- **Hydrogen**：当前免费版和 Plus 可使用的基础模型。
- **Neon**：2026-11-18 起向 Pro/Ultra 推出。
- **Carbon**：2026-11-10 起向 Ultra 推出。
- **Argon**：本次核验中主要出现在 API 和 Workspace AI Expanded Access 文档，不应据此写成消费者 Ultra 默认可用模型。

模型上线可能按账户、设备、年龄和地区灰度开放；具体以 Gemini 模型选择器为准。

### 官方页面冲突

Google Search 的 Carbon 帮助页写“仅 Ultra 18+”，部分 Google One 页面仍写 Pro 可在 AI Mode 使用 Carbon。**Pro 在 Search AI Mode 的 Carbon 权益置信度为中**，本报告不把它列为确定权益。

## 五、创作、研究与办公权益

### 1. 图像

- Gemini App：免费版可生成/编辑 Nano Banana 2；Pro/Ultra 可使用 Nano Banana Pro 的 Redo with Pro，并享有更高额度。
- Gemini App 没有统一公开的每日图像数量。
- **Search AI Mode** 有单独每日额度：免费 25 张、Plus 50 张、Pro 100 张、Ultra 1,000 张。
- Search 图像额度不能当作 Gemini App 图像额度。

### 2. 视频

- 个人账号的视频生成需要付费 AI 套餐。
- 视频通常为 3–10 秒；Ultra 最长可到 15 秒。
- 英国、EEA、瑞士及部分美国州暂不支持上传视频进行编辑，或创建/分享 avatar。
- 视频能力还受 Flow/Gemini 各自 credits 与地区限制影响。

### 3. Deep Research 与 Notebook

- Deep Research 的付费档位有更高额度，Ultra 可使用 Carbon，并支持图表、动画、交互式图示等输出。
- 当前 Notebook 对话、音频/视频概览等生成功能采用计算量限制，每 5 小时刷新至每周上限；笔记本数量与每本来源数则有明确上限。
- 印度、韩国、越南的 Notebook 输出仍会自动加可见水印。

### 4. Chrome 与 Workspace 应用

- **基础 Gemini in Chrome**：不要求付费套餐，13+，在支持地区逐步上线；美国、英国、香港、台湾在成人支持名单中。
- **Chrome auto browse**：目前仅美国和印度，18+，需要 Chrome 144+。Pro/Ultra 包含该权益，但英国、香港、台湾当前不能使用。
- **Gemini in Gmail、Docs、Drive、Sheets、Slides、Meet、Vids**：Pro/Ultra 面向个人账号提供广泛 AI 功能；语言按具体功能划分。
- 官方 Workspace Experiments 国家清单包含美国、英国、台湾，不包含香港和中国大陆。因此“买了套餐”不等于该地区的每个 Workspace AI 子功能都开放。

## 六、学生优惠、家庭共享、试用与取消

### 学生优惠

官方 2026-08-19 学生方案，兑换截止 2026-12-31：

- **美国**：符合资格大学生可免费使用 Google AI Pro **12 个月**；需要有效支付方式；不取消则到期自动按 $19.99/月续费。
- **美国以外**：符合资格学生可免费使用 Google AI Plus **12 个月**；英国、台湾符合公开地区条件；香港、澳门明确排除；到期自动按当地 Plus 月费续费。
- 部分地区的 Pro + YouTube Premium 学生组合最高约 70% 折扣，最长 4 年；美国示例 $8.99/月。
- 须通过 SheerID 验证，个人账号、18+；学校签发账号、家庭群组成员、第三方/Pixel Pass/Fi 用户不符合资格。
- **没有找到官方 Ultra 学生优惠。**

### 家庭共享

- 最多共享给 **5 位家庭成员**，共 6 个账号。
- 成员必须与方案管理员居住在**同一国家**，不能跨国共享。
- 存储、Gemini App、Gemini Notebook、Antigravity 等 AI 权益和 AI credits 可共享。
- **Flow、Antigravity 等部分额度按家庭共享池计算**，不是每人独立额度。
- Pro 的 YouTube Premium Lite、Google Home Premium、Developer Program Premium、Colab 等不可共享或仅管理员可得。
- 文件本身保持私密，不因共享存储而互相可见。
- 未成年人能否使用全部 AI 功能受年龄限制；英国、EEA、瑞士使用付费 Gemini App 须 18+。

### 免费试用

- 当前存在账户/地区定向试用，没有可保证的全球统一试用时长。
- 必须在试用结束前取消，否则按所在国标准月付或年付价自动收费。
- 试用权益可能与正式付费不同，例如部分 Google One 试用不含 Colab、Antigravity、YouTube Premium/Lite。
- 是否有试用、试用几天，以登录后的 Google One/Play 订阅页为准。

### 取消与续费

- 可随时通过 Gemini Settings → Manage subscription 或 Google One → Cancel membership 取消。
- 自动续费，直到取消；取消会停止未来付款。
- 存储和付费权益通常持续到当前计费周期结束，之后才失效。
- 大多数国家/地区的 Google One 存储计划购买不可退款；EEA、英国、瑞士、以色列、韩国有官方例外。
- 已有独立 YouTube Premium/Lite 不会因订阅 Pro 自动取消。
- Ultra 不能通过第三方集成账单商购买；已有第三方或 Apple 订阅通常需先取消才能切换。

## 七、地区可用性速查

| 地区 | 消费者免费版 | Plus/Pro/Ultra | Notebook | Chrome 基础 / auto browse | 个人 Workspace AI | 学生优惠 |
|---|---|---|---|---|---|---|
| 美国 | 可用 | 可用 | 可用 | 可用 / 可用 | 可用 | Pro 免费 12 个月 |
| 英国 | 可用 | 可用 | 可用 | 可用 / 不可用 | 可用；部分视频功能受限 | Plus 免费 12 个月；Pro 组合优惠 |
| 中国大陆 | **仅 Workspace** | **不可用** | 未确认；官方支持清单未列 | 未确认；官方支持清单未列 | 消费者套餐不可用 | 不可用 |
| 中国香港 | 可用 | 可用 | 官方支持清单未列香港 | 可用 / 不可用 | Workspace Experiments 清单未列香港 | 明确排除 |
| 中国台湾 | 可用 | 可用 | 可用 | 可用 / 不可用 | 可用 | Plus 免费 12 个月；Pro 组合优惠 |

其他地区权益差异：

- YouTube Premium Lite with Pro：美国、英国、香港、台湾均在官方支持名单。
- Ultra YouTube Premium Family：上述四地均在名单。
- Google Health Premium：美国、英国、台湾支持；香港不支持。
- Google Home Premium：美国、英国支持；香港、台湾不支持。

## 八、未确认项

1. 英国、香港、台湾 Pro 的确切年付金额。
2. 香港、台湾、英国 AI Plus 的公开标准价与完整权益。
3. Pro 是否拥有 Search AI Mode Carbon。
4. Project Genie 的 Ultra 档位：美国/全球部分页面写“Ultra 专属”，英国、香港、台湾页脚写“仅 Ultra 20x”。
5. 香港 Notebook 与部分 Workspace AI 附属功能。
6. 中国大陆 Notebook 与基础 Chrome 的官方可用性；现有清单未列，不能据此直接判定不可用。
7. Gemini App、Notebook、Deep Research 的精确每日次数；当前官方以动态计算限制为主。
