#!/usr/bin/env bash
# install.sh — установка opencode-voice одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/sahacky/opencode-voice/main/install.sh | bash
#
# Самопроверка чистой логики без сети и sudo:
#
#   bash install.sh --selftest
#
# Что делает установка:
#   1. Определяет среду: WSL2 или нативный Linux
#   2. Ставит недостающие зависимости (sudo где нужно; без apt/sudo — статический ffmpeg в ~/.local/bin)
#   3. Собирает whisper.cpp (пиннованная версия) и скачивает модель (интерактивный выбор,
#      по умолчанию large-v3-turbo-q5_0 ~575 МБ)
#   4. Кладёт плагин в ~/.config/opencode/plugins/ (авто-загрузка, без правки конфига)
#   5. Создаёт команды /r, /s, /v, /m (смена модели) и /u (самообновление)
#   6. Делает тестовую запись 2 с и отчёт о состоянии микрофона
#
# После установки перезапусти opencode. Кастомные команды /r /s /v работают только
# в TUI (не через `opencode run`).
set -euo pipefail

# ── функции ───────────────────────────────────────────────────────────────
say()  { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

model_valid() {
    case "$1" in
        tiny|base|small|medium|large-v3|large-v3-turbo|large-v3-turbo-q5_0) return 0 ;;
        *) return 1 ;;
    esac
}

model_size() {  # примерный размер, МБ
    case "$1" in
        tiny) echo 75 ;; base) echo 142 ;; small) echo 466 ;; medium) echo 1462 ;;
        large-v3) echo 2951 ;; large-v3-turbo) echo 1549 ;; large-v3-turbo-q5_0) echo 547 ;;
        *) echo "" ;;
    esac
}

apt_install() {
    if command -v apt-get >/dev/null; then
        # shellcheck disable=SC2086  # пустой SUDO — намеренно разворачивается без кавычек
        $SUDO apt-get update -qq
        # shellcheck disable=SC2086
        DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y "$@"
    else
        return 1
    fi
}

# обновляет ~/.config/opencode-voice/config.json: model (+ audioDriver на нативном Linux)
write_config() {
    mkdir -p "$CFG_DIR"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$CFG_DIR/config.json" "$1" "$2" <<'PY'
import json, sys, pathlib
p, model, driver = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
    if not isinstance(d, dict):
        raise ValueError
except Exception:
    d = {}
d.setdefault("language", "ru")
if model:
    d["model"] = model
if driver:
    d["audioDriver"] = driver
pathlib.Path(p).write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
    elif [ ! -f "$CFG_DIR/config.json" ]; then
        { printf '{"language": "ru", "model": "%s"' "$1"
          [ -n "$2" ] && printf ', "audioDriver": "%s"' "$2"
          printf '}\n'; } > "$CFG_DIR/config.json"
    else
        warn "нет python3 — добавь \"model\": \"$1\"$([ -n "$2" ] && printf ' и \"audioDriver\": \"%s\"' "$2") в $CFG_DIR/config.json вручную"
    fi
    return 0
}

# ── константы ─────────────────────────────────────────────────────────────
WHISPER_REF="v1.9.3"            # пин для воспроизводимой сборки whisper-cli
VOICE_HOME="$HOME/.voice"
WHISPER_DIR="$VOICE_HOME/whisper.cpp"
WHISPER_BIN="$WHISPER_DIR/build/bin/whisper-cli"
CFG_DIR="$HOME/.config/opencode-voice"

