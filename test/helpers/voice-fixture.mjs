// Local-only Python entry point matching the measure/mix CLI contract.
// The caller supplies the behavior (including fail-fast bodies for read-only tests).
export function voiceFixture(body) {
  return `import argparse
TTS_ENGINE = 'fixture'
parser = argparse.ArgumentParser()
parser.add_argument('--measure', action='store_true')
parser.add_argument('--apply', action='store_true')
parser.add_argument('--voice')
parser.add_argument('--speed', type=float)
parser.add_argument('--srt', action='store_true')
args = parser.parse_args()
if args.measure and not args.apply:
    parser.error('--measure requires --apply')
${body}\n`;
}
