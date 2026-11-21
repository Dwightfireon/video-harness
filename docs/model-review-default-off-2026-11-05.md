# 自动模型审稿回退修复 · 2026-11-05

## 实际问题

用户已取消自动模型审稿，但本次制作仍被重新送入审稿，反复失败且未开始真实分镜。
这不是内容制作耗时，也不是渲染性能问题。不得把模型请求成功等同于整次审稿有效。

查到三个重新启用路径：

1. `vh new` 调用 `requireContentReview()`，强制写入 `required=true`。
2. `finishAuthorDraft()` 提交脚本时再次调用同一函数。
3. `contentReviewStatus()` 看到已存回执后强制把 `required` 设为 true；回执损坏时也无条件返回必审。

制作 Agent 的系统提示、README 和 AGENTS.md 同时仍要求先审稿，进一步强化了回退。

## 修改后的行为

- 新建和脚本提交仅初始化可选审稿（`required=false`），不自动启用，不发送审稿请求。
- 提交、改稿、续跑保留已有显式关闭状态；旧回执无权重启门槛。
- 默认制作 Agent 拒绝自动调用 `review_content`；用户明确主动选用 CLI 独立审稿时仍可使用，但不永久改变必审设置。
- 旧项目显式启用的审稿合同不静默覆盖。本次 `ai-four-2026-11` 按用户要求明确关闭。
- 可选审稿返修、过期或格式损坏仍如实显示，不伪造 pass；不阻塞正常制作。
- 媒体、字幕、测量、磁盘、画面技术检查与人工发布审阅不变。

## 验证与防回退

`test/content-review-optional.test.mjs` 覆盖真实 new CLI、重复 new、初始化与脚本重提交、旧回执损坏/过期、主动审稿返修、旧检查点续跑，以及 measure/render/voice/go/pack 仍执行技术拦截。
独立审稿相关测试用本地模拟请求，不调用外部付费模型。

本次实际核对 `ai-four-2026-11`：`required=false`，`nextPipelineWork` 为 `draft_scenes / write_scene`，`vh plan --srt` 不再列出模型内容审稿门槛。真实分镜、配音和成片尚未完成。

以后调整创作质量时，不得通过新建默认值、脚本提交副作用、历史回执或共享 skill 的旧说明重新启用自动审稿。
