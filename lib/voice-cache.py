"""Read-only, stdlib-only identity for the known local Kokoro synthesis policy.

Never imports pronunciation/model code or calls Hugging Face. Hashes actual local
bytes, not filenames, mtimes, package versions, or an unverified cache manifest.
The functions above the CLI boundary are embedded in the known voice template.
"""
import hashlib
import importlib.machinery
import json
import os
from pathlib import Path
import re
import sys


def _vh_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _vh_file(file, root=None):
    file = Path(file)
    if root is None and file.is_symlink():
        raise ValueError("TTS identity requires a regular file: " + str(file))
    actual = file.resolve(strict=True)
    if root is not None and not actual.is_relative_to(Path(root).resolve(strict=True)):
        raise ValueError("TTS model link escapes its local repository")
    if not actual.is_file():
        raise ValueError("TTS identity requires a regular file: " + str(file))
    digest = hashlib.sha256()
    with actual.open("rb") as stream:
        before = os.fstat(stream.fileno())
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("TTS input changed while hashing")
    return digest.hexdigest()


def _vh_package(name, project):
    # PathFinder on a top-level name does not execute __init__.py. In particular,
    # do not use find_spec('kokoro.model'), which imports its parent package.
    spec = importlib.machinery.PathFinder.find_spec(name, [str(project), *sys.path])
    if spec is None or not spec.origin or not Path(spec.origin).is_file():
        raise ValueError("Cannot identify local TTS package: " + name)
    if not spec.submodule_search_locations:
        return {"module": _vh_file(spec.origin)}
    files = {}
    for location in sorted(spec.submodule_search_locations):
        base = Path(location)
        for file in sorted(base.rglob("*")):
            if "__pycache__" in file.parts or file.suffix in (".pyc", ".pyo"):
                continue
            if file.is_symlink() and file.is_dir():
                raise ValueError("TTS package contains a linked directory")
            if file.is_file():
                files[file.relative_to(base).as_posix()] = _vh_file(file)
    return files


def voice_cache_identity(project, script, voice):
    project = Path(project).resolve(strict=True)
    if not isinstance(voice, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", voice):
        raise ValueError("Invalid TTS voice identifier")
    # These are the default cache resolution rules used by huggingface_hub.
    hf_home = Path(os.environ.get("HF_HOME", str(Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "huggingface"))).expanduser()
    hub = Path(os.environ.get("HF_HUB_CACHE", os.environ.get("HUGGINGFACE_HUB_CACHE", str(hf_home / "hub")))).expanduser()
    repo = hub / "models--hexgrad--Kokoro-82M-v1.1-zh"
    ref = repo / "refs/main"
    _vh_file(ref)
    revision = ref.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[a-fA-F0-9]{40,64}", revision):
        raise ValueError("Cannot identify local Kokoro main revision")
    snapshot = repo / "snapshots" / revision
    model = {name: _vh_file(snapshot / name, hub) for name in
             ("config.json", "kokoro-v1_1-zh.pth", "voices/" + voice + ".pt")}
    inputs = {
        "version": 2,
        "policy": "kokoro-zh/local-main/trim-25ms-rel0.02/sr24000/exact-speed-v2",
        "script": _vh_file(script),
        "entts": _vh_file(project / "entts.py"),
        "timeline": _vh_file(project / "timeline_utils.py"),
        "python": sys.version,
        "packages": {name: _vh_package(name, project) for name in ("kokoro", "misaki")},
        "model": {"repo": "hexgrad/Kokoro-82M-v1.1-zh", "revision": revision, "files": model},
    }
    return {"version": 2, "signature": hashlib.sha256(_vh_json(inputs).encode("utf-8")).hexdigest(), "inputs": inputs}


def _vh_check_timing(data, project, script, identity=None):
    measured = data.get("measurement", {})
    identity = identity or voice_cache_identity(project, script, measured.get("voice"))
    if measured.get("ttsIdentity") != identity["signature"]:
        raise ValueError("TTS inputs changed or timing lacks cache identity; run vh measure again")
    return identity


# CLI boundary: only the functions above are embedded in the voice script.
if __name__ == "__main__":
    try:
        import importlib.util
        selection, project, script, voice = sys.argv[1:]
        project = str(Path(project).resolve(strict=True))
        # Python normally puts this trusted helper's directory at path[0]. The
        # real CLI instead starts voice-kokoro.py in the project directory.
        # -B preserves PYTHONPATH/site resolution; safe_path, if requested by
        # the caller, excludes path[0] in both processes.
        if not getattr(sys.flags, "safe_path", False):
            sys.path[0] = project
        if os.environ.get("_VIDEO_TTS_REEXEC") != "1":
            try:
                have_kokoro = importlib.util.find_spec("kokoro") is not None
            except Exception:
                have_kokoro = False
            if not have_kokoro:
                home = os.environ.get("VIDEO_TTS_HOME", os.path.expanduser("~/.local/share/opencode/video-tts"))
                python = os.path.join(home, "venv", "bin", "python")
                if not os.path.exists(python):
                    raise ValueError("Template would fail: no kokoro and no shared TTS interpreter")
                os.environ["_VIDEO_TTS_REEXEC"] = "1"
                os.execv(python, [python, "-B", str(Path(__file__).resolve()), "template-reexec", project, script, voice])
        # The known template inserts HERE after the bootstrap, even when the
        # caller has requested PYTHONSAFEPATH. Do not import any model module.
        sys.path.insert(0, project)
        identity = voice_cache_identity(project, script, voice)
        identity["probeRuntime"] = {
            "executable": sys.executable,
            "selection": selection,
            "isolated": bool(sys.flags.isolated),
            "bytecodeDisabled": bool(sys.dont_write_bytecode),
            "packageSearchPath": sys.path,
            "synthesisRuntimeVerified": True,
        }
        print(_vh_json(identity))
    except Exception as error:
        print(_vh_json({"error": str(error)}))
        sys.exit(1)
