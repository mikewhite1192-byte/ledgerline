#!/usr/bin/env bash
# Makes a demo phone call in public/samples/call/ from fixed synthetic text, with two of the
# computer's own text-to-speech voices (macOS `say` and `afconvert`): a dispatcher in English and
# a driver in Spanish. No real person's voice and no real names: the driver code is the seed's
# synthetic one. The call is cut into three segments of exactly 30 seconds, the way the office's
# browser posts them: 16 kHz mono 16-bit WAV, each under the phone line's 1 MB segment cap. The
# driver reports a lumper fee, asks for a diesel advance and asks about a settlement.
#
# macOS only: `say` and `afconvert` ship with macOS and nowhere else. python3 (the standard
# library's wave module) joins and cuts the clips.
#
# Usage: scripts/voice/make-call-samples.sh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "make-call-samples.sh runs on macOS only (it needs say and afconvert)." >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
out="public/samples/call"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pick_voice() {
  # The first installed voice for a locale, preferring the named one.
  local preferred="$1" locale="$2"
  if say -v '?' | grep -q "^${preferred} "; then
    echo "$preferred"
    return
  fi
  say -v '?' | awk -v loc="$locale" '$0 ~ loc { sub(/ +[a-z][a-z]_[A-Z][A-Z].*$/, ""); print; exit }'
}

es_voice="$(pick_voice Paulina es_MX)"
en_voice="$(pick_voice Samantha en_US)"
if [ -z "$es_voice" ] || [ -z "$en_voice" ]; then
  echo "Install a Spanish (Mexico) and an English (US) system voice first." >&2
  exit 1
fi

n=0
line() {
  # One turn of the call, in order, as its own 16 kHz clip.
  local voice="$1" text="$2"
  local name
  name="$(printf 'line-%02d' "$n")"
  say -v "$voice" -o "$work/$name.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$work/$name.aiff" "$work/$name.wav"
  n=$((n + 1))
}

line "$en_voice" "Hi, this is dispatch. How is the load going?"
line "$es_voice" "Hola, todo bien. Ya llegué con el recibidor, pero me cobraron ciento cincuenta dólares de lumper."
line "$en_voice" "Okay, send me the receipt and I will add the lumper to your settlement."
line "$es_voice" "Gracias. Otra cosa: ¿me puede dar un adelanto de trescientos dólares para diésel?"
line "$en_voice" "I can put in a three hundred dollar advance for diesel. Someone in the office approves it."
line "$es_voice" "Perfecto. Y una pregunta: ¿por qué mi pago de la semana pasada fue más bajo?"
line "$en_voice" "Let me look. Your settlement last week had one load less, and the detention was not on it yet."
line "$es_voice" "Sí, esperé cuatro horas en el cliente de Dallas el martes. Eso es detención, ¿verdad?"
line "$en_voice" "Yes. Four hours at the shipper counts as detention. I will add it to this week's settlement."
line "$es_voice" "Gracias. Y mañana, ¿tengo otra carga o me quedo en espera?"
line "$en_voice" "You have a load tomorrow at eight in the morning from Fort Worth to Memphis."
line "$es_voice" "Perfecto. Le mando el recibo del lumper en una hora."
line "$en_voice" "Sounds good. Drive safe, and call me if anything changes."
line "$es_voice" "Muy bien, gracias. Soy el conductor B R D cero siete. Hasta luego."

python3 - "$work" "$out" <<'PY'
import glob, os, sys, wave

work, out = sys.argv[1], sys.argv[2]
rate, segment_s, segments, gap_s = 16000, 30, 3, 0.6
frames = b""
for path in sorted(glob.glob(os.path.join(work, "line-*.wav"))):
    with wave.open(path, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (rate, 1, 2):
            sys.exit(f"{path}: not 16 kHz mono 16-bit")
        frames += w.readframes(w.getnframes())
    frames += b"\x00\x00" * int(rate * gap_s)
per_segment = rate * segment_s * 2
if len(frames) > per_segment * segments:
    sys.exit(f"the call runs {len(frames) / 2 / rate:.1f} s, past {segment_s * segments} s: shorten a line")
frames += b"\x00" * (per_segment * segments - len(frames))
for seq in range(segments):
    path = os.path.join(out, f"call-{seq}.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames[seq * per_segment:(seq + 1) * per_segment])
    print(f"{path}: {os.path.getsize(path)} bytes")
PY
