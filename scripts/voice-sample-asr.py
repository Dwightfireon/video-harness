#!/usr/bin/env python3
"""离线高风险句配音 ASR 反查（仅使用本机已缓存的 faster-whisper-small）。

原则：
- 严格 local_files_only=True，绝不联网下载模型。
- 缺依赖或无缓存时优雅返回结构化 JSON（ok=False），不抛未捕获异常、不阻断小样生成。
- 转写仅作人工复听线索，不凭拼写差异自动断言念错。
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small")
    args = ap.parse_args()

    manifest_path = pathlib.Path(args.manifest).resolve()
    out_path = pathlib.Path(args.out).resolve()
    if not manifest_path.is_file():
        out_path.write_text(json.dumps({"ok": False, "reason": "找不到小样 manifest.json"}, ensure_ascii=False, indent=2))
        return 1

    try:
        from faster_whisper import WhisperModel
    except Exception:
        out_path.write_text(json.dumps({
            "ok": False,
            "reason": "当前 Python 环境未安装 faster_whisper（跳过离线转写，仍可直接打开 audition.html 试听）",
        }, ensure_ascii=False, indent=2))
        return 0

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sample_dir = manifest_path.parent
    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=True)
    except Exception as exc:
        out_path.write_text(json.dumps({
            "ok": False,
            "reason": f"未能从本机缓存加载 faster-whisper-{args.model}（未联网下载）：{str(exc)[:160]}",
        }, ensure_ascii=False, indent=2))
        return 0

    rows = []
    for item in manifest.get("items", []):
        wav = sample_dir / item["file"]
        if not wav.is_file():
            rows.append({"index": item["index"], "file": item["file"], "expected": item["text"], "transcript": "", "error": "缺少音频文件"})
            continue
        segments, _ = model.transcribe(str(wav), language="zh", beam_size=1, vad_filter=False)
        transcript = "".join(seg.text for seg in segments).strip()
        rows.append({
            "index": item["index"],
            "scene": item.get("scene"),
            "line": item.get("line"),
            "file": item["file"],
            "expected": item["text"],
            "spoken": item.get("spokenText", item["text"]),
            "transcript": transcript,
        })

    payload = {
        "ok": True,
        "model": f"faster-whisper-{args.model}",
        "offline": True,
        "note": "离线转写仅作人工复听线索；不凭同音字或英文拼写差异自动断言念错。",
        "items": rows,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
