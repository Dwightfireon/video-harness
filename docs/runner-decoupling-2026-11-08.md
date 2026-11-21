# 执行器解耦：opencode 当大脑，vh 当手脚

2026-11-08。这一轮把「谁写作者稿」从 vh.mjs 里拆出来，变成一个可替换的执行器层，
并补上选题队列与批量发布。

## 为什么改

原有 `lib/agent.mjs`（2768 行）是一个自建的模型循环：

- 一个视频项目约 100–200 次串行 HTTP 请求；任何一步两次重试都失败，整个任务中断，
  只能靠 `vh ask --resume` 从头恢复上下文。
- 联网只有一个 `fetch_url`，参数是 URL 而不是关键词——**必须事先知道网址**。
  所以「我只有一个想法」这个入口实际是按模型记忆写稿，不是真的调研。

opencode 已经解决这两件事：会话持久化与 `-s <id>` 续跑、服务端重试与上下文压缩，
以及 `websearch` / `webfetch` 工具。实测：

```
opencode run --format json --auto -m opendesign/deepseek-v4.1-flash \
  "用 websearch 搜索「DeepSeek V4 发布」"
→ firecrawl 返回 8 条带标题与 URL 的真实结果
```

## 分层

```
用户：一个选题
  ↓
opencode session（可续跑、有搜索）
  ├─ websearch / webfetch   → 搜资料，存 research/
  ├─ read / write / edit    → 写 方案.md / 脚本.md / scenes.src.js
  └─ shell                  → node vh.mjs build / measure / render / voice / pack
  ↓
vh（确定性命令层，不碰模型）
```

分工原则：**确定性的（渲染、配音、字幕、打包）留在 vh；需要判断的（搜什么、怎么写、
画面怎么设计）交给 opencode。**

`vh.mjs` 的 80 多个命令全部不用改。改的是中间那层派发，以及提示词从 CLI 入口搬出去。

## 新增模块

| 文件 | 职责 | 依赖 |
|---|---|---|
| `lib/runners/index.mjs` | 选哪个执行器；读写 `PROJECT.json.runner` | 只读配置 |
| `lib/runners/opencode.mjs` | 起 `opencode run --format json`，翻事件流，记 session id | node:child_process |
| `lib/runners/local.mjs` | 包一层原有 `runAgent`，作离线兜底 | lib/agent.mjs |
| `lib/task-prompts.mjs` | 各模式的任务提示词 + 拼装本轮完整指令 | lib/publish.mjs |
| `lib/schedule.mjs` | 选题队列：读写、排序、状态推进 | 纯数据 |
| `lib/discovery.mjs` | 用 opencode 搜候选选题，只入队 | 调 opencode |
| `scripts/schedule-daemon.mjs` | 定时取一支、建工程、派发、结算 | 调 vh.mjs |
| `desk/batch.mjs` | 批量投稿编排：顺序、间隔、失败即停 | 纯逻辑 |

### 契约

两个 runner 的 `run()` 返回同一个形状：

```js
{ ok, status, answer, error, warns, sessionId }
```

状态仍写同一份 `out/.vh-task.json` 与 `out/.vh-chat.log`，所以**工作台、发布台、
任务恢复、自动修复预算都不需要知道是谁跑的**。

### 选择顺序

`VH_RUNNER` 环境变量 > `PROJECT.json.runner` > 默认 `local`。

默认 `local` 是为了兼容：已有工程与测试只配了显式渠道凭据，换成 opencode 会改变
它们实际访问的端点和行为。**新工程由 `vh new` 写入 `runner: opencode`。**

```bash
node vh.mjs runner                      # 看当前执行器与可用性
node vh.mjs runner --set opencode       # 切换
node vh.mjs runner --set local          # 退回离线循环
node vh.mjs runner --json               # 给脚本读
```

## 权限边界

`--auto` 的语义是「自动批准所有没被明确拒绝的」。所以删除类命令必须在 agent 定义里
**显式 deny**，不能靠提示词。

`.opencode/agents/vh-builder.md` 里拒绝：

```
rm -r* / rm -R* / rm -f* / rmdir *
node vh.mjs rm* / prune*trash-all* / prune*--all* / dist*--purge* / clean*
git push* / git reset --hard* / sudo * / brew * / chmod -R * / dd * / mkfs*
external_directory: *
```

实测：让 agent `rm -rf out/segtest`（目录真实存在）会被工具层拒绝，模型自己也会说明
「这属于我的硬边界」。两条防线都在。

## 选题队列

```bash
node vh.mjs schedule                              # 看队列
node vh.mjs schedule --add "选题一句话"            # 加
node vh.mjs schedule --remove <id>                # 移除（不动已完成的项目）
node vh.mjs schedule --limit 3 --interval 30      # 每日上限 / 检查间隔
node vh.mjs schedule --discover --discover-query "本地大模型" --discover-count 3
```

派发：

```bash
node scripts/schedule-daemon.mjs --once       # 跑一轮（适合 cron / launchd）
node scripts/schedule-daemon.mjs              # 常驻，按 intervalMinutes 检查
node scripts/schedule-daemon.mjs --dry-run    # 只打印会做什么
node scripts/schedule-daemon.mjs --discover    # 只找选题，不派发
```

规则：

- 只有 `pending` 会被派发；`running` 未过租期时不再派，过租期只标记可回收，**不自动重跑**。
- 达每日上限后不再派。
- 队列见底且开了 `discoveryConfig.enabled` 才自动找选题；找选题失败只记日志。
- 完成判断不看退出码，看 `out/.vh-task.json` 的 `status === "completed"`。暂停或中断都算没交付。

工作台首页也能操作同一份 `schedule.json`（加/删/配置/现在搜一批）。

## 批量发布

发布台左侧项目列表加了勾选框，勾选后「自动发布已选」按顺序逐条投稿：

- 间隔 2–120 秒（默认 3 秒），防止连发触发风控。
- **任何一条失败立即停止**，后面的不提交，不自动重试。
- 每条复用单条投稿用例，分区沿用当前表单的选择。
- 仍需界面确认；投稿提交后无法在发布台撤回。

`desk/batch.mjs` 是纯逻辑，`sleep` 与 `submitOne` 都可注入，不需要真实投稿即可测。

## 验证

```
node scripts/test.mjs        # 1573 项，全通过
```

新增 16 项覆盖：批量发布顺序/间隔/失败即停/中止/汇总、队列去重与上限、
选题发现解析与过滤、派发指令拼装、执行器选择、opencode 事件流解析。

真实链路验证（本机，非测试替身）：

- `node vh.mjs ask "只回复 OK"` → 3 秒完成，`out/.vh-runner.json` 记录 session id。
- `node vh.mjs ask --resume` → 「↻ 接上上次的 opencode 会话」，续跑成功。
- topic 模式实跑：调 websearch / webfetch 抓了 8 份资料进 `research/`，
  包括 NCC Group 的 CVE-2024-28224 公告与 SentinelOne 的 Ollama 主机扫描报告。

## 未验证

- 没有从零跑完一整支视频（选题 → 成片）。真实制作耗时与失败点还没实测。
- opencode 的 `--agent vh-builder` 只在项目目录内可见；换目录会回落到内置 agent，
  提示词里的制作规则也随之失效。这是 opencode 的 project-local agent 语义。
- 批量发布没有真实投稿过（账号未授权，且投稿不可撤回）。
- 定时派发没有配 launchd / cron，只验证了 `--once` 与 `--dry-run`。
