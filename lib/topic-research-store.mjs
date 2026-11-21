/* Revalidate persisted tool material before enabling a new question's enqueue.
 * A model-written status/recordPath alone is never an admission receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTopicResearch } from './topic-contract.mjs';
import { assessDiscoveryCandidate } from './discovery-evidence.mjs';

export function validatedTopicResearch(root, record) {
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const research = normalizeTopicResearch(record.research, sources);
  if (!root || !research?.recordPath) return false;
  try {
    const base = fs.realpathSync(root), file = fs.realpathSync(path.join(base, research.recordPath));
    if (!file.startsWith(base + path.sep) || fs.statSync(file).size > 16 * 1024 * 1024) return false;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || saved.topicId !== record.id || !Array.isArray(saved.searches) || !Array.isArray(saved.pages) ||
      new Set(saved.searches.map(item => item?.query?.trim()).filter(Boolean)).size < 2) return false;
    if (saved.questionSnapshot?.topic !== record.topic || saved.questionSnapshot?.coreQuestion !== record.coreQuestion ||
      JSON.stringify(saved.questionSnapshot?.question) !== JSON.stringify(record.question)) return false;
    return assessDiscoveryCandidate({ kind: research.kind, selectionReason: research.selectionReason,
      why: saved.validationContext?.why || record.why, outline: saved.validationContext?.outline || record.outline, evidence: research.sources }, {
      sources, research: saved, now: saved.at, window: saved.window || null,
    }).ok;
  } catch { return false; }
}

export function canEnqueueTopic(root, record) {
  if (record.status === 'suggestion' || record.status === 'duplicate') return false;
  if (!record.question?.version) return true; // historical/manual topics keep their original behavior
  return record.question.version === 1 && record.researchAssessment?.status === 'leads' && validatedTopicResearch(root, record);
}
