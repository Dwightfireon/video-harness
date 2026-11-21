/* Draft-build advisories only. This module does not decide render/release
 * safety: the existing measured layout, subtitles and production gates do. */
import { scan as typeScan } from './type-audit.mjs';
import { scan as tokenScan } from './token-audit.mjs';
import { scan as rhythmScan } from './rhythm.mjs';
import { scan as motionScan } from './motion.mjs';
import { scan as transitionScan } from './transition.mjs';
import { analyze as varietyAnalyze } from './variety.mjs';

const specs = [
  { key: 'type', label: '字号', run: typeScan, format: r => r.findings.length
    ? `⚠ 字号：${r.findings.length} 处线索（vh type 看清单）` : '字号：未发现静态阶梯疑点，仍需看实际画面' },
  { key: 'tokens', label: '设计 token', run: tokenScan, format: r => r.findings.length
    ? `⚠ 设计 token：${r.findings.length} 处线索（vh tokens 看清单）` : '设计 token：未发现静态疑点' },
  { key: 'rhythm', label: '排版间距', run: rhythmScan, format: r => r.findings.length
    ? `⚠ 排版间距：${r.findings.length} 处待核对线索（vh rhythm 看清单）` : '排版间距：未发现静态疑点，不代表韵律通过' },
  { key: 'motion', label: '动作时间点', run: motionScan, format: r => r.findings.length || r.note
    ? `⚠ 动作时间点：${r.note || r.findings.length + ' 处待核对线索'}（vh motion 看表；非审片结论）`
    : `动作时间点：每分钟识别 ${r.beatsPerMinute} 个起点（未验证可见运动与讲述同步）` },
  { key: 'transition', label: '转场', run: transitionScan, format: r => r.findings.length
    ? `⚠ 转场：${r.findings.length} 处待核对线索（vh transition 看分布）` : `转场：识别 ${r.kinds.length} 种（不以数量判审美）` },
  { key: 'variety', label: '版式分布', run: varietyAnalyze, format: r => r.findings.length
    ? `⚠ 版式分布：${r.findings.length} 处待核对线索（vh variety 看分布表）` : '版式分布：未触发提示，不代表节奏通过' },
];

export function buildVisualDiagnostics(project, overrides = {}) {
  return specs.map(spec => {
    try {
      const result = (overrides[spec.key] || spec.run)(project);
      if (!result || !Array.isArray(result.findings)) throw new Error('检查器没有返回有效 findings');
      if (result.ok === false && !result.findings.length && !result.note) throw new Error('检查未完成且没有疑点或说明');
      return { key: spec.key, status: result.note ? 'unavailable' : result.findings.length ? 'findings' : 'clear',
        line: result.note ? `⚠ ${spec.label}：${result.note}（未能据此审阅）` : spec.format(result) };
    } catch (error) {
      return { key: spec.key, status: 'failed', line: `⚠ ${spec.label}检查执行失败：${error.message}（不是通过）` };
    }
  });
}
