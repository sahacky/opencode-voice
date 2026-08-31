#!/usr/bin/env bash
# стаб ffmpeg для интеграционных тестов. Режимы (через env):
#   VOICE_STUB_HANG=1          — «запись» живёт до SIGINT/SIGTERM (циклы /r → /s)
#   VOICE_STUB_FAIL_DRIVER=X   — вход «-f X» падает сразу, без wav (смерть рекордера)
#   VOICE_STUB_NOWAV=1         — запись живёт, но wav не пишется (пустая запись)
#   VOICE_STUB_DEVICES="…"     — что показывать в -devices (по умолчанию alsa и pulse)
set -u

for a in "$@"; do
    if [ "$a" = "-version" ]; then
        echo "ffmpeg version stub-1.0-static (opencode-voice tests)"
        exit 0
    fi
    if [ "$a" = "-devices" ]; then
        for d in ${VOICE_STUB_DEVICES:-"alsa pulse"}; do printf ' D  %s\n' "$d"; done
        exit 0
    fi
done

driver=""
prev=""
for a in "$@"; do
    [ "$prev" = "-f" ] && driver="$a"
    prev="$a"
done
if [ -n "${VOICE_STUB_FAIL_DRIVER:-}" ] && [ "$driver" = "$VOICE_STUB_FAIL_DRIVER" ]; then
    echo "stub: cannot open ${driver} device" >&2
    exit 1
fi

if [ "${VOICE_STUB_NOWAV:-}" != "1" ]; then
    out="${@: -1}"
    mkdir -p "$(dirname "$out")"
    head -c 8192 /dev/zero > "$out" || exit 1
fi

if [ "${VOICE_STUB_HANG:-}" = "1" ]; then
    trap 'exit 0' INT TERM
    while :; do sleep 0.2; done
fi
exit 0
