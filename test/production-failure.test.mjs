import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProductionFailure, productionFailure, productionRepairRecovery, productionRepairWork,
  reconsiderProductionStop, stoppedProductionFailure, applyRepairExtensions } from '../lib/automation.mjs';
import { parseStageResult, serializeStageResult } from '../lib/stage-result.mjs';

const stage = overrides => serializeStageResult({ stage: 'render', exitCode: 1,
  logPath: 'out/.vh-tool-logs/test.log', output: 'FAIL 版式溢出', ...overrides });
const failed = (category = 'quality', message = 'Codex 额度卡片文字超出容器', id = 'layout') =>
  ({ id, ok: false, status: 'failed', issues: [{ category, message, hint: '修复后重跑，不降低检查阈值' }] });
const quality = (...checks) => ({ version: 1, phase: 'pre-render', ok: false, checks });
const technicalQuality = (...checks) => ({ ...quality(...checks), profile: 'technical' });
const optionalVisual = id => ({ id, required: false, ok: null, status: 'not-run', issues: [] });
const failure = overrides => ({ stage: 'render', reason: 'FAIL 版式溢出：Codex 额度卡片文字超出容器',
  sourceSignature: 'input-a', maxRepairs: 2, ...overrides });

test('题材中的额度/认证/超时等字词不能改变真实内容故障的恢复路径', () => {
  for (const topic of ['额度', '认证', '超时', 'timeout', 'timed out', 'ENOSPC', '执行锁', '凭证', '浏览器启动失败']) {
    const reason = `FAIL 版式溢出：Codex ${topic}卡片文字超出容器`;
    assert.equal(classifyProductionFailure(reason), 'content', topic);
    assert.equal(classifyProductionFailure(stage({ output: reason })), 'content', topic);
    const ledger = productionFailure({}, failure({ reason }));
    assert.equal(ledger.stop, null); assert.equal(ledger.history.length, 1);
    assert.match(productionRepairWork(ledger).note, /只修报错对应/);
  }
  for (const reason of ['本文介绍认证和额度', '标题为超时、字幕及结构', '主题：timeout FAIL', '额度', '认证', '超时'])
    assert.equal(classifyProductionFailure(reason), 'unknown', reason);
  for (const topic of ['额度不足', '认证失败', '请求超时', 'timeout', 'ENOSPC'])
    assert.equal(classifyProductionFailure(`FAIL ${topic}卡片文字超出容器`), 'content', topic);
});

test('quality 使用类别而非 message/hint 文字；新旧 CLI 诊断头均可识别', () => {
  const message = '认证失败：额度不足且请求超时（画面上的示例文字）';
  const checks = [failed('quality', message)];
  for (const prefix of ['自动质量闸门未通过：', '✗ 自动质量闸门未通过：', '制作技术检查未通过：', '✗ 制作技术检查未通过：']) {
    const output = prefix + JSON.stringify(checks);
    assert.equal(classifyProductionFailure(output), 'content');
    assert.equal(classifyProductionFailure(stage({ output })), 'content');
  }
  assert.equal(classifyProductionFailure('完全没有关键词', { quality: quality(...checks) }), 'content');
  assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: quality(failed('checker', '版式溢出')) }), 'environment');
  assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: quality(failed('io', '无法保存回执', 'receipt')) }), 'environment');
  for (const category of ['inputs', 'assets', 'timing', 'structure', 'build', 'subtitles', 'silence', 'clipping'])
    assert.equal(classifyProductionFailure('diagnostic', { quality: quality(failed(category)) }), 'content', category);
  for (const category of ['inputs', 'assets'])
    assert.equal(classifyProductionFailure('diagnostic', { quality: quality(failed(category, '认证失败：画面题材中的素材说明')) }), 'content');
  for (const category of ['changed', 'media', 'stale', 'future-category'])
    assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: quality(failed(category)) }), 'unknown', category);
  assert.equal(classifyProductionFailure('diagnostic', { quality: quality(failed('inputs', 'EACCES: permission denied')) }), 'environment');
  assert.equal(classifyProductionFailure('【时长超限，禁止继续渲染】时间轴 90 秒，超过当前上限 60 秒'), 'content');
});

