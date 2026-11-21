"""Execute complete original/upgraded scripts; mock only the model boundary.

Uses real numpy, soundfile, timeline parser, cache reads/writes and measurement.
No model download, GPU, ffmpeg or reconstructed implementation under test.
"""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
mock = '''from pathlib import Path
import os
import numpy as np
if os.environ.get('VH_FORBID_MODEL_IMPORT') == '1':
    raise RuntimeError('kokoro imported on cache hit')
log = Path(__file__).with_name('model.log')
def record(value):
    with log.open('a') as f: f.write(value + '\\n')
record('import')
class KPipeline:
    def __init__(self, **kwargs):
        assert kwargs['lang_code'] == 'z'
        assert kwargs['repo_id'] == 'hexgrad/Kokoro-82M-v1.1-zh'
        record('init')
    def __call__(self, text, voice, speed):
        record('synth:' + text)
        assert voice == 'zf_001' and 1.0 <= speed <= 1.000001
        yield None, None, np.concatenate([np.zeros(900), np.full(2400 + len(text), .25), np.zeros(900)])
'''

def run(project, forbid=False, extra=None, success=True):
    env = dict(os.environ)
    env.pop('_VIDEO_TTS_REEXEC', None)  # Exercise the startup import probe too.
    env['HF_HUB_CACHE'] = str(root / 'hub')
    env['VH_FORBID_MODEL_IMPORT'] = '1' if forbid else '0'
    result = subprocess.run([sys.executable, str(project / 'voice-kokoro.py'), *(extra or ['--measure', '--apply'])],
                            cwd=project, env=env, capture_output=True, text=True)
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    return result

def outputs(project):
    timing = json.loads((project / 'timing.json').read_text())
    timing['measurement'].pop('ttsIdentity', None)
    return (timing,
             [(project / f'out/.voice-kokoro/{i:02d}.wav').read_bytes() for i in range(2)])

repo = root / 'hub/models--hexgrad--Kokoro-82M-v1.1-zh'
snapshot = repo / 'snapshots' / ('a' * 40)
(repo / 'refs').mkdir(parents=True)
(repo / 'refs/main').write_text('a' * 40)
(snapshot / 'voices').mkdir(parents=True)
for name in ('config.json', 'kokoro-v1_1-zh.pth', 'voices/zf_001.pt'):
    (snapshot / name).write_bytes(b'mock local model bytes')
# Real Hugging Face snapshots link into repository-local blobs. Hash target
# bytes; do not reject this normal layout or trust the blob filename as a hash.
(repo / 'blobs').mkdir()
(repo / 'blobs/config').write_bytes((snapshot / 'config.json').read_bytes())
(snapshot / 'config.json').unlink()
(snapshot / 'config.json').symlink_to('../../blobs/config')

for name in ('baseline', 'cache'):
    project = root / name
    (project / 'kokoro.py').write_text(mock)
    (project / 'misaki.py').write_text('raise RuntimeError("misaki must not be imported by identity probe")\n')
    (project / 'entts.py').write_text('import os\nif os.environ.get("VH_FORBID_MODEL_IMPORT") == "1": raise RuntimeError("entts imported on hit")\nen_callable = lambda text: text\n')
    (project / '脚本.md').write_text('## S1\n1. 你好。\n2. 第二句。\n')
    subs = [{'s': 0, 'e': 3, 't': '你好。'}, {'s': 4, 'e': 7, 't': '第二句。'}]
    (project / 'scene.html').write_text('const SUBS = ' + json.dumps(subs) + ';\naddScene(0, 8, {});\nconst DURATION=8;')
    run(project)
    log = (project / 'model.log').read_text().splitlines()
    assert log == ['import', 'init', 'synth:你好。', 'synth:第二句。'], log

assert outputs(root / 'baseline') == outputs(root / 'cache'), 'cold output changed'
project = root / 'cache'
before = outputs(project)
cache_root = project / 'out/.voice-kokoro/cache'
cache_before = {p.relative_to(cache_root).as_posix(): p.read_bytes() for p in cache_root.rglob('*.wav')}
# A cache-only rerun must not execute even a single kokoro/entts import.
run(project, forbid=True)
assert outputs(project) == before, 'warm output changed'
assert {p.relative_to(cache_root).as_posix(): p.read_bytes() for p in cache_root.rglob('*.wav')} == cache_before
assert (project / 'model.log').read_text().splitlines() == ['import', 'init', 'synth:你好。', 'synth:第二句。']

def signature():
    return json.loads((project / 'timing.json').read_text())['measurement']['ttsIdentity']

first = signature()
# Byte-only pronunciation changes must make old timing and all old sentence WAVs stale.
with (project / 'entts.py').open('a') as stream:
    stream.write('# changed pronunciation policy\n')
rejected = run(project, forbid=True, extra=['--retime'], success=False)
assert 'TTS inputs changed' in rejected.stderr
assert signature() == first, 'failed retime changed timing'
run(project)
assert signature() != first
assert len(list(cache_root.rglob('*.wav'))) == 4
assert len((project / 'model.log').read_text().splitlines()) == 8
run(project, forbid=True)

# Same repo/revision/file names are NOT proof that model bytes stayed unchanged.
second = signature()
(snapshot / 'kokoro-v1_1-zh.pth').write_bytes(b'different model bytes')
run(project)
assert signature() != second
assert len(list(cache_root.rglob('*.wav'))) == 6
assert len((project / 'model.log').read_text().splitlines()) == 12
run(project, forbid=True)

# Cache file/directory links must not redirect reads or --no-cache writes.
cache_file = next((cache_root / 'v2' / signature()).glob('*.wav'))
audio = cache_file.read_bytes()
outside = root / 'outside.wav'
outside.write_bytes(audio)
cache_file.unlink()
cache_file.symlink_to(outside)
run(project, forbid=True, success=False)
run(project, forbid=True, extra=['--measure', '--apply', '--no-cache'], success=False)
assert outside.read_bytes() == audio
cache_file.unlink()
cache_file.write_bytes(audio)
namespace = cache_file.parent
renamed = namespace.with_name(namespace.name + '-saved')
namespace.rename(renamed)
namespace.symlink_to(renamed, target_is_directory=True)
run(project, forbid=True, success=False)
namespace.unlink()
renamed.rename(namespace)

# Do not round distinct speeds together at the old five-decimal precision.
run(project, extra=['--measure', '--apply', '--speed', '1.000001'])
assert len(list(cache_root.rglob('*.wav'))) == 8
run(project, forbid=True, extra=['--measure', '--apply', '--speed', '1.000001'])

# A legacy v1 cache cannot be promoted solely because its filename matches.
old = hashlib.sha1('zf_001|1.00000|你好。'.encode()).hexdigest()[:16]
(cache_root / (old + '.wav')).write_bytes(b'not trusted audio')
for file in cache_root.glob('v2/*/*.wav'):
    file.unlink()
run(project)
assert len(list(cache_root.glob('v2/*/*.wav'))) == 2
assert (cache_root / (old + '.wav')).read_bytes() == b'not trusted audio'

# Missing locally identifiable weights must fail before importing any model.
(snapshot / 'kokoro-v1_1-zh.pth').unlink()
logs = (project / 'model.log').read_bytes()
run(project, forbid=True, success=False)
assert (project / 'model.log').read_bytes() == logs
(snapshot / 'kokoro-v1_1-zh.pth').write_bytes(b'different model bytes')
print('cold equivalence; warm zero imports; entts/model invalidation; exact speed; legacy isolation; offline missing-model guard: passed')
