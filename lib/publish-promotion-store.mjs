/* 每个项目独立保存；不改制作输入，不迁移旧片，不自动启用任何发布。 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicJSON } from './checkpoint.mjs';
import { normalizePromotion, promotionProblems } from '../desk/promotion.mjs';
import { readPublishForm, savePublishForm } from './publish-form-store.mjs';

export const PROMOTION_FILE = '.publish-promotion.json';
export function readPromotion(dir) {
  if (!dir) return normalizePromotion();
  const form = readPublishForm(dir);
  if (form) return form.fields.promotion;
  let raw;
  try { raw = fs.readFileSync(path.join(dir, PROMOTION_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return normalizePromotion(); throw error; }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('商业声明保存文件损坏，请在发布台重新保存；不会静默去掉声明'); }
  if (data?.version !== 1 || !data.promotion || promotionProblems(data.promotion).length) throw new Error('商业声明保存格式无效，请在发布台重新保存；不会静默去掉声明');
  return normalizePromotion(data.promotion);
}
export function savePromotion(dir, input) {
  const problems = promotionProblems(input);
  if (input === undefined || problems.length) throw new Error(problems.join('；') || '请提供商业声明');
  const promotion = normalizePromotion(input);
  const form = readPublishForm(dir);
  if (form) {
    savePublishForm(dir, { ...form.fields, ...form.partition, promotion }, form.revision);
    return promotion;
  }
  atomicJSON(path.join(dir, PROMOTION_FILE), { version: 1, promotion });
  return promotion;
}
