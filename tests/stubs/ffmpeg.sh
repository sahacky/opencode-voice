#!/usr/bin/env bash
# стаб ffmpeg для интеграционных тестов: умеет -version, -devices и «запись» —
# выходной файл (последний аргумент) заполняется 8 КБ нулей.
# VOICE_STUB_HANG=1 — держит процесс живым до SIGINT/SIGTERM (режим /r → /s).
set -u

for a in "$@"; do
    if [ "$a" = "-version" ]; then
        echo "ffmpeg version stub-1.0-static (opencode-voice tests)"
        exit 0
    fi
    if [ "$a" = "-devices" ]; then
        printf '%s\n' '--devices:' ' D  alsa' ' D  pulse'
        exit 0
    fi
done

out="${@: -1}"
mkdir -p "$(dirname "$out")"
head -c 8192 /dev/zero > "$out" || exit 1

if [ "${VOICE_STUB_HANG:-}" = "1" ]; then
    trap 'exit 0' INT TERM
    while :; do sleep 0.2; done
fi
exit 0