test('技术回执只忽略诚实的可选contrast/layout未执行项，字幕失败仍按实际类别修复', () => {
  const subtitle = failed('quality', '字幕 1 在 0.22s 缺失、隐藏、不完整或越界', 'subtitles');
  const checks = [optionalVisual('contrast'), optionalVisual('layout'), subtitle];
  const receipt = technicalQuality(...checks);
  assert.equal(classifyProductionFailure('diagnostic', { quality: receipt }), 'content');
  for (const prefix of ['制作技术检查未通过：', '✗ 制作技术检查未通过：', '自动质量闸门未通过：', '✗ 自动质量闸门未通过：']) {
    for (const evidence of [checks, receipt]) {
      const output = prefix + JSON.stringify(evidence);
      assert.equal(classifyProductionFailure(output), 'content', output);
      assert.equal(classifyProductionFailure(stage({ output })), 'content');
    }
  }
  const ledger = productionFailure({}, failure({ reason: '制作技术检查未通过：' + JSON.stringify(checks), quality: receipt }));
  assert.equal(ledger.stop, null); assert.equal(ledger.history.length, 1);
  assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: technicalQuality(optionalVisual('contrast'), optionalVisual('layout')) }), 'unknown');
  const explicitlyFailed = { ...failed('quality', '对比度检查实际失败', 'contrast'), required: false };
  assert.equal(classifyProductionFailure('diagnostic', { quality: technicalQuality(explicitlyFailed) }), 'content', 'optional is not a blanket failure waiver');
});

test('可选未执行标记不能豁免任意技术项，也不能把损坏证据降级为关键词修复', () => {
  const subtitle = failed('subtitles', '字幕不完整', 'subtitles');
  for (const id of ['inputs', 'assets', 'timing', 'structure', 'build', 'subtitles', 'artifact', 'srt', 'decode', 'audio', 'stable', 'future-check']) {
    const checks = [optionalVisual('contrast'), optionalVisual('layout'), { ...optionalVisual(id) }, subtitle];
    assert.equal(classifyProductionFailure('FAIL 字幕不完整', { quality: technicalQuality(...checks) }), 'unknown', id);
    assert.equal(classifyProductionFailure('制作技术检查未通过：' + JSON.stringify(checks)), 'unknown', id);
  }
  for (const override of [
    { required: true }, { required: undefined }, { ok: true }, { ok: false },
    { status: 'skipped' }, { status: 'passed' }, { issues: [{ category: 'quality', message: '实际有问题' }] },
  ]) {
    const checks = [{ ...optionalVisual('layout'), ...override }, subtitle];
    assert.equal(classifyProductionFailure('FAIL 字幕不完整', { quality: technicalQuality(...checks) }), 'unknown', JSON.stringify(override));
    assert.equal(classifyProductionFailure('制作技术检查未通过：' + JSON.stringify(checks)), 'unknown', JSON.stringify(override));
  }
  for (const output of ['制作技术检查未通过：not-json FAIL 字幕不完整',
    '制作技术检查未通过：' + JSON.stringify([subtitle]) + ' 额度不足'])
    assert.equal(classifyProductionFailure(output), 'unknown');
});

test('技术回执中的字幕检查器/运行环境失败不冒充可修复字幕内容，混合失败不消费内容修复预算', () => {
  const subtitle = failed('quality', '字幕 1 隐藏', 'subtitles');
  for (const broken of [
    failed('checker', 'page.evaluate: Error: runtime failure', 'subtitles'),
    failed('checker', '资源加载失败：file:///missing-runtime.bin', 'subtitles'),
    failed('checker', '浏览器启动失败：没有内核', 'subtitles'),
    failed('io', '无法写入技术检查回执', 'receipt'),
    failed('assets', 'EACCES: permission denied', 'assets'),
  ]) {
    const checks = [optionalVisual('contrast'), optionalVisual('layout'), subtitle, broken];
    const receipt = technicalQuality(...checks), reason = '制作技术检查未通过：' + JSON.stringify(checks);
    assert.equal(classifyProductionFailure(reason), 'environment', broken.issues[0].message);
    assert.equal(classifyProductionFailure(stage({ output: reason })), 'environment');
    assert.equal(classifyProductionFailure('字幕看不清', { quality: receipt }), 'environment');
    const ledger = productionFailure({}, failure({ reason, quality: receipt }));
    assert.equal(ledger.stoppedKind, 'environment'); assert.equal(ledger.history.length, 0);
    assert.equal(productionRepairWork(ledger), null);
  }
});

