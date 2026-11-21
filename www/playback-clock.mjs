// 有旁白时用媒体时钟；缓冲、暂停、seek 时画面不得自己越走越远。
export function playbackTime(time, delta, duration, audio = null) {
  const end = Math.max(0, Number(duration) || 0);
  const clamp = n => Math.max(0, Math.min(end, n));
  const advance = () => clamp(time + Math.max(0, Number(delta) || 0));
  if (!audio || audio.error) return advance();
  if (!Number.isFinite(audio.duration) || audio.readyState < 2 || audio.seeking) return clamp(time);
  // 音轨比画面短时，让画面自然走完尾部留白；不能倒回音轨末尾反复播放。
  if (audio.ended) return advance();
  if (audio.paused) return clamp(time);
  return clamp(Number.isFinite(audio.currentTime) ? audio.currentTime : time);
}

export function playbackRate(rate) {
  return Math.min(4, Math.max(.25, Number(rate) || 1));
}
