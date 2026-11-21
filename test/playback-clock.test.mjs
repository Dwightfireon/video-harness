import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playbackTime, playbackRate } from '../www/playback-clock.mjs';

const audio = patch => ({ duration: 100, currentTime: 42, readyState: 4, seeking: false, paused: false, ended: false, ...patch });
test('预览：画面跟随媒体时钟，不因 rAF 掉帧或长帧偏移', () => {
  assert.equal(playbackTime(30, 12, 120, audio({ currentTime: 43.5 })), 43.5);
  assert.equal(playbackTime(55, .01, 120, audio({ currentTime: 20 })), 20);
});
test('预览：媒体缓冲、seek、暂停、未加载时画面不抢跑', () => {
  for (const patch of [{ readyState: 1 }, { seeking: true }, { paused: true }, { duration: NaN }]) {
    assert.equal(playbackTime(30, 2, 120, audio(patch)), 30);
  }
});
test('预览：音轨结束后播完尾部；无音轨才走独立时钟', () => {
  assert.equal(playbackTime(100, .4, 101, audio({ ended: true })), 100.4);
  assert.equal(playbackTime(100.9, .4, 101, audio({ ended: true })), 101);
  assert.equal(playbackTime(20, 2, 30), 22);
  assert.equal(playbackTime(20, 2, 30, audio({ error: true })), 22);
  assert.equal(playbackRate(8), 4);
  assert.equal(playbackRate(2), 2);
});
