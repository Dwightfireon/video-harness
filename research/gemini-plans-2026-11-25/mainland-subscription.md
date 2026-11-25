# Gemini 套餐调研 · 中国大陆账户地区与订阅边界

核查日期：2026-11-25。本节只汇总官方规则与风险，不提供绕过地区限制的操作步骤，也不构成法律意见。

## 一、直接结论

**截至 2026-11-25，中国大陆没有官方开放的消费者 Gemini App / Google AI Plus / Pro / Ultra 订阅路径。**

Google 官方 Gemini 可用地区页明确写有：

> “Mainland China (Workspace only)”

因此需要区分三件事：

1. **网络能否访问**：技术与网络问题。
2. **账户是否有资格**：产品支持国家、账户地区、年龄、账户类型。
3. **能否完成付款与持续使用**：支付资料、当前所在地、账单地区、服务条款。

三者不能互相替代。“能打开网页”“有海外账户”“能绑卡”都不等于官方支持。

## 二、账户地区、Play 地区、支付资料不是一回事

| 项目 | 主要作用 | 官方规则 |
|---|---|---|
| Google Account 国家/地区 | 服务提供主体、适用条款、地区性要求 | 新账户按创建地关联；满一年账户通常按过去一年主要使用地区；可提交更正申请 |
| Google Play 国家/地区 | Play 商店内容与通过 Play 的结算 | 首次设定后及后续变更之间至少 90 天；须身处目标地区并有当地支付方式；更新最多 48 小时 |
| 支付资料国家/地区 | 支付方式、税务与结算 | 通常不能直接改；搬家/旅行后需新建支付资料；新资料不会自动迁移现有服务 |
| 产品支持地区 | 某项 Gemini 功能/套餐是否正式提供 | 以该产品或功能的官方国家清单为准 |

### Account 地区更新

- 新账户按创建账户时所在地区关联。
- 满一年账户通常按过去一年最常使用 Google 服务的地区关联。
- 短期旅行通常不会改变关联地区。
- 搬家后自动更新可能要约一年。
- 官方提供地区更正申请表，但公开资料没有写明固定处理时限或申请冷却期。

**不能把“约一年”写成“一年只能改一次”。** 那是自动重新关联的时间尺度，不是 Play 的 90 天规则，也不是官方公布的手动申请限制。

### Play 地区更新

- 当前官方规则是：首次设定后至少 90 天才能变更；后续每次变更也至少间隔 90 天。
- 变更时必须身处目标国家/地区，并有该国/地区的支付方式。
- 家庭组中的成员不能自行更改 Play 国家/地区。
- 改 Play 地区不会自动迁移现有订阅；官方称旧订阅通常继续绑定旧支付资料，除非取消。
- Play 余额不能跨新旧国家使用；Play Points 会清零；部分已购内容可能无法继续访问。

## 三、网络环境、IP 与账户资格

Google 官方 FAQ 明确承认网络环境可能干扰账户地区判断。账户地区主要依据创建地和过去一年的常用访问地区，而不是单次网络出口。

官方没有承诺：

- 仅改变网络出口就会立即改变账户地区；
- 可以任意指定账户国家；
- 网络环境能替代居住地、支付资料或产品支持地区核验。

Gemini 隐私说明还写明会使用 IP 大致区域、账户 Home/Work 地址及设备精确位置来判断所在地。

**Ultra 的官方旅行限制最明确：**

> “If you travel from a country where Google AI Ultra is available to a country where it is not available … you won't be able to upgrade or use Ultra until you return to a country where Ultra is supported.”

Pro 用户短暂前往不支持地区时是否立即停用，官方页面没有同等明确表述，不能直接套用 Ultra 的规则。但 Pro 本身也有独立支持国家清单，中国大陆不在其中。

## 四、家庭共享不能跨国家

- 家庭成员必须与家庭管理员**居住在同一国家**。
- 因此不能让海外管理员把 Pro/Ultra 共享给中国大陆家庭成员，作为官方订阅方案。
- 部分 AI 额度按家庭共享池计算；YouTube Premium Lite、Home Premium、Colab 等权益不可共享或仅管理员可得。
- 未成年人使用付费 AI 功能还受年龄限制；英国、EEA、瑞士要求 18+。

## 五、支付方式要点