# ── selftest: чистая логика без сети, sudo и скачиваний ───────────────────
if [ "${1:-}" = "--selftest" ]; then
    pass=0; fail=0
    chk() {  # имя ожидаемое фактическое
        if [ "$2" = "$3" ]; then
            pass=$((pass + 1)); printf '  \033[1;32m✓\033[0m %s\n' "$1"
        else
            fail=$((fail + 1)); printf '  \033[1;31m✗ %s: ожидалось «%s», получено «%s»\033[0m\n' "$1" "$2" "$3" >&2
        fi
    }

    chk "дефолт модели"          "large-v3-turbo-q5_0" "${VOICE_MODEL:-large-v3-turbo-q5_0}"
    chk "кривая модель отклоняется" "1"                 "$(model_valid bogus >/dev/null 2>&1 && echo 0 || echo 1)"

    for m in tiny base small medium large-v3 large-v3-turbo large-v3-turbo-q5_0; do
        chk "валидность $m"      "0" "$(model_valid "$m" && echo 0 || echo 1)"
        chk "размер $m задан"    "да" "$([ -n "$(model_size "$m")" ] && echo да || echo нет)"
    done
    chk "размер q5_0"            "547" "$(model_size large-v3-turbo-q5_0)"
    chk "размер неизвестной пуст" ""    "$(model_size nope)"

    if command -v python3 >/dev/null 2>&1; then
        T="$(mktemp -d)"; CFG_DIR="$T"
        write_config "/tmp/model-a.bin" "alsa"
        chk "write_config: создание" "/tmp/model-a.bin alsa ru" "$(
            python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["model"], d["audioDriver"], d["language"])' "$T/config.json")"
        printf '{"submit": true}' > "$T/config.json"
        write_config "/tmp/model-b.bin" ""
        chk "write_config: merge чужих ключей" "True /tmp/model-b.bin" "$(
            python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("submit"), d["model"])' "$T/config.json")"
        rm -rf "$T"
    else
        say "python3 нет — проверки write_config пропущены"
    fi

    printf 'selftest: %d ok, %d fail\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

say 'что потребует установка:'
say '  • диск: модель (0.6–3 ГБ по выбору) + исходники и сборка whisper.cpp ~1 ГБ'
say '  • компилятор и cmake — поставим через apt с sudo, если их нет'
say '  • без sudo и apt тоже получится: ffmpeg встанет статикой в ~/.local/bin'
say '  • команды /r /s /v проверяй в TUI opencode, `opencode run` их не запускает'

# ── 0. Модель ─────────────────────────────────────────────────────────────
MODEL="${VOICE_MODEL:-}"

if [ -z "$MODEL" ] && [ "${1:-}" != "--selftest" ] && [ -t 0 ] && [ -t 1 ]; then
    say 'выбери модель распознавания (whisper, мультиязычная):'
    cat <<'EOF'
  1) large-v3-turbo-q5_0   ~575 МБ   рекомендуется: качество уровня large-v3, скромный размер
  2) large-v3-turbo        ~1.6 ГБ   то же качество без квантования, больше RAM
  3) large-v3              ~3 ГБ     максимум качества, медленнее на CPU
  4) small                 ~466 МБ   заметно хуже на русском, но быстрее на слабом CPU
  5) base                  ~142 МБ   минимум, только попробовать
EOF
    printf 'номер модели [1]: '
    read -r choice || true
    case "${choice:-1}" in
        1) MODEL=large-v3-turbo-q5_0 ;;
        2) MODEL=large-v3-turbo ;;
        3) MODEL=large-v3 ;;
        4) MODEL=small ;;
        5) MODEL=base ;;
        *) die "неизвестный номер: ${choice:-} (или задай VOICE_MODEL=tiny|base|small|medium|large-v3|large-v3-turbo|large-v3-turbo-q5_0)" ;;
    esac
fi
: "${MODEL:=large-v3-turbo-q5_0}"
model_valid "$MODEL" || die "неизвестная модель: $MODEL"

# при запуске через curl | bash исходников рядом нет — скачиваем из репозитория
SRC_DIR=""
SELF="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}" 2>/dev/null)" 2>/dev/null && pwd)"
if [ -n "$SELF" ] && [ -f "$SELF/src/index.ts" ]; then
    SRC_DIR="$SELF/src"
else
    say "скачиваю исходники opencode-voice"
    TMP="$(mktemp -d)"
    curl -fsSL https://github.com/sahacky/opencode-voice/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP" --strip-components=1
    SRC_DIR="$TMP/src"
fi

# ── 1. Среда ─────────────────────────────────────────────────────────────
if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    is_wsl=1
    say "среда: WSL2"
else
    is_wsl=0
    say "среда: нативный Linux"
fi

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null; then SUDO="sudo"; fi

# ── 2. Зависимости ───────────────────────────────────────────────────────
FFBIN=""
FFEXE=""
DEV=""
DRIVER=""
HAS_PULSE=0
HAS_ALSA=0

