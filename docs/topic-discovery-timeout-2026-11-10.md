# 找选题超时：预算、看门狗与孤儿会话（2026-11-10）

## 现象

「发现选题」反复报超时。上一次修复针对的是 webfetch 单次超时（30 秒 → 允许模型传 60/90 秒），但超时仍然出现，而且换成更宽的预算也救不回来。

## 定位方法

opencode 的会话事件存在 `~/.local/share/opencode/opencode.db`（`session_v2` / `session_message`）。把 11-10 的三次找选题逐条重放，按工具调用拿真实耗时：

| 运行 | 开始 | 墙钟 | 模型轮次 | 工具等待 | 工具调用 | 失败 | 失败耗时 | 结果 |
|---|---|---|---|---|---|---|---|---|
| 成功 1（chatgpt、AI agent） | 15:03 | 348s | 272s | 77s | 25 | 5 | 34s | 保存 3 条 |
| 成功 2（chatgpt、AI agent） | 15:09 | 298s | 269s | 28s | 17 | 2 | 2s | 保存 2 条 |
| 失败（AI） | 16:26 | 1033s | 577s | 455s | 34 | 14 | **421s** | 判超时，全部丢弃 |

## 三个真实原因

### 1. 失败重试吃掉了 41% 的墙钟时间（主因）

失败那轮 14 次工具失败里，7 次是长超时：

```
30s  developers.googleblog.com/en/agent-distraction     (默认)
60s  同一 URL（模型传 timeout:60）
45s  同一 URL 换路径再试
60s  huggingface.co/moonshotai/Kimi-K3.1-Pro
75s  同一 URL 第 2 次（timeout:90）
76s  googleblog 第 3 次（timeout:90）
60s  axios.com/2026/11/05/...
```

合计 406 秒 = 480 秒预算的 85%。上一次「把单次超时放宽到 60/90 秒」正是把这个成本放大了一倍。

即使把 421 秒全部扣掉，这轮仍需 577 秒 + 34 秒 ≈ 611 秒，**照样超预算**。所以只改 fetch 超时永远救不回来。

结构性原因：

- 提示词只写「同一地址连续两次无法读取就换来源」，这是建议不是约束；
- 提示词只给**下限**（至少两个查询），没有上限，模型把调研扩到 34 次调用；
- `collectDiscoveryResearch()` 只记账，没有熔断。

### 2. 超时只杀了 CLI，服务和会话继续跑，成果被整批丢弃（致命次因）

`runOpencode` 起的是 `opencode run`（无 `--standalone`），它只是后台服务的客户端，会话循环跑在服务里。超时处理只做了 `kill(-pid, SIGTERM)`。

实测后果：

- 16:34:17 写回「480 秒内没收尾」，作业标 failed；
- 同一个 session 一直跑到 16:43:30；
- 16:42:17 它产出了 11842 字完整合法 JSON——这一轮其实成功，只是晚 8 分钟；
- 结果既进不了 stdout 也无法挽救，整批丢弃，0.133 USD 白花；
- `discoverTopics` 的 finally 立刻释放锁，用户可以马上再点 → 两个会话并发抢网络和配额，下一轮更容易超时。

### 3. 文案与实际预算不一致

预算 480 秒（lease 再加 120 秒），界面写「通常 3–5 分钟」。用户 5 分钟没结果就以为挂了，等真到 8 分钟又变成一次失败。

## 本次修改

`lib/discovery.mjs`

1. **中断两件事都做**：从事件流里取 `sessionID`，收手时先 `opencode api post /api/session/<id>/interrupt`，再收本地进程组。打不通不影响结果回写。
2. **流式看门狗**（1 秒心跳，不依赖事件到达）：三条提前收手条件，阈值按三次真实运行校准——成功两轮最长空窗 77/108 秒，失败那轮从 2 分半起就没有新原文、空窗涨到 321 秒。
   - 读原文失败 ≥ 8 次；
   - 读不到新原文 ≥ 150 秒且期间 ≥ 2 次失败；
   - 一篇原文都没读到、且已用 60% 预算。
3. **成果挽救**：收手时如果已有完整 JSON 且检索记录 ≥ 2，仍走同一套原文/日期校验保存，结果标 `salvaged`，并在 `warnings` 里写明「超出预算才完成」。不让一次超时把付过的钱清零。
4. **收手后等进程真的退出再交卷**（最多 5 秒），锁按轮次释放，避免用户在旧会话还活着时再点一次。
5. **提示词加硬上限**：6 次 websearch / 8 次 webfetch / 同一 URL 只读一次 / webfetch 超时固定 20 秒 / 用满一半预算就按已有材料收尾。下限（至少两个查询）保留。
6. **提示按故障类型分流**：读原文失败给「换官方公告、论文、原始数据」而不是笼统「检查网络」。

`lib/discovery-job.mjs`、`scripts/discover-topics.mjs`：超时文案改成真实区间（多数 4–5 分钟，8 分钟自动收手）；`salvaged` 会如实标注晚到。

`README.md`：「查找选题」补一段预算与看门狗的边界说明。

## 验证

新增 `test/discovery-watchdog.test.mjs`（6 个用例，全部用假 CLI，不联网）：

- 提示词硬上限存在，且下限没被删掉；
- 长时间读不到新原文时提前收手，且确实调用 `api post .../interrupt`；
- 始终读不到原文时按预算比例收手；
- 超时前已产出完整 JSON 时按原文校验保存，不整批丢弃；
- 正常收尾不触发中断，且答案取可解析 JSON 而不是最后一句旁白；
- 中断调用失败不影响结果回写与锁释放。

```
node scripts/test.mjs test/discovery-watchdog.test.mjs \
  test/topic-discovery.test.mjs test/topic-discovery-interaction.test.mjs \
  test/discovery-evidence.test.mjs test/discovery-boundaries.test.mjs \
  test/discovery-panel-ui.test.mjs test/discovery-integration.test.mjs \
  test/runner-batch-schedule.test.mjs test/topic-discovery-policy.test.mjs
# 104 pass / 0 fail
```

按会话记录回放，新门槛对三次运行的结果：

| 运行 | 是否触发 | 触发时点 | 原墙钟 |
|---|---|---|---|
| 成功 1 | 否 | — | 257s |
| 成功 2 | 否 | — | 221s |
| 失败 | 是（stall） | 405s | 955s |

## 未验证

- 没有对真实 opencode 服务实跑一轮找选题验证 `interrupt` 的实际效果（只在假 CLI 上验证调用路径与参数）；
- 提示词上限能否让模型稳定遵守，需要真实运行观察；
- 20 秒 webfetch 超时对慢站点的取舍尚未实测，可能让个别原本能读到的页面读不到。
