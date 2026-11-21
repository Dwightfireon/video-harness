#!/usr/bin/env python3
"""把项目里 stock 的 voice-kokoro.py（Kokoro 引擎）改成 edge-tts 引擎。

用法：
    python3 scripts/voice-edge-tts-patch.py <项目目录> [--voice zh-CN-XiaoxiaoNeural] [--speed 1.25]

为什么单独做一个脚本：edge-tts 版本不是 skill 的「已知模板」，
harness 无法按 Kokoro 权重哈希认证它。所以这里改写依赖引导、合成函数、
音色与身份，并保存本次新建/转换的默认语速和停顿快照；槽位、混流、字幕、timing 契约保留，
并把身份写进自有字段 engineIdentity，不冒充 ttsIdentity。

仅接受完整字节匹配的 cache-v2 Kokoro 模板，不凭函数名认证自定义文件。
不自动升级 edge-tts v1/v2；须由用户从已知模板明确重建迁移。
每次修改前备份为 voice-kokoro.py.bak-kokoro-<时间>。
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import pathlib
import re
import subprocess
import sys

MARK = "edge-tts-engine-v3"
OLD_MARKS = ("edge-tts-engine-v1", "edge-tts-engine-v2")

ENV_BLOCK_NEW = '''# —— 依赖检查：缺依赖时自动切到已有 TTS 环境（该环境需装 edge-tts/soundfile/numpy）——
TTS_HOME = os.environ.get("VIDEO_TTS_HOME", os.path.expanduser("~/.local/share/opencode/video-tts"))
VENV_PY  = os.path.join(TTS_HOME, "venv", "bin", "python")

def _deps_ready():
    try:
        import importlib.util
        return all(importlib.util.find_spec(name) is not None
                   for name in ("edge_tts", "soundfile", "numpy"))
    except Exception:
        return False

if os.environ.get("_VIDEO_TTS_REEXEC") != "1" and not _deps_ready():
    if os.path.exists(VENV_PY):
        os.environ["_VIDEO_TTS_REEXEC"] = "1"
        os.execv(VENV_PY, [VENV_PY, os.path.abspath(__file__), *sys.argv[1:]])
    else:
        sys.exit("缺 TTS 依赖。请先运行：\\n    pip install edge-tts soundfile numpy")
'''

IDENTITY_NEW = '''EDGE_RATE = "edge-tts-rate-from-speed"

def voice_cache_identity(project, script, voice):
    """edge-tts 版本：身份 = 脚本 + 时间轴工具 + 音色名 + 语速 + edge-tts 包版本。

    不使用本地模型权重，因此无法像 Kokoro 那样按权重字节锁定；
    改为固定登记「音色 + 语速 + 包版本 + 脚本」，语速或音色一变即视为新身份。
    """
    project = Path(project).resolve(strict=True)
    if not isinstance(voice, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", voice):
        raise ValueError("Invalid TTS voice identifier")
    speed = 1.0
    try:
        speed = float(args.speed)
    except Exception:
        pass
    inputs = {
        "version": 2,
        "policy": "edge-tts/neural/mp3-24k/slot-fit-v2",
        "engine": "edge-tts",
        "script": _vh_file(script),
        "timeline": _vh_file(project / "timeline_utils.py"),
        "python": sys.version,
        "packages": {name: _vh_package(name, project) for name in ("edge_tts",)},
        "voice": voice,
        "speed": speed,
        "rate": EDGE_RATE,
    }
    return {"version": 2, "signature": hashlib.sha256(_vh_json(inputs).encode("utf-8")).hexdigest(), "inputs": inputs}


def _vh_check_timing(data, project, script, identity=None):
    """核对 timing.json 是否由当前 edge-tts 参数产出。

    刻意使用自有字段 engineIdentity，而不是 harness 已知模板专用的 ttsIdentity：
    本项目已换成 edge-tts，harness 无法按 Kokoro 模板哈希认证；
    冒充 ttsIdentity 只会让闸门误判为「已知模板」后失败。
    """
    measured = data.get("measurement", {})
    identity = identity or voice_cache_identity(project, script, measured.get("voice"))
    if measured.get("engineIdentity") != identity["signature"]:
        raise ValueError("TTS inputs changed or timing lacks engine identity; run vh measure again")
    return identity

'''

SYNTH_NEW = '''# ---------- edge-tts 合成 ----------
SR = 24000          # 统一重采样到 24k，与旧缓存/混流参数一致

def _synth_mp3(text, speed):
    """合成一句并返回 edge-tts 的原始 MP3 字节（不转码）。"""
    import asyncio
    pct = round((speed - 1.0) * 100)
    rate = f"{pct:+d}%"
    async def _run():
        c = edge_tts.Communicate(text, args.voice, rate=rate)
        buf = bytearray()
        async for chunk in c.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)
    mp3 = asyncio.run(_run())
    if not mp3:
        raise RuntimeError(f"edge-tts 返回空音频：{text[:20]}")
    return mp3

def _decode_mp3(mp3, text):
    """把一句 MP3 转成 24k 单声道 float32。转码本身与句序无关。"""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "f32le",
         "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), "pipe:1"],
        input=mp3, capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError("edge-tts 音频转码失败：" + proc.stderr.decode("utf-8", "ignore")[:200])
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()

def synth(text, speed):
    """用 edge-tts 合成一句，返回 24k 单声道 float32 波形。

    edge-tts 的 rate 是百分比字符串；speed 作为统一语速入口换算过去，
    这样 --speed 1.15 这类既有命令仍然有效。
    """
    return _decode_mp3(_synth_mp3(text, speed), text)

def synth_many(items, speed, limit=4):
    """并发合成多句，返回与输入同序的 MP3 字节或异常。

    单句一次网络往返约 1.4s；串行时 60 句要一分多钟，几乎全是等网络。
    edge-tts 是独立的无状态请求，因此可以在同一个事件循环里并发发出，
    再按**原句序**返回。并发度故意很小（默认 4），避免打满对端。
    这只是把等待重叠，不改变请求内容、音素、音色或返回的字节。
    等全部请求结束，保留成功结果供调用方写缓存；调用方汇总失败后停止，
    绝不让半份结果进入 timing 或混流。
    """
    import asyncio
    if not items:
        return []
    if not 1 <= limit <= 8:
        raise ValueError("并发数必须在 1–8 之间")
    pct = round((speed - 1.0) * 100)
    rate = f"{pct:+d}%"
    async def _run():
        sem = asyncio.Semaphore(limit)
        async def one(text):
            async with sem:
                c = edge_tts.Communicate(text, args.voice, rate=rate)
                buf = bytearray()
                async for chunk in c.stream():
                    if chunk["type"] == "audio":
                        buf.extend(chunk["data"])
                if not buf:
                    raise RuntimeError(f"edge-tts 返回空音频：{text[:20]}")
                return bytes(buf)
        return await asyncio.gather(*(one(text) for text in items), return_exceptions=True)
    return list(asyncio.run(_run()))

def dur_of(w):
    return len(w) / SR

'''

SYNTH_LOOP_NEW = '''# ---------- 逐句合成 + 卡槽位 ----------
# 每个唯一缓存键只请求一次；成功句先保存，任何失败都阻止 timing / 混流。
# 正常只保留已验证的 WAV 路径，逐句读 PCM16；仅写盘失败时保留内存回退。
def _cache_key(text, speed):
    return hashlib.sha256(_vh_json([args.voice, float(speed).hex(), text]).encode("utf-8")).hexdigest()

def _cache_file(text, speed):
    return CACHE / f"{_cache_key(text, speed)}.wav"

def _cache_audio(f):
    if f.is_symlink():
        raise ValueError("TTS cache must not be a symlink")
    if not f.is_file():
        raise ValueError("TTS cache must be a regular file")
    cached, sample_rate = sf.read(str(f))
    if sample_rate != SR or cached.ndim != 1 or not cached.size or not np.isfinite(cached).all():
        raise ValueError("Invalid TTS cache audio")
    return cached

def _cache_read(text, speed):
    f = _cache_file(text, speed)
    if f.is_symlink():
        raise ValueError("TTS cache must not be a symlink")
    if args.no_cache or not f.exists():
        return None
    _cache_audio(f)  # 验证后立即释放波形，不让全片 float64 缓存常驻。
    return f

def _sentence_wave(reference):
    return _cache_audio(reference) if isinstance(reference, Path) else reference

def _cache_write(text, speed, w):
    # 缓存不可写时仍可用本次波形；但安全/音频检查不可被回退吞掉。
    import tempfile
    f = _cache_file(text, speed)
    if f.is_symlink():
        raise ValueError("TTS cache must not be a symlink")
    if w.ndim != 1 or not w.size or not np.isfinite(w).all():
        raise ValueError("Invalid TTS audio")
    tmp = None
    try:
        try:
            with tempfile.NamedTemporaryFile(dir=CACHE, prefix=".edge-", suffix=".wav", delete=False) as stream:
                tmp = Path(stream.name)
            sf.write(str(tmp), w, SR)
        except Exception:
            return w
        # --no-cache 只跳过旧缓存；读取本次刚写的 WAV 不会复用旧音频。
        _cache_audio(tmp)
        if f.is_symlink():
            raise ValueError("TTS cache must not be a symlink")
        try:
            os.replace(tmp, f)
        except OSError:
            return w
        return f
    finally:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

# 加速分支仍沿用原请求参数与槽位阈值；同键只请求一次，不常驻已落盘波形。
_sentence_audio = {}
def synth_cached(text, speed):
    key = _cache_key(text, speed)
    if key not in _sentence_audio:
        reference = _cache_read(text, speed)
        _cache_stat["miss" if reference is None else "hit"] += 1
        if reference is None:
            reference = _cache_write(text, speed, trim_silence(synth(text, speed)))
        _sentence_audio[key] = reference
    return _sentence_wave(_sentence_audio[key])

clips = []
texts = [re.sub(r"\\s+", "", sub["t"].replace("·", "，")) for sub in SUBS]
# 计数仍按字幕句数，去重按音色 + 精确语速 + 规范化文本，不把统计当请求数。
pending = {}
lookups = {}
for text in texts:
    key = _cache_key(text, args.speed)
    if key not in lookups:
        lookups[key] = _cache_read(text, args.speed)
    hit = lookups[key]
    _cache_stat["miss" if hit is None else "hit"] += 1
    if hit is None:
        pending[key] = text
    else:
        _sentence_audio[key] = hit
if pending:
    mp3s = synth_many(list(pending.values()), args.speed, limit=args.tts_concurrency)
    if len(mp3s) != len(pending):
        raise RuntimeError("并发合成的句数与待合成句数不一致，未继续")
    failures = []
    for j, (key, text) in enumerate(pending.items()):
        mp3 = mp3s[j]
        mp3s[j] = None  # 已处理的压缩音频也不保留到全片结束。
        if isinstance(mp3, BaseException):
            failures.append((text, mp3))
            continue
        try:
            _sentence_audio[key] = _cache_write(text, args.speed, trim_silence(_decode_mp3(mp3, text)))
        except Exception as exc:
            failures.append((text, exc))
    del mp3s, mp3
    if failures:
        detail = "; ".join(f"{text[:20]}: {exc}" for text, exc in failures)
        raise RuntimeError("edge-tts 合成失败，成功句已尽力缓存；未生成 timing 或混流：" + detail) from failures[0][1]

for i, sub in enumerate(SUBS):
    s = sub["s"]
    text = texts[i]
    # 最后一句没有"下一句"当槽位：给它 +1.5s 余量，否则会被自己的 e 卡到硬压
    slot = (SUBS[i + 1]["s"] if i + 1 < len(SUBS) else SUBS[i]["e"] + 1.5) - s

    raw = _sentence_wave(_sentence_audio[_cache_key(text, args.speed)])
    dur = dur_of(raw)
    wav = TMP / f"{i:02d}.wav"
    flag = ""
    if args.measure:
        # ⚠ --measure 语义：这里**只测每句的自然时长**（用交付语速 --speed 合成，不额外加速、不硬压）。
        #   旧版会在"测时长"时按**旧槽位**自动加速/硬压 —— 于是测出来的是被压过的时长，
        #   据此回写的新时间轴本身就被污染了（越迭代越紧）。测就要测干净的那一版。
        sf.write(str(wav), raw, SR)
        # 给个参考：按目标节奏（约 3.5 字/秒 @1.0×；此处用交付语速折算）这句是否偏长
        cjk_n = len(re.findall(r"[\\u4e00-\\u9fff]", text))
        target = max(1.4, cjk_n / (3.5 * args.speed))       # 目标节奏下的理想句长
        if dur > target * 1.45:
            flag = f"  ⚠ 偏长约 {dur/target:.1f}×（自然时长 {dur:.2f}s）—— 考虑拆句，别靠加速"
    elif dur > slot - 0.05:
        # 交付（非 --measure）：为了把音频塞进槽位，允许有限加速；超上限才硬压
        need = args.speed * dur / max(slot - 0.05, 0.3)
        spd = min(need, args.maxspeed)
        raw = synth_cached(text, spd); dur = dur_of(raw)
        if dur > slot - 0.05:
            f = dur / max(slot - 0.05, 0.3)
            tmp = TMP / f"{i:02d}_raw.wav"
            sf.write(str(tmp), raw, SR); atempo(tmp, f, wav)
            dur = dur_of(sf.read(str(wav))[0])
            flag = f"  ⚠ 压到 {spd:.2f}× 仍超，再 atempo {f:.2f}× 硬压（文案偏长）"
        else:
            sf.write(str(wav), raw, SR)
            flag = f"  ⚠ 自动加速到 {spd:.2f}× 才装下"
    else:
        sf.write(str(wav), raw, SR)
    print(f"  {i+1:02d}  {s:5.1f}s  {dur:5.2f}s / 槽位 {slot:4.2f}s{flag}")
    clips.append({"wav": wav, "start": s, "dur": dur})
    del raw


'''

_LINES = [
    "常用中文女声：",
    "  zh-CN-XiaoxiaoNeural  晓晓（温暖）",
    "  zh-CN-XiaoyiNeural    晓依（活泼）",
    "  zh-CN-liaoning-XiaobeiNeural  晓北（幽默，东北口音）",
    "  zh-CN-shaanxi-XiaoniNeural    晓妮（明亮，陕西口音）",
    "常用中文男声：",
    "  zh-CN-YunxiNeural     云希（沉稳）",
    "  zh-CN-YunyangNeural   云扬（新闻）",
    "全部音色：edge-tts --list-voices",
]
VOICES_HINT_NEW = "VOICES_HINT = (\n" + "".join(
    "    " + repr(line + chr(10)) + "\n" for line in _LINES[:-1]
) + "    " + repr(_LINES[-1]) + "\n)"


def main() -> int:
    defaults_file = pathlib.Path(__file__).resolve().parents[1] / 'assets/voice-defaults.json'
    defaults = json.loads(defaults_file.read_text(encoding='utf-8'))
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--voice", default=defaults['voice'])
    ap.add_argument("--speed", type=float, default=defaults['speed'])
    args = ap.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.voice) or not math.isfinite(args.speed) or not 0 < args.speed <= 3:
        ap.error('音色标识无效，或 speed 不在 (0, 3] 范围')
    defaults.update(voice=args.voice, speed=args.speed)

    project = pathlib.Path(args.project).expanduser().resolve()
    target = project / "voice-kokoro.py"
    if target.is_symlink() or not target.is_file():
        print(f"✗ 找不到 {target}", file=sys.stderr)
        return 1

    src = target.read_bytes().decode("utf-8")
    if MARK in src:
        print(f"✓ 已是 edge-tts 版（{MARK}），不覆盖")
        return 0
    if any(mark in src for mark in OLD_MARKS):
        print(f"✗ 已是旧版 edge-tts（v1/v2）；本脚本不原地改写已有自定义，"
              f"请手工升级或从备份重建", file=sys.stderr)
        return 1

    # 复用仓库的完整字节识别，不导入/执行项目代码，也不凭几个锚点信任自定义。
    verifier = (pathlib.Path(__file__).resolve().parents[1] / "lib/voice-upgrade.mjs").as_uri()
    code = (f"import {{voiceTemplateKind}} from {verifier!r}; "
            "import fs from 'node:fs'; process.stdout.write(voiceTemplateKind(fs.readFileSync(0, 'utf8')));")
    try:
        check = subprocess.run(["node", "--input-type=module", "-e", code],
                               input=src, text=True, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"✗ 无法核对已知 Kokoro 模板，未改写：{exc}", file=sys.stderr)
        return 1
    if check.returncode != 0 or check.stdout != "cache-v2":
        print("✗ 不是完整匹配的已知 cache-v2 Kokoro 模板；请明确迁移，不自动改写", file=sys.stderr)
        return 1

    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S%f")
    backup = project / f"voice-kokoro.py.bak-kokoro-{stamp}"
    original = src

    # 1) 依赖引导
    start = src.index("# —— 自动切换到 TTS 环境")
    end = src.index("import argparse, re, subprocess, hashlib, json")
    src = src[:start] + ENV_BLOCK_NEW + "\n" + src[end:]
    src = src.replace("import argparse, re, subprocess, hashlib, json",
                      "import argparse, re, subprocess, hashlib, json\nimport edge_tts", 1)

    # 2) 身份函数
    start = src.index("def voice_cache_identity(project, script, voice):")
    end = src.index("# vh:voice-cache-v2: identity end")
    src = src[:start] + IDENTITY_NEW + "# vh:voice-cache-v2: identity end\n" + src[end:]

    # 3) 合成函数
    start = src.index("# ---------- 加载模型")
    end = src.index("# ---------- 逐句 TTS 缓存")
    src = src[:start] + SYNTH_NEW + src[end:]

    # 3b) 去重并发；完整收集成功/失败，成功句可跨失败重跑复用。
    start = src.index("# ---------- 逐句合成 + 卡槽位 ----------")
    end = src.index("if voice_cache_identity(HERE, Path(__file__), args.voice)[\"signature\"] != VOICE_CACHE_IDENTITY[\"signature\"]:")
    src = src[:start] + SYNTH_LOOP_NEW + src[end:]

    # 4) 音色提示与默认音色
    src = re.sub(r"VOICES_HINT = \(\n(?:.*\n)*?\)", lambda m: VOICES_HINT_NEW, src, count=1)
    # 每个新生成脚本保存独立快照；以后修改全局默认不影响旧项目。
    # 此 JSON 只含字符串、数字和对象，也可直接作为 Python 字面量使用。
    snapshot = 'VH_NARRATION_DEFAULTS = ' + json.dumps(defaults, ensure_ascii=False, separators=(',', ':'))
    src = src.replace('ap = argparse.ArgumentParser()', snapshot + '\n\nap = argparse.ArgumentParser()', 1)
    src = src.replace('ap.add_argument("--voice", default="zf_001")',
                      'ap.add_argument("--voice", default=VH_NARRATION_DEFAULTS["voice"])', 1)
    src = src.replace('ap.add_argument("--speed", type=float, default=1.0,',
                      'ap.add_argument("--speed", type=float, default=VH_NARRATION_DEFAULTS["speed"],', 1)
    src = src.replace('    TAIL, GAP, SCENE_BEAT = 0.35, 0.55, 0.35',
                      '    TAIL, GAP, SCENE_BEAT = (VH_NARRATION_DEFAULTS["timing"][k] for k in ("tail", "gap", "sceneBeat"))', 1)
    src = src.replace('建议时间轴（把空档收到 ~0.9s）',
                      f'建议时间轴（句间额外留白约 {defaults["timing"]["tail"] + defaults["timing"]["gap"]:.2f}s）', 1)
    # 4b) 并发合成上限（默认 4）。只重叠网络等待，不改请求内容或音频。
    src = src.replace('ap.add_argument("--maxspeed", type=float, default=1.28,',
                       'ap.add_argument("--tts-concurrency", type=int, choices=range(1, 9), default=4, dest="tts_concurrency",\n'
                      '                help="并发合成的句数上限（1–8）；只重叠网络等待，不改变音频")\n'
                      'ap.add_argument("--maxspeed", type=float, default=1.28,', 1)

    # 5) 身份字段改自有名
    src = src.replace('"measurement": {"voice": args.voice, "speed": args.speed, "ttsIdentity": VOICE_CACHE_IDENTITY["signature"]},',
                      '"measurement": {"voice": args.voice, "speed": args.speed, "engineIdentity": VOICE_CACHE_IDENTITY["signature"]},', 1)

    # 6) 文件头标注：整段重写，不留 Kokoro 的过时描述。
    # 只换关键词会得到「TTS 配音（edge-tts-engine-v3）：Kokoro-82M-v1.1-zh（100 个中文音色）」
    # 这种自相矛盾的行——头部写 Kokoro、代码跑 edge-tts，读的人会被骗。
    src = src.replace(
        "本地开源 TTS 配音：Kokoro-82M-v1.1-zh（100 个中文音色），离线、可重跑。\n"
        "读 scene.html 的 SUBS 时间轴逐句对位，装不下会自动压语速并提示。\n\n"
        "用法（用任意 python 启动即可，脚本会自动切到 TTS 环境）：",
        f"TTS 配音（{MARK}）：微软 Edge 神经语音，在线合成、CPU 占用近零。\n"
        "读 scene.html 的 SUBS 时间轴逐句对位，装不下会自动压语速并提示。\n\n"
        "用法（用任意 python 启动即可，脚本会自动切到 TTS 环境）：\n"
        f"  默认音色 {args.voice}，语速 {args.speed}×；完整列表：edge-tts --list-voices", 1)
    src = src.replace(
        "环境：脚本会在找不到 kokoro 时，自动改用 $VIDEO_TTS_HOME/venv\n"
        "（默认 ~/.local/share/opencode/video-tts/venv）。没装过就跑 scripts/setup-tts.sh。",
        "环境：需要 edge-tts / soundfile / numpy。缺依赖时自动改用 $VIDEO_TTS_HOME/venv\n"
        "（默认 ~/.local/share/opencode/video-tts/venv）。安装：pip install edge-tts", 1)

    compile(src, str(target), "exec")
    # 不覆盖校验期间改变的内容，不通过符号链接写目标或备份。
    import os
    fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+", encoding="utf-8", newline="") as stream:
        if stream.read() != original:
            print("✗ 配音脚本在校验期间改变，未覆盖", file=sys.stderr)
            return 1
        with backup.open("x", encoding="utf-8") as saved:
            saved.write(original)
        stream.seek(0)
        stream.write(src)
        stream.truncate()
    print(f"✓ 已改为 edge-tts（音色 {args.voice}）")
    print(f"  备份：{backup.name}")
    print("  下一步：node vh.mjs measure --dir " + str(project))
    return 0


if __name__ == "__main__":
    sys.exit(main())
