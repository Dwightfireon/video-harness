/* 识别“审阅/检查”指令：这类要求必须先实际检查，不能改稿，也不能直接走完成校验。 */
const REVIEW = /(?:检查|核对|复查|确认|看看|看一下|看下|审一下|审阅|审片|排查).{0,16}(?:画面|显示|视觉|排版|字幕|截图|静帧|成片)|(?:画面|显示|排版|字幕|文字).{0,16}(?:有没有|是否有|不对|问题|错位|重叠|越界|挡住|看不清|显示异常)/;
/* 明确的修改动作仍按改稿处理，避免把“检查一下并把标题改短”误判成纯审阅。 */
const MUTATE = /(?:改|换|加|删|去掉|调|压|缩|重做|修复|修好|替换|移动|放大|缩小)/;

export function isReviewRequest(text) {
  const value = String(text || '');
  return REVIEW.test(value) && !MUTATE.test(value);
}

export function reviewScopes(text) {
  const value = String(text || ''), scopes = [];
  if (/画面|显示|视觉|排版|截图|静帧/.test(value)) scopes.push('visual');
  if (/字幕/.test(value)) scopes.push('subtitle');
  if (/声音|旁白|配音|音轨/.test(value)) scopes.push('audio');
  return scopes.length ? scopes : ['visual'];
}