if [ "$is_wsl" -eq 1 ]; then
    PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    [ -x "$PS" ] || die "powershell.exe не найден — это WSL2?"

    # </dev/null обязательно: powershell иначе съедает stdin-пайп с текстом скрипта (curl | bash)
    FFEXE="$("$PS" -NoProfile -Command '
        $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
        $c = Get-Command ffmpeg -ErrorAction SilentlyContinue
        if ($c) { $c.Source; exit 0 }
        $p = "$env:USERPROFILE\.voice\bin\ffmpeg.exe"
        if (Test-Path $p) { $p; exit 0 }
        exit 1
    ' </dev/null 2>/dev/null | tr -d '\r')" || FFEXE=""

    if [ -z "$FFEXE" ]; then
        say "ставлю ffmpeg на сторону Windows (~100 МБ, сборка BtbN с GitHub)"
        "$PS" -NoProfile -Command '
            $ErrorActionPreference = "Stop"
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $dir = "$env:USERPROFILE\.voice\bin"
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $zip = "$env:TEMP\ffmpeg.zip"
            Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile $zip
            Expand-Archive -Path $zip -DestinationPath "$env:TEMP\ffmpeg-x" -Force
            $exe = Get-ChildItem "$env:TEMP\ffmpeg-x" -Recurse -Filter ffmpeg.exe | Select-Object -First 1
            Copy-Item $exe.FullName "$dir\ffmpeg.exe" -Force
            Remove-Item $zip -Force
            Remove-Item "$env:TEMP\ffmpeg-x" -Recurse -Force
       ' >/dev/null 2>&1 </dev/null
        FFEXE="$("$PS" -NoProfile -Command 'if (Test-Path "$env:USERPROFILE\.voice\bin\ffmpeg.exe") { "$env:USERPROFILE\.voice\bin\ffmpeg.exe" }' </dev/null 2>/dev/null | tr -d '\r')" || FFEXE=""
    fi
    [ -n "$FFEXE" ] || die "не удалось поставить/найти ffmpeg.exe на стороне Windows"
    ok "ffmpeg (Windows): $FFEXE"

    # dshow-устройство по умолчанию — в конфиг для voice-rec.ps1
    DEV="$("$PS" -NoProfile -Command "
        \$out = & '$FFEXE' -list_devices true -f dshow -i dummy 2>&1 | Out-String
        if (\$out -match '\"([^\"]+)\" \(audio\)') { \$Matches[1] }
        exit 0
    " </dev/null 2>/dev/null | tr -d '\r' | head -n1)" || true
    if [ -n "$DEV" ]; then
        DEVE="${DEV//\'/\'\'}"
        "$PS" -NoProfile -Command "@{ device = '$DEVE' } | ConvertTo-Json -Compress | Set-Content -Path \"\$env:USERPROFILE\.voice\config.json\" -Encoding UTF8" </dev/null >/dev/null 2>&1 || true
        ok "микрофон dshow: $DEV (записан в %USERPROFILE%\\.voice\\config.json)"
    else
        warn "dshow-аудиоустройство не найдено — задай \"device\" в %USERPROFILE%\\.voice\\config.json вручную"
    fi