test('混合 quality 结果遇到检查器/未知项不能盲改内容，损坏证据不降级为关键词修复', () => {
  for (const checks of [[failed(), failed('checker')], [failed('changed'), failed('io')]])
    assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: quality(...checks) }), 'environment');
  assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: quality(failed(), failed('changed')) }), 'unknown');
  const passed = { id: 'contrast', ok: true, status: 'passed', issues: [], sampled: 2 };
  assert.equal(classifyProductionFailure('diagnostic', { quality: quality(passed, failed()) }), 'content');
  for (const evidence of [null, {}, [], quality(), quality(passed), quality({ ...failed(), status: 'passed' }),
    quality({ ...failed(), issues: [] }), quality({ ...failed(), issues: [{ message: 'FAIL 版式溢出' }] }),
    { ...quality(failed()), ok: true }, { ...quality(failed()), version: 2 }])
    assert.equal(classifyProductionFailure('FAIL 版式溢出', { quality: evidence }), 'unknown');
  for (const output of ['✗ 自动质量闸门未通过：not-json FAIL 版式溢出',
    '自动质量闸门未通过：' + JSON.stringify([failed()]) + ' 额度不足'])
    assert.equal(classifyProductionFailure(output), 'unknown');
});

test('固定阶段回执的真实退出码/信号优先，成功警告和损坏/阶段错配不能消费预算', () => {
  assert.equal(classifyProductionFailure(stage({ exitCode: 0 })), 'unknown');
  assert.equal(classifyProductionFailure(stage({ exitCode: 'SIGTERM' })), 'environment');
  const typed = parseStageResult(stage());
  assert.equal(classifyProductionFailure('诊断', { stage: 'render', stageResult: typed }), 'content');
  assert.equal(classifyProductionFailure('诊断', { stage: 'render', stageResult: stage() }), 'content');
  assert.equal(classifyProductionFailure('FAIL 版式溢出', { stage: 'voice', stageResult: typed }), 'unknown');
  for (const evidence of [stage({ exitCode: 0 }), stage({ exitCode: 'SIGKILL' }),
    stage().slice(0, -1), 'exit=1\nFAIL 版式溢出', null, {}, { ...typed, exitCode: null }]) {
    const ledger = productionFailure({}, failure({ stageResult: evidence, quality: quality(failed()) }));
    assert.ok(ledger.stop); assert.equal(ledger.history.length, 0);
  }
  assert.equal(classifyProductionFailure(stage().slice(0, -1) + ' FAIL 版式溢出'), 'unknown');
  assert.equal(classifyProductionFailure(stage() + '\nFAIL 版式溢出'), 'unknown');
  assert.equal(classifyProductionFailure('exit=0\nFAIL 版式溢出'), 'unknown');
  assert.equal(classifyProductionFailure('exit=23'), 'unknown');
});

test('明确环境诊断不启动内容修复；普通主题词不冒充运行故障', () => {
  for (const reason of ['ENOSPC', 'Error: EACCES: permission denied', '✗ 浏览器启动失败：没有内核',
    '没有 playwright，无法测量版式', '检查执行失败：超时', '启动阶段进程失败 ENOENT',
    'Error: spawn ffmpeg ENOENT', '执行锁仍被另一进程占用', '认证失败：token expired', '额度不足',
    '请求超时', 'TimeoutError: browser not responding', 'FAIL 检查器不可用：layout']) {
    const ledger = productionFailure({}, failure({ reason }));
    assert.equal(ledger.stoppedKind, 'environment', reason);
    assert.equal(ledger.history.length, 0); assert.equal(productionRepairWork(ledger), null);
    assert.equal(reconsiderProductionStop(ledger, 'new-input'), ledger);
  }
  const mixed = 'FAIL 版式溢出：认证失败示例\nError: ENOSPC: no space left on device';
  assert.equal(classifyProductionFailure(mixed), 'environment');
  const qualityAndEnvironment = '自动质量闸门未通过：' + JSON.stringify([failed()]) + '\nError: ENOSPC: no space';
  assert.equal(classifyProductionFailure(qualityAndEnvironment), 'environment');
  assert.equal(classifyProductionFailure(stage({ output: 'Error: ENOSPC: no space' }), { quality: quality(failed()) }), 'environment');
});

