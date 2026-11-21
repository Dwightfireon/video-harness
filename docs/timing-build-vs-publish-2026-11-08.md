# 定时与手动：生成、发布是两个开关

2026-11-08。

## 原来错在哪

上一版只有一个 `schedule.json` 的队列节奏（`intervalMinutes` + `dailyLimit`），
装上 launchd 后每 30 分钟检查一次，有 pending 就开工。这带来两个误解：

1. **「定时」被理解成「自动一直做」**。用户想要的是「每天某个时段可以做」，不是随时开工。
2. **生成和发布绑在一起**。用户想「晚上 8 点发」，并不等于同意「随时做」。

## 现在的模型

两个开关，**默认都关**：

| 开关 | 管什么 | 默认 | 时段 |
|---|---|---|---|
| `build` | 什么时候开始做片子 | 关 | 09:00–23:00，每天最多 3 支，间隔 ≥120 分钟 |
| `publish` | 什么时候把做好的发出去 | 关 | 20:00–22:00，每次最多 1 支 |

关着时的语义：

- `build` 关 → 只有你点「开始做视频」才做。队列只是待办清单。
- `publish` 关 → 只有你在发布台点「提交投稿」才发。

两者完全独立：开 build 不影响 publish，反之亦然。测试里专门断言了这一点。

## 为什么默认关

自动化不是默认值。用户没说"每天几点做"的时候，程序不该自己决定什么时候消耗模型额度、
什么时候往 B 站发东西。默认关还带来一个好处：第一次用的人看到的就是"我做一支"，
而不是"它会不会突然开始跑"。

## 实现

`lib/timing-plan.mjs` 只做判断，不启动任何东西：

```js
shouldBuild(queue, now)    // → { ok, reason, message, item? }
shouldPublish(queue, ready, now)  // → 同上
```

`reason` 是可枚举的：`disabled` / `outside-window` / `running` / `daily-limit` / `gap` / `empty`。
每个都对应一句人话，界面直接显示，不在前端重算时间窗口。

`scripts/schedule-daemon.mjs` 每轮先问 `shouldBuild`，不通过就不派发并记日志：

```
[16:28:42] 本轮不生成（定时生成未开启）
```

launchd 的 30 分钟只是「多久看一次」，不是「多久做一支」。真正的频率由窗口 +
每日上限 + 最小间隔共同决定。

## 界面

选题队列顶部并排两张卡：

```
┌─ 定时生成 ────────── 关 ─┐  ┌─ 定时发布 ────────── 关 ─┐
│ ○ 只在时段内自动开工      │  │ ○ 和生成互不影响          │
│ [20:00] 到 [23:00]       │  │ [20:00] 到 [22:00]        │
│ 每天最多 [3] 支           │  │ 每次最多 [1] 支           │
└─────────────────────────┘  └─────────────────────────┘
```

状态文字来自后端 `describePlans()`，说的都是「现在会发生什么」，不是机制：

- `关（你点「开始做」才做）`
- `开着，等 20:00 开始`
- `开着，当前在时段内（20:00–23:00）`

队列尾部的结论也跟开关一致：定时关着时说「下一支待做（需要你点开始做）」，
不假装它会自己做。

## CLI

```bash
node vh.mjs schedule                        # 看队列与两个开关
node vh.mjs schedule --build-on --build-from 20:00 --build-to 23:00
node vh.mjs schedule --publish-on --publish-from 20:00 --publish-to 22:00
node vh.mjs schedule --build-off --publish-off
```

`--build-*` 与 `--publish-*` 互不影响；不传的那一侧保持原值。

## 验证

`test/timing-plan.test.mjs` 10 项：时间解析、跨午夜窗口、默认关、
生成与发布互不影响、每日上限、最小间隔、空队列、保存不破坏队列内容。

全量 `node scripts/test.mjs`：1605 项，全通过。

## 没做的

- **定时发布没有真的跑过**。`shouldPublish` 只被单测覆盖，没有接进任何 daemon。
  要让它真的在 20:00 发，需要给 schedule-daemon 加发布分支并接上 `publish-api`，
  这轮没做——因为发布涉及账号风控，值得单独一轮验证。
- **启动器已卸载**。`launchctl bootout` 后 plist 还在 `~/Library/LaunchAgents`，
  重新启用用 `./scripts/install-scheduler.command`。