else
    if command -v ffmpeg >/dev/null; then
        FFBIN="$(command -v ffmpeg)"
    else
        apt_install ffmpeg || true
        command -v ffmpeg >/dev/null && FFBIN="$(command -v ffmpeg)"
    fi

    # нет apt/sudo (сервер, контейнер) — статическая сборка в ~/.local/bin (умеет alsa)
    if [ -z "$FFBIN" ]; then
        [ "$(uname -m)" = "x86_64" ] || die "нет apt для установки ffmpeg, а статическая сборка есть только для x86_64 — поставь ffmpeg вручную"
        say "apt/sudo недоступны — ставлю статический ffmpeg в ~/.local/bin"
        mkdir -p "$HOME/.local/bin"
        t="$(mktemp -d)"
        curl -fL --retry 3 -o "$t/ff.tar.xz" https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
        tar -xJf "$t/ff.tar.xz" -C "$t" --strip-components=1
        mv "$t/ffmpeg" "$HOME/.local/bin/ffmpeg"
        chmod +x "$HOME/.local/bin/ffmpeg"
        rm -rf "$t"
        FFBIN="$HOME/.local/bin/ffmpeg"
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) warn "добавь ~/.local/bin в PATH (например, в ~/.profile), чтобы opencode видел ffmpeg" ;;
        esac
        export PATH="$HOME/.local/bin:$PATH"
    fi
    ok "ffmpeg: $FFBIN"

    DEVOUT="$("$FFBIN" -hide_banner -devices 2>/dev/null || true)"
    grep -qi pulse <<<"$DEVOUT" && HAS_PULSE=1 || true
    grep -qi alsa <<<"$DEVOUT" && HAS_ALSA=1 || true
    if [ $((HAS_PULSE + HAS_ALSA)) -eq 0 ]; then
        die "в ffmpeg ($FFBIN) нет аудио-входов pulse/alsa — поставь дистрибутивный: sudo apt install ffmpeg"
    fi

    if [ "$HAS_PULSE" -eq 1 ] && { [ -e "/run/user/$(id -u)/pulse/native" ] || { command -v pactl >/dev/null && pactl info >/dev/null 2>&1; }; }; then
        DRIVER="pulse"
    elif [ "$HAS_ALSA" -eq 1 ]; then
        DRIVER="alsa"
        [ "$HAS_PULSE" -eq 1 ] && say "pulse-сервер не найден — записываю через alsa" || true
    else
        DRIVER="pulse"
        warn "pulse-сервер не запущен, alsa во входах нет — микрофон, скорее всего, не запишется (диагностика: /v в opencode)"
    fi
    say "аудиодрайвер: $DRIVER"

    if [ -n "${WAYLAND_DISPLAY:-}" ] && ! command -v wl-copy >/dev/null; then
        say "ставлю wl-copy (Wayland)"
        apt_install wl-clipboard || warn "не поставился wl-clipboard — проверь буфер обмена командой /v"
    fi
    if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -n "${DISPLAY:-}" ] && ! command -v xclip >/dev/null; then
        say "ставлю xclip (X11)"
        apt_install xclip || warn "не поставился xclip — проверь буфер обмена командой /v"
    fi
fi

# ── 3. whisper.cpp + модель ──────────────────────────────────────────────
if [ ! -x "$WHISPER_BIN" ]; then
    say "собираю whisper.cpp $WHISPER_REF (потребуется компилятор и cmake)"
    command -v cmake >/dev/null || apt_install cmake build-essential git || die "нет cmake/компилятора и нет sudo для их установки"
    mkdir -p "$VOICE_HOME"
    [ -d "$WHISPER_DIR" ] || git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
    # BUILD_SHARED_LIBS=OFF: whisper-cli не должен зависеть от libwhisper.so в LD_LIBRARY_PATH
    cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF >/dev/null
    cmake --build "$WHISPER_DIR/build" --config Release -j"$(nproc)" >/dev/null
fi
[ -x "$WHISPER_BIN" ] || die "сборка whisper-cli не удалась"
ok "whisper-cli: $WHISPER_BIN"

MODEL_FILE="$VOICE_HOME/models/ggml-$MODEL.bin"
if [ ! -s "$MODEL_FILE" ]; then
    say "скачиваю модель ggml-$MODEL.bin (~$(model_size "$MODEL") МБ)"
    mkdir -p "$VOICE_HOME/models"
    curl -fL --retry 3 -o "$MODEL_FILE.part" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
    mv "$MODEL_FILE.part" "$MODEL_FILE"
fi
ok "модель: $MODEL_FILE"

# ── 4. Плагин в автозагрузку opencode ────────────────────────────────────
PLUGINS="$HOME/.config/opencode/plugins"
mkdir -p "$PLUGINS"
cp "$SRC_DIR/index.ts" "$PLUGINS/opencode-voice.ts"
cp "$SRC_DIR/voice-rec.ps1" "$PLUGINS/voice-rec.ps1"
ok "плагин: $PLUGINS/opencode-voice.ts"

write_config "$MODEL_FILE" "$([ "$is_wsl" -eq 0 ] && echo "$DRIVER")"
ok "конфиг: $CFG_DIR/config.json (model$( [ "$is_wsl" -eq 0 ] && printf ', audioDriver=%s' "$DRIVER" ))"

