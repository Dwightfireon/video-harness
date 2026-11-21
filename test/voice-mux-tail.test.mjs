import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillDir } from '../lib/state.mjs';

test('实际 skill 混流命令：短旁白补到片尾，长旁白截到视频长度', t => {
  const script = path.join(skillDir() || '', 'assets/voice-kokoro.py');
  if (!fs.existsSync(script)) return t.skip('未安装 article-video');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('没有 ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mux-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return r.stdout;
  };
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=64x36:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', 'video.mp4']);
  for (const duration of [1.2, 3]) {
    run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, 'voice.wav']);
    // 直接从资产 AST 取最后一个 subprocess.run，执行真正的混流 argv；不加载 TTS 模型。
    run('python3', ['-c', `import ast, pathlib, subprocess, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text())
calls = [n for n in tree.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
         and isinstance(n.value.func, ast.Attribute) and isinstance(n.value.func.value, ast.Name)
         and n.value.func.value.id == 'subprocess' and n.value.func.attr == 'run']
env = dict(subprocess=subprocess, video=pathlib.Path('video.mp4'), voice_wav=pathlib.Path('voice.wav'), final=pathlib.Path('final.mp4'))
exec(compile(ast.Module(body=[calls[-1]], type_ignores=[]), '<actual-mux>', 'exec'), env)
`, script]);
    const data = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,duration:format=duration', '-of', 'json', 'final.mp4']));
    const audio = data.streams.find(s => s.codec_type === 'audio');
    const video = data.streams.find(s => s.codec_type === 'video');
    assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.05, JSON.stringify(data));
    assert.ok(Math.abs(Number(data.format.duration) - 2) < 0.05);
  }
});
