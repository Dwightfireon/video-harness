#!/usr/bin/env python3
"""Offline integration tests of the patcher and complete generated voice script.

Run with the existing TTS venv Python (numpy/soundfile) and local ffmpeg:
  ~/.local/share/opencode/video-tts/venv/bin/python -B test/voice-edge-loop.test.py
No network, model download, or service synthesis. Only edge_tts is fake.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
PATCHER = ROOT / 'scripts/voice-edge-tts-patch.py'
ASSETS = Path(os.environ.get('VH_EDGE_TEST_ASSETS', str(Path.home() / '.config/opencode/skills/article-video/assets')))
_temp_root = Path(tempfile.gettempdir())
TEMP = str(_temp_root / 'opencode' if (_temp_root / 'opencode').is_dir() else _temp_root)

FAKE_EDGE = r'''
import asyncio
import io
import json
import os
from pathlib import Path
import numpy as np
import soundfile as sf

active = 0
class Communicate:
    def __init__(self, text, voice, rate):
        self.text, self.voice, self.rate = text, voice, rate
    async def stream(self):
        global active
        active += 1
        record = {'text': self.text, 'voice': self.voice, 'rate': self.rate, 'active': active}
        with Path('requests.jsonl').open('a') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        try:
            await asyncio.sleep(float(os.environ.get('VH_EDGE_DELAY', '.01')) * (4 if self.text == '慢句。' else 1))
            if self.text == os.environ.get('VH_EDGE_FAIL'):
                raise RuntimeError('fake network failure: ' + self.text)
            if self.text == os.environ.get('VH_EDGE_EMPTY'):
                return
            # Deliberately non-PCM16 floats, with real silence trimming/ffmpeg decode.
            n = int(os.environ.get('VH_EDGE_SAMPLES', '4800')) + sum(map(ord, self.text)) % 1700
            n = round(n / (1 + int(self.rate.rstrip('%')) / 100))
            w = np.r_[np.zeros(1200), np.sin(np.arange(n) * .071) * .333333, np.zeros(1600)]
            buf = io.BytesIO()
            sf.write(buf, w, 24000, format='WAV', subtype='FLOAT')
            payload = b'not audio' if self.text == os.environ.get('VH_EDGE_BAD_AUDIO') else buf.getvalue()
            yield {'type': 'WordBoundary', 'text': self.text}
            yield {'type': 'audio', 'data': payload[:100]}
            yield {'type': 'audio', 'data': payload[100:]}
        finally:
            active -= 1
'''

SITE_CUSTOMIZE = r'''
import os
from pathlib import Path
import sys
import weakref
import json
import numpy as np
import soundfile as sf
original = sf.write
original_read = sf.read
audio_refs = []
def read(*args, **kwargs):
    value, rate = original_read(*args, **kwargs)
    if os.environ.get('VH_EDGE_MEMORY_PROBE'):
        audio_refs.append(weakref.ref(value))
    return value, rate
sf.read = read
def write(file, *args, **kwargs):
    if os.environ.get('VH_EDGE_CACHE_FAIL') and '/cache/' in str(file):
        if os.environ.get('VH_EDGE_CACHE_FAIL') == 'value-error':
            raise ValueError('fake soundfile write failure')
        raise OSError('fake disk full')
    if os.environ.get('VH_EDGE_MEMORY_PROBE') and Path(str(file)).stem.isdigit():
        # Inspect the real generated script at its sentence output boundary.
        # Weak refs observe actual soundfile arrays without keeping them alive.
        state = sys._getframe(1).f_globals
        refs = state['_sentence_audio']
        report = {
            'sentence_refs': len(refs),
            'path_refs': sum(isinstance(v, Path) for v in refs.values()),
            'lookup_arrays': sum(isinstance(v, np.ndarray) for v in state['lookups'].values()),
            'module_arrays_except_current': [k for k, v in state.items() if isinstance(v, np.ndarray) and k != 'raw'],
            'mp3s_retained': 'mp3s' in state or 'mp3' in state,
            'resident_sf_arrays': sum(ref() is not None for ref in audio_refs),
        }
        with Path('memory-probe.jsonl').open('a') as probe:
            probe.write(json.dumps(report) + '\n')
    return original(file, *args, **kwargs)
sf.write = write
'''


class EdgeLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('ffmpeg') or not (ASSETS / 'voice-kokoro.py').is_file():
            raise unittest.SkipTest('requires local ffmpeg and installed stock article-video assets')
        cls.work = tempfile.TemporaryDirectory(prefix='vh-edge-loop-', dir=TEMP)
        cls.root = Path(cls.work.name)
        cls.seed = cls.root / 'seed'
        cls.seed.mkdir()
        shutil.copy(ASSETS / 'voice-kokoro.py', cls.seed / 'voice-kokoro.py')
        node = '''import {upgradeVoice} from './lib/voice-upgrade.mjs';
const result = upgradeVoice(process.argv[1]);
if (!result.changed) throw new Error(JSON.stringify(result));'''
        run = subprocess.run(['node', '--input-type=module', '-e', node, str(cls.seed)],
                             cwd=ROOT, text=True, capture_output=True)
        assert run.returncode == 0, run.stdout + run.stderr
        cls.stock = (cls.seed / 'voice-kokoro.py').read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.work.cleanup()

    def project(self, texts=None):
        project = Path(tempfile.mkdtemp(prefix='project-', dir=self.root))
        (project / 'voice-kokoro.py').write_bytes(self.stock)
        shutil.copy(ASSETS / 'timeline_utils.py', project / 'timeline_utils.py')
        (project / 'edge_tts.py').write_text(FAKE_EDGE)
        (project / 'sitecustomize.py').write_text(SITE_CUSTOMIZE)
        self.set_texts(project, texts or ['甲句。', '乙句。', '丙句。'])
        result = self.patch(project)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return project

    def set_texts(self, project, texts):
        (project / '脚本.md').write_text('## S1\n' + ''.join(f'{i}. {t}\n' for i, t in enumerate(texts, 1)))
        subs = [{'s': i * 4, 'e': i * 4 + 3, 't': t} for i, t in enumerate(texts)]
        (project / 'scene.html').write_text('const SUBS = ' + json.dumps(subs, ensure_ascii=False) +
                                          f';\naddScene(0, {len(texts)*4}, {{}});\nconst DURATION={len(texts)*4};')

    def patch(self, project):
        return subprocess.run([sys.executable, '-B', str(PATCHER), str(project)], cwd=ROOT,
                              capture_output=True, text=True)

    def run_voice(self, project, extra=(), flags=None, success=True, use_defaults=False):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(project))
        env.pop('_VIDEO_TTS_REEXEC', None)
        env.update(flags or {})
        started = time.monotonic()
        # Existing cache/concurrency tests hold the baseline voice/rate fixed;
        # a separate test exercises the user-selected new-project defaults.
        baseline = [] if use_defaults else ['--voice', 'zh-CN-XiaoyiNeural', '--speed', '1']
        run = subprocess.run([sys.executable, '-B', str(project / 'voice-kokoro.py'), *baseline, *extra],
                             cwd=project, env=env, capture_output=True, text=True, timeout=30)
        run.elapsed = time.monotonic() - started
        self.assertEqual(run.returncode == 0, success, run.stdout + run.stderr)
        return run

    def measure(self, project, extra=(), **kwargs):
        return self.run_voice(project, ['--measure', '--apply', *extra], **kwargs)

    def requests(self, project):
        file = project / 'requests.jsonl'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def audio_hash(self, project):
        return hashlib.sha256(b''.join(p.read_bytes() for p in sorted((project / 'out/.voice-kokoro').glob('[0-9][0-9].wav')))).hexdigest()

    def assert_no_outputs(self, project, scene):
        self.assertFalse((project / 'timing.json').exists())
        self.assertEqual((project / 'scene.html').read_bytes(), scene)
        self.assertFalse(list((project / 'out').glob('*.mp4')))

    def test_no_cache_skips_reads_but_does_not_require_disk(self):
        project = self.project()
        self.measure(project)
        before = self.audio_hash(project)
        self.measure(project, ['--no-cache'])
        self.assertEqual(len(self.requests(project)), 6)
        self.assertEqual(self.audio_hash(project), before)
        self.measure(project, ['--no-cache'], flags={'VH_EDGE_CACHE_FAIL': '1'})
        self.assertEqual(len(self.requests(project)), 9)

    def test_cache_write_failure_uses_memory(self):
        for failure in ('1', 'value-error'):
            with self.subTest(failure=failure):
                project = self.project()
                self.measure(project, flags={'VH_EDGE_CACHE_FAIL': failure})
                self.assertTrue((project / 'timing.json').is_file())
                self.assertFalse(list((project / 'out/.voice-kokoro/cache').rglob('*.wav')))

    def test_delivery_acceleration_and_atempo_use_original_thresholds(self):
        # Deliberately stop at the later missing-BGM guard, after executing the
        # real delivery loop and real atempo. No video rendering/mux is needed.
        project = self.project(['长句。', '长句。', '尾句。'])
        subs = [{'s': 0, 'e': .35, 't': '长句。'}, {'s': .4, 'e': .75, 't': '长句。'},
                {'s': .8, 'e': 3, 't': '尾句。'}]
        (project / 'scene.html').write_text('const SUBS = ' + json.dumps(subs, ensure_ascii=False) +
                                          ';\naddScene(0, 4, {});\nconst DURATION=4;')
        run = self.run_voice(project, ['--no-cache', '--bgm', 'missing-local-bgm.wav'],
                             flags={'VH_EDGE_SAMPLES': '24000', 'VH_EDGE_CACHE_FAIL': '1'}, success=False)
        self.assertEqual(run.stdout.count('压到 1.28× 仍超，再 atempo'), 2)
        self.assertIn('--bgm 指向的文件不存在', run.stdout)
        self.assertEqual([(r['text'], r['rate']) for r in self.requests(project)],
                         [('长句。', '+0%'), ('尾句。', '+0%'), ('长句。', '+28%')])
        self.assertFalse((project / 'timing.json').exists())
        self.assertFalse((project / 'out/.voice-kokoro/voice.wav').exists())
        self.assertTrue((project / 'out/.voice-kokoro/00_raw.wav').exists())
        self.assertEqual((project / 'out/.voice-kokoro/00_raw.wav').read_bytes(),
                         (project / 'out/.voice-kokoro/01_raw.wav').read_bytes())

    def test_duplicates_and_normalized_duplicates_request_once(self):
        project = self.project(['甲 句。', '乙句。', '甲句。', '甲\t句。', '乙句。'])
        self.measure(project)
        self.assertEqual([r['text'] for r in self.requests(project)], ['甲句。', '乙句。'])
        wavs = project / 'out/.voice-kokoro'
        self.assertEqual((wavs / '00.wav').read_bytes(), (wavs / '02.wav').read_bytes())
        self.assertEqual((wavs / '00.wav').read_bytes(), (wavs / '03.wav').read_bytes())

    def test_partial_network_failure_saves_success_and_retry_only_missing(self):
        project = self.project(['慢句。', '坏句。', '甲句。', '乙句。', '甲句。'])
        scene = (project / 'scene.html').read_bytes()
        failed = self.measure(project, flags={'VH_EDGE_FAIL': '坏句。'}, success=False)
        self.assertIn('坏句。', failed.stderr)
        self.assert_no_outputs(project, scene)
        self.assertEqual(len(list((project / 'out/.voice-kokoro/cache').rglob('*.wav'))), 3)
        self.assertEqual(len(self.requests(project)), 4)
        self.measure(project)
        self.assertEqual([r['text'] for r in self.requests(project)][4:], ['坏句。'])

    def test_empty_or_bad_audio_retains_other_results_and_never_muxes(self):
        for failure in ('VH_EDGE_EMPTY', 'VH_EDGE_BAD_AUDIO'):
            with self.subTest(failure=failure):
                project = self.project(['坏句。', '慢句。', '甲句。'])
                scene = (project / 'scene.html').read_bytes()
                self.run_voice(project, flags={failure: '坏句。'}, success=False)
                self.assert_no_outputs(project, scene)
                self.assertEqual(len(list((project / 'out/.voice-kokoro/cache').rglob('*.wav'))), 2)
                self.measure(project)
                self.assertEqual([r['text'] for r in self.requests(project)][3:], ['坏句。'])

    def test_concurrency_bound_and_quantized_cold_warm_equivalence(self):
        project = self.project(['慢句。'] + [f'句{i}。' for i in range(5)])
        self.measure(project, ['--tts-concurrency', '2'])
        self.assertEqual(max(r['active'] for r in self.requests(project)), 2)
        self.assertEqual(len(self.requests(project)), 6)
        before = self.audio_hash(project)
        timing = (project / 'timing.json').read_bytes()
        self.measure(project)
        self.assertEqual(len(self.requests(project)), 6)
        self.assertEqual(self.audio_hash(project), before)
        self.assertEqual((project / 'timing.json').read_bytes(), timing)
        caches = list((project / 'out/.voice-kokoro/cache').rglob('*.wav'))
        self.assertTrue(all(sf.info(p).subtype == 'PCM_16' for p in caches))
        self.assertEqual({p.read_bytes() for p in caches},
                         {p.read_bytes() for p in (project / 'out/.voice-kokoro').glob('[0-9][0-9].wav')})

        # Keep the unittest method count at 12 for the Node wrapper. This is an
        # additional runtime probe, not a reconstructed loop or source check.
        for mode in ('cold', 'warm', 'no-cache'):
            with self.subTest(memory_probe=mode):
                project = self.project([f'内存句{i}。' for i in range(16)])
                expected = None
                if mode != 'cold':
                    self.measure(project)
                    expected = self.audio_hash(project)
                if mode == 'no-cache':
                    # A forced refresh must read newly written WAVs, not these
                    # old (valid, but different) cache samples.
                    for cache in (project / 'out/.voice-kokoro/cache').rglob('*.wav'):
                        sf.write(cache, np.full(24, .75), 24000)
                self.measure(project, ['--no-cache'] if mode == 'no-cache' else [],
                             flags={'VH_EDGE_MEMORY_PROBE': '1'})
                reports = [json.loads(line) for line in (project / 'memory-probe.jsonl').read_text().splitlines()]
                self.assertEqual(len(reports), 16)
                for report in reports:
                    self.assertEqual(report['sentence_refs'], 16)
                    self.assertEqual(report['path_refs'], 16)
                    self.assertEqual(report['lookup_arrays'], 0)
                    self.assertEqual(report['module_arrays_except_current'], [])
                    self.assertFalse(report['mp3s_retained'])
                    self.assertEqual(report['resident_sf_arrays'], 1)
                if expected is not None:
                    self.assertEqual(self.audio_hash(project), expected)

    def test_symlink_and_invalid_cache_guards(self):
        for no_cache in (False, True):
            with self.subTest(no_cache=no_cache):
                project = self.project()
                self.measure(project)
                cache = next((project / 'out/.voice-kokoro/cache').rglob('*.wav'))
                outside = project / 'outside.wav'
                outside.write_bytes(cache.read_bytes())
                original = outside.read_bytes()
                cache.unlink()
                cache.symlink_to(outside)
                self.measure(project, ['--no-cache'] if no_cache else [], success=False)
                self.assertEqual(outside.read_bytes(), original)

        for kind in ('rate', 'stereo', 'empty', 'nan', 'directory'):
            with self.subTest(kind=kind):
                project = self.project()
                self.measure(project)
                cache = next((project / 'out/.voice-kokoro/cache').rglob('*.wav'))
                timing = (project / 'timing.json').read_bytes()
                if kind == 'directory':
                    cache.unlink()
                    cache.mkdir()
                else:
                    audio = (np.zeros((30, 2)) if kind == 'stereo' else np.zeros(0) if kind == 'empty'
                             else np.full(30, np.nan) if kind == 'nan' else np.zeros(30))
                    sf.write(cache, audio, 16000 if kind == 'rate' else 24000, subtype='FLOAT')
                self.measure(project, success=False)
                self.assertEqual((project / 'timing.json').read_bytes(), timing)
                self.assertEqual(len(self.requests(project)), 3)

    def test_failure_does_not_overwrite_previous_measurement(self):
        project = self.project()
        self.measure(project)
        timing = (project / 'timing.json').read_bytes()
        scene = (project / 'scene.html').read_bytes()
        output_hash = self.audio_hash(project)
        failed = self.measure(project, ['--no-cache'], flags={'VH_EDGE_FAIL': '乙句。'}, success=False)
        self.assertIn('未生成 timing 或混流', failed.stderr)
        self.assertEqual((project / 'timing.json').read_bytes(), timing)
        self.assertEqual((project / 'scene.html').read_bytes(), scene)
        self.assertEqual(self.audio_hash(project), output_hash)

    def test_request_parameters_and_invalid_concurrency(self):
        project = self.project()
        self.measure(project, ['--speed', '1.15', '--voice', 'zh-CN-YunxiNeural', '--tts-concurrency', '1'])
        self.assertEqual({(r['rate'], r['voice'], r['active']) for r in self.requests(project)},
                         {('+15%', 'zh-CN-YunxiNeural', 1)})
        timing = (project / 'timing.json').read_bytes()
        for limit in ('0', '9', '-1'):
            self.measure(project, ['--tts-concurrency', limit], success=False)
        self.assertEqual(len(self.requests(project)), 3)
        self.assertEqual((project / 'timing.json').read_bytes(), timing)

    def test_new_project_defaults_match_selected_xiaoxiao_audition(self):
        project = self.project()
        self.measure(project, use_defaults=True)
        self.assertEqual({(r['voice'], r['rate']) for r in self.requests(project)},
                         {('zh-CN-XiaoxiaoNeural', '+25%')})
        timing = json.loads((project / 'timing.json').read_text())
        self.assertEqual(timing['measurement']['voice'], 'zh-CN-XiaoxiaoNeural')
        self.assertEqual(timing['measurement']['speed'], 1.25)
        for i in range(2):
            dur = sf.info(project / f'out/.voice-kokoro/{i:02d}.wav').duration
            # Audio end -> next start is tail .15 + gap .20, allowing 2dp timing.
            current, following = timing['subs'][i:i + 2]
            self.assertAlmostEqual(following['s'] - current['s'] - dur, .35, delta=.015)
            self.assertAlmostEqual(current['e'] - current['s'] - dur, .15, delta=.015)
        self.assertIn('句间额外留白约 0.35s', self.measure(project, use_defaults=True).stdout)

    def test_unknown_and_old_scripts_are_not_overwritten(self):
        for marker in ('edge-tts-engine-v1', 'edge-tts-engine-v2', 'custom'):
            with self.subTest(marker=marker):
                project = Path(tempfile.mkdtemp(dir=self.root))
                source = '# ' + marker + '\ndef synth_cached(): pass\nVOICE_CACHE_IDENTITY = None\n'
                (project / 'voice-kokoro.py').write_text(source)
                result = self.patch(project)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((project / 'voice-kokoro.py').read_text(), source)
                self.assertFalse(list(project.glob('*.bak-*')))

        for source in (self.stock + b'\n# unknown customization\n', self.stock.replace(b'\n', b'\r\n')):
            with self.subTest(source_hash=hashlib.sha256(source).hexdigest()):
                project = Path(tempfile.mkdtemp(dir=self.root))
                (project / 'voice-kokoro.py').write_bytes(source)
                result = self.patch(project)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((project / 'voice-kokoro.py').read_bytes(), source)
                self.assertFalse(list(project.glob('*.bak-*')))

    def test_patcher_is_idempotent_and_refuses_target_symlink(self):
        project = self.project()
        script = (project / 'voice-kokoro.py').read_bytes()
        backups = list(project.glob('*.bak-*'))
        self.assertEqual(self.patch(project).returncode, 0)
        self.assertEqual((project / 'voice-kokoro.py').read_bytes(), script)
        self.assertEqual(list(project.glob('*.bak-*')), backups)
        outside = project / 'outside.py'
        (project / 'voice-kokoro.py').rename(outside)
        (project / 'voice-kokoro.py').symlink_to(outside)
        self.assertNotEqual(self.patch(project).returncode, 0)
        self.assertEqual(outside.read_bytes(), script)


def benchmark_v2(baseline_patcher):
    """Small same-input A/B; execute both complete generated scripts, not text checks."""
    global PATCHER
    current = PATCHER
    EdgeLoopTests.setUpClass()
    case = EdgeLoopTests()
    rows = []
    try:
        for workload, texts in [('unique-8', [f'句{i}。' for i in range(8)]),
                                ('repeat-12-unique-6', [f'句{i % 6}。' for i in range(12)])]:
            reference = None
            for version, patcher in [('v2', Path(baseline_patcher).resolve()), ('v3', current)]:
                PATCHER = patcher
                for limit in (1, 4):
                    project = case.project(texts)
                    run = case.measure(project, ['--tts-concurrency', str(limit)], flags={'VH_EDGE_DELAY': '.025'})
                    requests = case.requests(project)
                    timing = json.loads((project / 'timing.json').read_text())
                    timing['measurement'].pop('engineIdentity')
                    output = (case.audio_hash(project), timing)
                    if reference is None:
                        reference = output
                    case.assertEqual(output, reference, 'audio or timeline differs from v2 same-load baseline')
                    rows.append({'load': workload, 'version': version, 'limit': limit,
                                 'requests': len(requests), 'peak_active': max(r['active'] for r in requests),
                                 'seconds': round(run.elapsed, 4), 'wav_sha256': output[0]})
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    finally:
        PATCHER = current
        EdgeLoopTests.tearDownClass()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--benchmark-v2':
        benchmark_v2(sys.argv[2])
    else:
        unittest.main()
