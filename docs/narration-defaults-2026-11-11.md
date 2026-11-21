# 旁白默认配置：采用用户选定的 C 组

## 选择与范围

用户试听 `diagnostics/voice-audition-2026-11-11/试听.html` 后反馈：

> 我觉得晓晓 · 1.25 倍最好。

后续新视频默认采用 C 组：`zh-CN-XiaoxiaoNeural`、`speed=1.25`（Edge 原生 `rate=+25%`）、同场句间额外留白约 0.35 秒。不迁移或重测旧项目，不重做已发布视频，不改变试听包音频。

0.35 秒为句尾留白 0.15 + 下一句前空档 0.20。句内标点停顿保留；场景间仍额外留原有的 0.35 秒，另有原有场尾余量，不把全片所有停顿压成同一个长度。

## 默认值与兼容

- 唯一全局默认：`assets/voice-defaults.json`。
- `scripts/voice-edge-tts-patch.py` 只在显式新建/转换已知 Kokoro 模板时，将默认快照写进新生成脚本的 `VH_NARRATION_DEFAULTS`。脚本自身也用该快照设置默认音色、语速和实测时间轴留白。
- `lib/voice-defaults.mjs` 只读解析快照，不导入或执行项目 Python。`measure`、`voice`、`voice-sample` 使用同一项目参数解析。
- 音色/语速优先级：显式 CLI → 已有 `timing.json` 测量 → `out/.vh-state.json` 测量参数 → 项目快照。
- 无快照的历史项目仍沿用旧回退（晓依 / 1.0）；历史项目自身脚本的停顿实现不改写。
- 中央默认今后再变，已有脚本快照仍保持不变。修改项目快照属于修改合成脚本，原有脚本身份机制仍生效，不补签旧测量或手改缓存指纹。
- 小样使用既有测量参数或项目快照，不会因为只试听一次新音色就更改正式测量。

## 验证

新增覆盖：新默认值、旧项目不写盘、CLI/实测/已保存参数优先级、项目快照独立性、无效快照拒绝、真实 `vh new` 和只读 `voice-sample --list`。

完整生成脚本的离线集成测试使用模拟 Edge 服务与真实 FFmpeg/SoundFile，核对新脚本默认请求晓晓 `+25%`，并以音频实际长度核对同场额外句间留白约 0.35 秒。原缓存、去重、并发、部分失败、混流边界等测试继续固定原基线音色/语速，避免将改变内容误说成性能收益。

本轮不另合成付费音频、不重新制作视频；用户的偏好只证明选定试听样本，不等于所有未来视频都已经试听通过。

运行以下相关回归，**36 项全部通过、无跳过**（其中生成脚本测试另封装 Python 集成用例）；未宣称运行全仓库测试：

```bash
node scripts/test.mjs test/voice-defaults.test.mjs test/voice-samples.test.mjs test/session-retro.test.mjs test/voice-concurrency.test.mjs test/voice-edge-loop.test.mjs test/voice-upgrade.test.mjs test/voice-mux-tail.test.mjs test/content-review-optional.test.mjs
```
