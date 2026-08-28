#!/usr/bin/env bash
# install.sh — установка opencode-voice одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/sahacky/opencode-voice/main/install.sh | bash
#
# Что делает:
#   1. Определяет среду: WSL2 или нативный Linux
#   2. Ставит недостающие зависимости (спрашивая sudo где нужно)
#   3. Собирает whisper.cpp и скачивает модель (~460 МБ для small)
#   4. Кладёт плагин в ~/.config/opencode/plugins/ (авто-загрузка, без правки конфига)
#   5. Создаёт команды /r и /s
#
# После установки перезапусти opencode.
set -euo pipefail

MODEL="${VOICE_MODEL:-small}"   # tiny (~75 МБ) | base (~142 МБ) | small (~466 МБ)

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

say()  { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

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

apt_install() {
    if command -v apt-get >/dev/null; then
        $SUDO apt-get update -qq
        DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y "$@"
    else
        die "нужен пакетный менеджер apt; поставь вручную: $*"
    fi
}

# ── 2. Зависимости ───────────────────────────────────────────────────────
if [ "$is_wsl" -eq 1 ]; then
    PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    [ -x "$PS" ] || die "powershell.exe не найден — это WSL2?"

    if "$PS" -NoProfile -Command '
        $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
        $c = Get-Command ffmpeg -ErrorAction SilentlyContinue
        if ($c) { $c.Source; exit 0 }
        $p = "$env:USERPROFILE\.voice\bin\ffmpeg.exe"
        if (Test-Path $p) { $p; exit 0 }
        exit 1
    ' >/dev/null 2>&1; then
        ok "ffmpeg на стороне Windows уже есть"
    else
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
       '
        ok "ffmpeg установлен в %USERPROFILE%\\.voice\\bin"
    fi
else
    if ! command -v ffmpeg >/dev/null; then
        say "ставлю ffmpeg"
        apt_install ffmpeg
    fi
    ok "ffmpeg: $(command -v ffmpeg)"
    if [ -n "${WAYLAND_DISPLAY:-}" ] && ! command -v wl-copy >/dev/null; then
        say "ставлю wl-copy (Wayland)"
        apt_install wl-clipboard
    fi
    if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -n "${DISPLAY:-}" ] && ! command -v xclip >/dev/null; then
        say "ставлю xclip (X11)"
        apt_install xclip
    fi
fi

# ── 3. whisper.cpp + модель ──────────────────────────────────────────────
VOICE_HOME="$HOME/.voice"
WHISPER_DIR="$VOICE_HOME/whisper.cpp"
WHISPER_BIN="$WHISPER_DIR/build/bin/whisper-cli"
MODEL_FILE="$VOICE_HOME/models/ggml-$MODEL.bin"

if [ ! -x "$WHISPER_BIN" ]; then
    say "собираю whisper.cpp (потребуется компилятор и cmake)"
    command -v cmake >/dev/null || apt_install cmake build-essential git
    mkdir -p "$VOICE_HOME"
    [ -d "$WHISPER_DIR" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
    cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build "$WHISPER_DIR/build" --config Release -j"$(nproc)" >/dev/null
fi
[ -x "$WHISPER_BIN" ] || die "сборка whisper-cli не удалась"
ok "whisper-cli: $WHISPER_BIN"

if [ ! -s "$MODEL_FILE" ]; then
    case "$MODEL" in
        tiny) size=75 ;; base) size=142 ;; *) size=466 ;;
    esac
    say "скачиваю модель ggml-$MODEL.bin (~$size МБ)"
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

CFG_DIR="$HOME/.config/opencode-voice"
mkdir -p "$CFG_DIR"
[ -f "$CFG_DIR/config.json" ] || printf '{"language": "ru"}\n' > "$CFG_DIR/config.json"

# ── 5. Команды /r и /s ───────────────────────────────────────────────────
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
ok "команды /r и /s"

echo
ok "готово. Перезапусти opencode: /r — запись, /s — расшифровка в поле ввода."
