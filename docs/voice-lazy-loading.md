# TTS 惰性加载（保留缓存 v1）

`lib/voice-upgrade.mjs` 导出 `upgradeVoice(project)`，仅接受完整 SHA-256 为
`91ff35499c30991f67ed6de8bc6a2682c438c6eb003760ec5603dd7c8b1314c9`
的标准 `voice-kokoro.py`。这是已核对的脚本字节身份，**不是模型权重身份**。
未知脚本返回 `unknown-template`，不覆盖；符号链接拒绝；已升级版本按逆变换后的完整哈希识别。
先在 `out/.vh-voice-backups/` 保存原稿，再升级项目副本，保留文件权限。

实际变动只有两处：启动环境探测用 `find_spec` 代替导入 Kokoro；首次缓存 miss 才导入
`entts`、`KPipeline` 并初始化，后续 miss 共用实例。模型参数、缓存 key、音频写入、修剪、
测量和混流逻辑不变。全 hit 仍需要 numpy/soundfile 和原有 Python 环境选择；不是无依赖模式。
`find_spec` 只能确认包可发现，已安装但损坏的 Kokoro 会在首次合成时报错，不再由启动导入探测提前发现。

## vh 接线建议（本次未编辑 vh.mjs）

- 导入 `upgradeVoice`，在项目写锁内、实际启动测量/配音 Python 前调用；新建脚手架完成后也可调用。
- `changed` 时报告备份路径；未知模板保留原脚本并说明跳过优化，不禁止原有自定义脚本运行。
- 不在 `status`、`plan` 等只读路径升级，不修改全局 skill。
- 无需为了这次等价改写重测或清缓存，不更新已有测量回执。以后增加允许的模板哈希时须重新审查语义并跑真实执行测试。

## 为什么没有升级缓存身份

当前逐句缓存是 `voice|speed(5位小数)|text` 的截短 SHA-1。
`save_timing` / `timeline_utils.validate_timing` 的 schema v1 仅验证文本、分组、voice/speed；
`lib/pipeline-plan.mjs` 还检查脚本测量基线，但不检查模型/发音实现。
`lib/voice-samples.mjs` 的计划签名有 entts、独立小样合成器哈希，然而 measured 分支直接复制
`out/.voice-kokoro/NN.wav`，并没有绑定这些文件对应的合成身份。
只修改缓存 key，会让后续配音生成不同音频时旧 timing 仍然 valid，因此本次明确延后迁移。
原有缓存身份不足仍存在，不能据本次优化声称模型/entts 变化已自动失效。

完整迁移需统一：模型 repo/revision/config、音色资源身份、entts 字节、合成和修剪算法版本、
包版本及采样率，并把同一身份写入逐句缓存、timing measurement、测量回执、小样签名及实测片段来源。
必须同步升级 Python/JS timing 验证、生成器恢复、计划/复用判断和 measured 小样导出；旧身份要明确失效并重测。
模型配置/版本只是声明身份；只有实际读取权重字节计算哈希才能称为“模型字节哈希”。

## 验证

`node --test test/voice-upgrade.test.mjs`：本机 2 项通过，0 跳过。
Python mock 仅替换 Kokoro/entts 边界，执行完整原脚本和升级脚本，用真实 numpy、soundfile、
timeline parser 和文件缓存验证：两句 miss 仅初始化一次，冷启动 WAV/timing 与原版逐字节相同；
第二轮把 Kokoro/entts 改成导入即报错，全部 hit 仍成功且输出不变。
另测原稿备份、幂等、未知自定义和符号链接不覆盖。
测试依赖安装的标准 skill 资产及共享 TTS Python；未安装时明确 skip，没有把 mock 结果当成真实模型试听。