# ── 5. Команды /r, /s и /v ───────────────────────────────────────────────
COMMANDS="$HOME/.config/opencode/commands"
mkdir -p "$COMMANDS"
[ -f "$COMMANDS/r.md" ] || cat > "$COMMANDS/r.md" <<'EOF'
---
description: ● Голос: начать запись
---
EOF
[ -f "$COMMANDS/s.md" ] || cat > "$COMMANDS/s.md" <<'EOF'
---
description: ■ Голос: закончить — текст в поле ввода
---
EOF
[ -f "$COMMANDS/v.md" ] || cat > "$COMMANDS/v.md" <<'EOF'
---
description: 🔧 Голос: проверить микрофон и whisper
---
EOF
[ -f "$COMMANDS/m.md" ] || cat > "$COMMANDS/m.md" <<'EOF'
---
description: ⇄ Голос: следующая модель по кольцу; на полном круге — докачка
---
EOF
[ -f "$COMMANDS/u.md" ] || cat > "$COMMANDS/u.md" <<'EOF'
---
description: ⤓ Голос: обновить плагин
---
EOF
ok "команды /r, /s, /v, /m и /u"

# ── 6. Тест микрофона ────────────────────────────────────────────────────
say "тест микрофона: запись 2 с"
if [ "$is_wsl" -eq 1 ]; then
    if [ -n "$DEV" ]; then
        SIZE="$("$PS" -NoProfile -Command "
            \$dev = (Get-Content -Raw \"\$env:USERPROFILE\.voice\config.json\" | ConvertFrom-Json).device
            & '$FFEXE' -y -hide_banner -loglevel error -f dshow -i ('audio=' + \$dev) -t 2 -ar 16000 -ac 1 \"\$env:TEMP\voice-test.wav\" 2>\$null
            if (Test-Path \"\$env:TEMP\voice-test.wav\") { (Get-Item \"\$env:TEMP\voice-test.wav\").Length; Remove-Item \"\$env:TEMP\voice-test.wav\" -Force }
            exit 0
        " </dev/null 2>/dev/null | tr -d '\r')" || true
        SIZE="${SIZE//[^0-9]/}"
        if [ -n "${SIZE:-}" ] && [ "$SIZE" -gt 4000 ]; then
            ok "микрофон проверен (dshow)"
        else
            warn "микрофон не записал. Проверь, что он включён в Windows и виден ffmpeg:"
            warn "  $FFEXE -list_devices true -f dshow -i dummy"
        fi
    else
        warn "пропускаю тест: dshow-устройство не определено"
    fi
else
    TD="$(mktemp -d)"
    mic_try() {
        timeout 15 "$FFBIN" -y -hide_banner -loglevel error -f "$1" -i default \
            -t 2 -ar 16000 -ac 1 "$TD/v.wav" >/dev/null 2>"$TD/err"
        [ -s "$TD/v.wav" ] && [ "$(stat -c%s "$TD/v.wav")" -gt 4000 ]
    }
    if mic_try "$DRIVER"; then
        ok "микрофон проверен ($DRIVER)"
    else
        ALT=""
        [ "$DRIVER" = "pulse" ] && [ "$HAS_ALSA" -eq 1 ] && ALT="alsa"
        [ "$DRIVER" = "alsa" ] && [ "$HAS_PULSE" -eq 1 ] && ALT="pulse"
        if [ -n "$ALT" ] && mic_try "$ALT"; then
            DRIVER="$ALT"
            write_config "$MODEL_FILE" "$DRIVER"
            ok "микрофон проверен (через $DRIVER — записал audioDriver в конфиг)"
        else
            warn "микрофон не записал. Частые причины:"
            warn "  • нет прав на /dev/snd → sudo usermod -aG audio \$USER и перелогинься"
            warn "  • неверный audioSource → смотри устройства: arecord -l (alsa) / pactl list sources short (pulse)"
            warn "    и задай \"audioSource\" в $CFG_DIR/config.json"
            warn "  • полный отчёт: запусти /v внутри opencode (TUI)"
            if [ -s "$TD/err" ]; then warn "ffmpeg: $(head -n1 "$TD/err")"; fi
        fi
    fi
    rm -rf "$TD"
fi

echo
ok "готово. Перезапусти opencode: /r — запись, /s — расшифровка в поле ввода, /v — диагностика."