- Google One 网页通用清单：信用卡；银行账户（仅美国）；PayPal；Google Play 余额（仅部分地区）。
- Google Play 付款方式随国家/地区变化；香港页面列有 UnionPay、AliPayHK、Octopus、PayPal 等，但不能把 AliPayHK 等同于大陆支付宝。
- 大陆发行银行卡、大陆版支付宝、微信支付用于 AI Pro/Ultra：均未取得官方支持明文。
- 礼品卡兑换后进入 Play 余额；余额只能在部分地区、且结账页提供选项时支付订阅。Split Payment 仅用于首次订阅或升级。
- Google Play 明确不支持虚拟信用卡（VCC）。
- 大多数国家/地区 Google One 购买不可退款；EEA、英国、瑞士、以色列、韩国有例外。
- 取消停止未来付款，权益通常到当前周期结束；试用结束会自动收费。

## 六、服务条款与风险

### 官方条款原文

Google《服务条款》：

> “But not all services mentioned may be available in your country.”

> “hacking or bypassing our systems or protective measures”

> “hiding or misrepresenting who you are in order to violate these terms”

违反条款的后果可能包括限制功能、暂停服务或删除 Google Account。

Google Play 条款也禁止规避、停用或击败用于限制内容访问的安全功能。

### 风险判断

- 没有找到通用条款专门规定“仅使用某种网络环境即违规”。
- 如果利用技术手段隐藏真实所在地、虚假居住资料、虚报支付地区来规避产品支持范围，可能落入“绕过系统/限制访问”或“为违约而虚报身份”的一般条款。
- 这是基于条款文本的解释，不是 Google 对每类网络环境行为作出的单独法律认定。
- 还可能产生付款失败、订阅被取消、退款困难、账户安全验证、家庭组和 Play 余额受限等实际问题。
- 不保证海外账户、海外卡或第三方支付能长期稳定使用。
- 本报告不评价具体绕过方式，也不提供操作步骤。

## 七、对中国大陆用户意味着什么

### 消费者套餐

- Gemini 免费版：官方地区页只给中国大陆标了 Workspace，普通个人消费者版本不在支持范围。
- Google AI Plus / Pro / Ultra：官方支持清单不含中国大陆，没有面向大陆个人账户的正式订阅入口。
- 学生优惠、家庭共享、免费试用同样不能把中国大陆变成支持地区。

### Workspace

- 如果用户属于已购买 Google Workspace 的组织，且管理员与组织所在地区符合 Google 的 Workspace 可用性规则，可使用组织提供的 Gemini in Workspace。
- 这属于企业/组织席位，不是个人 Gemini Pro/Ultra。
- Business Starter 的 Gemini 功能较少；Standard/Plus 才包含主要 Workspace 应用侧栏。
- Workspace 是否可签约、是否可部署、使用哪些功能，仍以组织合同、管理员策略和 Google 的地区规则为准。

### API / AI Studio

- Google AI Studio 与 Gemini Developer API 的官方支持地区名单不含中国大陆。
- Vertex AI 也须遵守 Google Cloud 的地区、账单和合规要求。
- 不能把消费订阅额度当作可在大陆直接调用的 API 额度。

## 八、订阅前应核对的五个问题

1. 当前产品是否在我的**实际居住/使用地区**正式支持？
2. 我的 Google Account、Play 地区、支付资料是否一致？
3. 我要的功能是否另有独立地区或年龄限制？
4. 付款方式、试用续费、取消和退款规则是否已确认？
5. 我购买的是个人订阅、Workspace 席位，还是 API 用量？

## 九、官方来源

- [Gemini 可用地区](https://support.google.com/gemini/answer/13575153?hl=en)
- [Google AI Pro 可用地区](https://support.google.com/googleone/answer/16476811?hl=en)
- [Google AI Ultra 可用地区](https://support.google.com/googleone/answer/16476748?hl=en)
- [Google Privacy & Terms FAQ](https://policies.google.com/faq?hl=en)
- [Google Account 地区更正申请](https://policies.google.com/country-association-form?hl=en)
- [Google Play 国家/地区](https://support.google.com/googleplay/answer/7431675?hl=en)
- [管理个人支付资料](https://support.google.com/googlepay/answer/7644003?hl=en)
- [家庭组规则](https://support.google.com/families/answer/6317858?hl=en)
- [Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961?hl=en)
- [Google 服务条款](https://policies.google.com/terms?hl=en)，2026-07-30 生效
- [Google Play 服务条款](https://play.google.com/about/play-terms.html)，2026-07-29 版本
- [Google One 附加条款](https://one.google.com/terms-of-service)，2026-10-01 最后修改
- [Google One 付款方式](https://support.google.com/googleone/answer/9003634?hl=en)
- [Google Play 付款方式](https://support.google.com/googleplay/answer/2651410?hl=en)
- [Play 余额可用于订阅的地区](https://support.google.com/googleplay/answer/6080850?hl=en)
- [Google One 退款规则](https://support.google.com/googleone/answer/9056360?hl=en)

以上页面访问日期均为 2026-11-25；未标更新日的帮助页以访问日为准。
