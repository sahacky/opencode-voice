#!/usr/bin/env bash
# эмуляция powershell.exe для WSL-тестов: вызывается через обёртку Bun.spawn
# вместо настоящего PS. Понимает вызовы плагина:
#   '$env:TEMP …'            → печатает C:/t
#   -File <recorder> -Wav … -StopFlag … → «запись»: пишет wav, ждёт файл-флаг
#   прочее (Set-Clipboard …) → просто успех
# VOICE_PS_FAIL=1 — рекордер умирает сразу с ошибкой (микрофон не открылся).
set -u

args="$*"
case "$args" in
    *'$env:TEMP'*) printf 'C:/t\n'; exit 0 ;;
esac

if [[ "$args" == *"-File"* ]]; then
    if [ "${VOICE_PS_FAIL:-}" = "1" ]; then
        echo "voice-rec.ps1 : dshow device not found" >&2
        exit 1
    fi
    wav=""; flag=""
    prev=""
    for a in "$@"; do
        case "$prev" in
            -Wav) wav="$a" ;;
            -StopFlag) flag="$a" ;;
        esac
        prev="$a"
    done
    win2wsl() {
        local p="$1" drive rest
        drive="${p:0:1}"; drive="${drive,,}"
        rest="${p:3}"
        case "$rest" in \\*|/*) ;; *) rest="/$rest" ;; esac
        printf '%s/%s%s\n' "${VOICE_WIN_MNT:-/mnt}" "$drive" "$rest" | tr '\\' '/'
    }
    wavl="$(win2wsl "$wav")"; flagl="$(win2wsl "$flag")"
    mkdir -p "$(dirname "$wavl")"
    head -c 8192 /dev/zero > "$wavl"
    while [ ! -f "$flagl" ]; do sleep 0.1; done
    exit 0
fi

exit 0
