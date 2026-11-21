#!/usr/bin/env python3
"""Small Edge/Kokoro probes; no ASR, video, timing writes or installation."""
import argparse
import asyncio
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys


def ensure_dependencies(engine):
    names = ('edge_tts', 'numpy', 'soundfile') if engine == 'edge-tts' else ('kokoro', 'numpy', 'soundfile')
    if any(importlib.util.find_spec(name) is None for name in names):
        home = Path(os.environ.get('VIDEO_TTS_HOME', Path.home() / '.local/share/opencode/video-tts'))
        python = home / 'venv/bin/python'
        if python.exists() and os.environ.get('_VH_SAMPLE_REEXEC') != '1':
            os.environ['_VH_SAMPLE_REEXEC'] = '1'
            os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])
        raise SystemExit(f'找不到 {engine} 配音依赖；先按 README 配置 TTS。本命令不会自动安装软件。')


async def edge_audio(text, voice, speed):
    import edge_tts
    # Match the production Edge patch: native rate, 24k mono MP3 -> float32.
    rate = f'{round((speed - 1.0) * 100):+d}%'
    audio = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
        if chunk['type'] == 'audio':
            audio.extend(chunk['data'])
    if not audio:
        raise RuntimeError('edge-tts 未返回音频；不能登记为空小样')
    decoded = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 'f32le',
         '-acodec', 'pcm_f32le', '-ac', '1', '-ar', '24000', 'pipe:1'],
        input=audio, capture_output=True, timeout=30)
    if decoded.returncode or not decoded.stdout:
        raise RuntimeError('edge-tts 音频转码失败：' + decoded.stderr.decode('utf-8', 'replace')[:200])
    import numpy as np
    return np.frombuffer(decoded.stdout, dtype=np.float32).copy()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.request).read_text(encoding='utf-8'))
    engine = request.get('engine', 'kokoro')
    if engine not in ('edge-tts', 'kokoro'):
        raise ValueError('不支持的小样配音引擎')
    voice, speed = request['voice'], request['speed']
    if not isinstance(voice, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', voice):
        raise ValueError('无效音色标识')
    if not isinstance(speed, (int, float)) or not math.isfinite(speed) or not 0 < speed <= 3:
        raise ValueError('speed 必须大于 0 且不超过 3')
    if not isinstance(request['items'], list) or not 1 <= len(request['items']) <= 12:
        raise ValueError('小样数量须为 1–12')
    if any(not isinstance(item['text'], str) or not 0 < len(item['text']) <= 400 for item in request['items']):
        raise ValueError('小样单句须为 1–400 字符')
    ensure_dependencies(engine)
    # Small probes must not silently download models or install another environment.
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    import numpy as np
    import soundfile as sf

    if engine == 'kokoro':
        sys.path.insert(0, request['project'])
        from entts import en_callable
        from kokoro import KPipeline
        pipe = KPipeline(lang_code='z', repo_id='hexgrad/Kokoro-82M-v1.1-zh', en_callable=en_callable)
    for item in request['items']:
        if engine == 'edge-tts':
            audio = asyncio.run(edge_audio(item['text'], voice, speed))
        else:
            chunks = [result.audio.numpy() for result in pipe(item['text'], voice=voice, speed=speed)]
            if not chunks:
                raise RuntimeError('TTS 未返回音频；不能登记为空小样')
            audio = np.concatenate(chunks)
        if not len(audio) or not np.isfinite(audio).all() or np.max(np.abs(audio)) <= 1e-6:
            raise RuntimeError('TTS 返回无效或全静音小样')
        active = np.where(np.abs(audio) > np.max(np.abs(audio)) * .02)[0]
        pad = 600  # Same 25ms padding as the measured narration.
        audio = audio[max(0, active[0] - pad):min(len(audio), active[-1] + pad)]
        sf.write(item['file'], audio, 24000)
        print(Path(item['file']).name + f' 已生成（{engine}；未试听）')


if __name__ == '__main__':
    main()
