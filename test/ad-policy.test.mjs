import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/* 广告指令优先级：这是真实事故的回归
   事故：用户说「简单点，给链接和优惠码，S9JE6G 就是优惠码」，
        agent 却写成价格+三条要点；我（助手）又把它当幻觉改回详细版。
   现在把"规则必须写进提示"变成可测的。 */
const AGENT = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'agent.mjs'), 'utf8');

test('广告规则：用户提供的内容优先于抓取结果', () => {
  assert.match(AGENT, /用户明确给出的内容，优先级高于你抓到的页面/);
  assert.match(AGENT, /不要用"页面上没写"擅自删除用户要求/);
  assert.match(AGENT, /用户提供与外部核实分别登记/);
});

test('广告规则：用户说简单就真的简单（不许加戏）', () => {
  assert.match(AGENT, /简单点|别太详细/);
  assert.match(AGENT, /不要自作主张补价格/);
});

test('广告规则：抓取只用于补缺，不用于改口', () => {
  assert.match(AGENT, /补缺/);
  assert.match(AGENT, /不用于"改口"|不用于改口/);
});

test('广告规则：必须有广告声明', () => {
  assert.match(AGENT, /这是广告/);
});

test('广告规则：用户提供的信息记为「广告 · 用户提供」', () => {
  assert.match(AGENT, /广告 · 用户提供/);
});
