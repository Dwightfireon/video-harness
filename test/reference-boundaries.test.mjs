/* 参考资料这一组的依赖方向守卫。目的不是拆文件数量，而是保证：
 * 纯规则不碰磁盘；写入只有一处；读取来源不反向依赖写入之外的东西。
 * 任何一条被打破，都会退回到"两条路径各写一次盘、标题还不一致"的老问题。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

const source = name => fs.readFileSync(new URL('../lib/' + name, import.meta.url), 'utf8');
const imports = name => [...source(name).matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);

test('纯规则层不读盘、不联网、不认识项目结构', () => {
  for (const name of ['url-identity.mjs', 'reference-format.mjs']) {
    const body = source(name);
    assert.doesNotMatch(body, /node:fs|node:path|readFileSync|writeFileSync|fetch\(|spawn\(/, name);
    for (const target of imports(name)) assert.match(target, /^\.\/(url-identity|reference-format)\.mjs$/, name + ' 只能依赖同层纯模块：' + target);
  }
});

test('写入只有一处：只有 reference-write 写发布文案', () => {
  for (const name of ['url-identity.mjs', 'reference-format.mjs', 'publish-refs.mjs']) {
    assert.doesNotMatch(source(name), /writeFileSync|appendFileSync/, name + ' 不应写盘');
  }
  assert.match(source('reference-write.mjs'), /writeFileSync/);
});

test('依赖方向单向，没有环', () => {
  const order = ['url-identity.mjs', 'reference-format.mjs', 'reference-write.mjs', 'publish-refs.mjs', 'reference-sources.mjs'];
  const rank = new Map(order.map((name, index) => [name, index]));
  for (const name of order) {
    for (const target of imports(name)) {
      const dependency = target.replace('./', '');
      if (!rank.has(dependency)) continue;
      assert.ok(rank.get(dependency) < rank.get(name), `${name} 反向依赖 ${dependency}，形成环`);
    }
  }
});

test('claims 读取层不写盘、不认识脚本与材料', () => {
  const body = source('publish-refs.mjs');
  assert.doesNotMatch(body, /脚本\.md|materials\/|research\//, 'claims 适配器不应读取别的来源');
  assert.doesNotMatch(body, /writeReferences|appendFileSync/);
});

test('来源编排层不解析链接语法，归一交给纯模块', () => {
  const body = source('reference-sources.mjs');
  assert.doesNotMatch(body, /10\\\.\\d\{4,9\}/, 'DOI 正则应只在 url-identity');
  assert.match(body, /from '\.\/url-identity\.mjs'/);
});
