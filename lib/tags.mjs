/* A plain browser/Node module: publication text and posting forms share the
 * same delimiter rules. Arrays represent already separated explicit tags. */
export function splitTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/);
  return list.map(tag => String(tag).trim()).filter(Boolean);
}
