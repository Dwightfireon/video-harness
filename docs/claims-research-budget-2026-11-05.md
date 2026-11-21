# 核证预算与「用户提供原文」通道 · 2026-11-05

> 本文保留早期观察。表中的「模型」是消息区间减工具时间的粗略残差，**不是纯模型推理耗时**，也未证明提示改动单独造成制作提速。后续固定 8 次提示已撤销；当前执行端防循环及验证范围见 [通用流程加固](pipeline-hardening-2026-11-05.md)。

## 问题（真实事故）

`ses_e554a225…`「中国求职渠道转视频」：用户**给了 4,683 字完整文章**，制作会话从 15:57 跑到 16:05，
51 条助手消息、66 次工具调用，**没有写出方案、脚本、claims，也没有任何画面**。

实测时间分布：

| 阶段 | 消息数 | 总耗时 | 工具 | 模型 |
|---|---:|---:|---:|---:|
| 读文档 / 建项目 / 读引擎 API | 12 | 89 s | 8 s | 81 s |
| **事实核证（反复搜索）** | **38** | **439 s** | 86 s | **352 s** |

其中 82% 是模型推理，而推理几乎全花在核证：44 次搜索/抓取。

模型自己的推理已经判断出「文章就是用户的来源」，但每次要动手时又被「harness requires claims.json
with at least one verified claim」拉回搜索循环。它去核的是文章里两句 2026 年政策细节：
「百日千万招聘专项行动」「五部门招转培/培训贷风险提示」。过程：

- Bing 中文查询被分词打散，返回「招」「培训」词典词条
- 百度要求滑块验证
- `gov.cn` 搜索接口 404，两个按日期猜的链接也 404
- 最后靠猜 URL 命中了人社部原文，才结束这一轮

而这两句本来可以直接登记为 `user-provided`，或者从口播里删掉。

## 根因

1. **规则缺口（主因）**：`claims` 的阶段提示只写了 external 的字段规范，没写「用户提供了原文时怎么快速过」。
   文档里 `release-contract.md` 写「要求至少一条关键断言」，容易被读成「必须有一条 verified」。
2. **搜索环境不可靠**：中文搜索引擎对这类政策查询基本不可用，模型只能用最慢的浏览器兜底。
3. **没有预算概念**：提示里没有任何「查不到就停」的约束，模型默认要把每条都查成官方原文。

代码层面其实早就支持 `user-provided`（`lib/claim-evidence.mjs`）：
不需要 URL、不标 verified、只用本地 path + sha256 + locator + quote。实测 release 模式下
`{ok:true, findings:[]}`。问题不在能力，在**没有告诉模型这条通道存在**。

## 改动

| 文件 | 改动 |
|---|---|
| `lib/pipeline-work.mjs` | `draft_claims` 阶段提示开头新增「先定来源类型」段落：用户原文即主要来源、`research/原文.md`、user-provided 不需要 URL、不要全站核证；新增「核证预算：连续 2 次取不到就 unverified 或删掉」；新增可直接照抄的 user-provided 示例 |
| `AGENTS.md` | 「本次复盘后的默认做法」新增一条，把上述口径写进每次会话都会加载的总规 |
| skill `references/release-contract.md` | 明确「至少一条关键断言」可以用 user-provided 满足，并说明这不是绕过核证的漏洞 |
| skill `references/research.md` | 新增「用户已经给了原文时（文章改编）」小节，含本文事故记录 |
| `test/claims-readiness.test.mjs` | 新增回归测试，锁住这四件必须出现在提示里的事 |

## 边界（没有放宽的部分）

- external 事实仍必须有真实 URL、evidence 含 quote/type/checkedAt，读到才可标 verified
- user-provided **不能**标 verified（`claim-evidence.mjs` 会报 `claim-status`）
- 原文没写、又要说出口的具体事实仍按 external 处理
- 数字对账、来源指纹、发布契约、技术检查一概未动

## 验证

- `node --test test/claims-readiness.test.mjs test/pipeline-stall.test.mjs`：5 项通过
- 新增测试断言提示里必须出现：`research/原文.md`、`不标 verified`、`2 次`、`"sourceType":"user-provided"`
- 全量 `npm test` 结果见当轮输出

## 未验证

- 没有重新跑一次完整制作来实测「核证时间」下降多少；本轮只锁住规则，不声称具体秒数收益。
- 搜索环境本身没有改善；这条改动是让模型**尽早停止**，不是让它搜得更好。
