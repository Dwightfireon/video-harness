import { parentPort, workerData } from 'node:worker_threads';
import { productionQualityStatus } from './production-quality.mjs';
import { workflowPolicy } from './workflow-policy.mjs';
try {
  const profile = workflowPolicy(workerData.project).qualityProfile;
  if (workerData.qualityProfile !== profile) throw new Error('核验期间工作流策略改变');
  parentPort.postMessage(productionQualityStatus(workerData.project, { phase: workerData.phase, profile }));
}
catch { parentPort.postMessage({ ok: false, stale: true, reason: '无法完成当前版本核验，请稍后重试' }); }
