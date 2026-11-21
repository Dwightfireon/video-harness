import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolOutcome, directPipelineScript } from '../lib/tool-result.mjs';

/* 真实事故：build 失败后紧跟 clarity，复合命令最终 exit=0，
   旧的"看第一行退出码"把它记成成功，台账也只剩 exit=0。 */
test('复合命令 exit=0 但含 ✗ 失败行：不能算成功，摘要要保留失败原因', () => {
  const content = 'exit=0\n\n── 生成 scene.html ──\n✗ scenes.src.js 有 3 块，脚本有 10 场 —— 对不上\n✗ 生成 scene.html 失败\n=== clarity\n解释质量：1 个硬性未通过';
  const result = toolOutcome(content);
  assert.equal(result.ok, false);
  assert.match(result.summary, /对不上/);
  assert.doesNotMatch(result.summary, /^exit=0\s*$/);
});

test('正常 exit=0 与工具拒绝分别判定', () => {
  assert.equal(toolOutcome('exit=0\n写入完成').ok, true);
  assert.equal(toolOutcome('exit=2\nboom').ok, false);
  assert.equal(toolOutcome('拒绝：越出项目目录').ok, false);
  assert.equal(toolOutcome('拒绝自动重放：上次执行结果未知').unknown, true);
  assert.equal(toolOutcome('拒绝自动重放：上次执行结果未知').ok, false);
});

test('只读查看 gen/render/voice 不被当作直接执行；实际执行入口要拦', () => {
  for (const command of [
    'sed -n 1,120p gen.mjs',
    'grep -n "依赖" gen.mjs | head -40',
    "python3 -c \"print(open('gen.mjs').read()[:100])\"",
    'cat scenes.src.js; echo ===; grep -n x voice-kokoro.py',
    'wc -l render.mjs',
  ]) assert.equal(directPipelineScript(command), null, command);

  for (const [command, name] of [
    ['node gen.mjs --estimate', 'gen.mjs'],
    ['node ./render.mjs --scenes 1', 'render.mjs'],
    ['cd . && node "/abs/path/render.mjs" --all', 'render.mjs'],
    ['python3 voice-kokoro.py --srt', 'voice-kokoro.py'],
    ['ls; node gen.mjs', 'gen.mjs'],
    ['node --experimental-vm-modules render.mjs', 'render.mjs'],
  ]) assert.equal(directPipelineScript(command), name, command);
});

test('vh 自己调用底层脚本的入口不被误拦', () => {
  assert.equal(directPipelineScript('node vh.mjs build --estimate'), null);
  assert.equal(directPipelineScript('node "/x/vh.mjs" go --srt'), null);
});