test('结构化内容故障跨 checkpoint 继续保持类别和预算，新增输入不重置额度', () => {
  const params = failure({ reason: 't=2.1「认证失败」文字盒子裁切', quality: quality(failed()) });
  const first = productionFailure({}, params);
  assert.equal(first.history.length, 1);
  assert.match(productionFailure(first, params).stop, /输入未变/);
  const second = productionFailure({ ...first, pending: null }, { ...params, sourceSignature: 'input-b' });
  const stopped = JSON.parse(JSON.stringify(productionFailure({ ...second, pending: null }, { ...params, sourceSignature: 'input-c' })));
  assert.equal(stopped.stoppedKind, 'content'); assert.match(stopped.stop, /2 轮上限/);
  assert.equal(stoppedProductionFailure(stopped).reason, params.reason, '不靠重新猜测自由文本恢复类别');
  assert.equal(productionRepairRecovery(stopped, { enabled: true, maxRepairs: 2 }).canExtend, true);
  const reopened = reconsiderProductionStop(stopped, 'input-d');
  assert.equal(reopened.stop, null); assert.equal(reopened.history.length, 2);
  assert.match(productionFailure(reopened, { ...params, sourceSignature: 'input-d' }).stop, /2 轮上限/);
  const extended = applyRepairExtensions(stopped, [{ id: 'approved', fromLimit: 2, additionalRepairs: 2, toLimit: 4 }],
    { enabled: true, maxRepairs: 4 });
  assert.equal(extended.history.length, 3); assert.equal(extended.pending.reason, params.reason);
  assert.deepEqual(applyRepairExtensions(extended, [{ id: 'approved', fromLimit: 2, additionalRepairs: 2, toLimit: 4 }],
    { enabled: true, maxRepairs: 4 }), extended);
});

test('受控历史 stop 包装可解出真实诊断，缺稿恢复保留预算且不凭空补阶段', () => {
  const short = '自动修复已达到 2 轮上限；FAIL 脚本缺主体';
  const full = '自动修复已达到 2 轮上限；保留现场，不降低质量门槛：阶段 render：FAIL 版式溢出：额度认证超时卡片';
  for (const reason of [short, full, '阶段 build：FAIL 脚本缺主体',
    '阶段 render 输入未变且同一问题再次失败，停止原样重跑：FAIL 版式溢出：额度卡片',
    '自动修复已达到 2 轮上限；保留现场，不降低质量门槛：' + stage()])
    assert.equal(classifyProductionFailure(reason), 'content', reason);
  const ledger = { history: [{ key: 'one' }, { key: 'two' }], pending: null,
    stoppedSignature: 'old-input', stop: short };
  assert.equal(reconsiderProductionStop(ledger, 'old-input'), ledger);
  const reopened = reconsiderProductionStop(ledger, 'completed-draft');
  assert.equal(reopened.stop, null); assert.deepEqual(reopened.history, ledger.history);
  assert.equal(stoppedProductionFailure(ledger), null, '缺少真实阶段时仍不能授权追加修复');
  assert.equal(stoppedProductionFailure({ ...ledger, stop: full }).stage, 'render');
  assert.equal(classifyProductionFailure(full, { stage: 'voice' }), 'unknown');
});

test('历史停止包装不将环境/未知或 exit=0 警告变成内容故障', () => {
  const budget = '自动修复已达到 2 轮上限；保留现场，不降低质量门槛：';
  for (const reason of [budget + 'ENOSPC', '自动修复已达到 2 轮上限；检查执行失败：超时',
    '阶段 render 环境/检查器失败，未盲目重试：FAIL 版式溢出：认证题材']) {
    assert.equal(classifyProductionFailure(reason), 'environment', reason);
    const ledger = { history: [], stoppedSignature: 'old-input', stop: reason };
    assert.equal(reconsiderProductionStop(ledger, 'new-input'), ledger);
  }
  for (const reason of [budget + 'exit=23', budget + '认证、额度与超时的主题介绍',
    '阶段 render 失败原因不明，未盲目重试：FAIL 版式溢出',
    '用户说自动修复已达到 2 轮上限；FAIL 脚本缺主体',
    '自动修复已达到 2 轮上限；用户说明：FAIL 脚本缺主体',
    budget + 'exit=0\nFAIL 版式溢出', budget + '阶段 build：exit=0\nFAIL 脚本缺主体',
    budget + stage({ exitCode: 0 }), budget + stage().slice(0, -1),
    '阶段 render 输入未变且同一问题再次失败，停止原样重跑：exit=0\nFAIL 版式溢出']) {
    assert.equal(classifyProductionFailure(reason), 'unknown', reason);
    const ledger = { history: [], stoppedSignature: 'old-input', stop: reason };
    assert.equal(reconsiderProductionStop(ledger, 'new-input'), ledger);
  }
});
