# opencode-voice

[![CI](https://github.com/sahacky/opencode-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/sahacky/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![whisper](https://img.shields.io/badge/whisper-large--v3--turbo--q5__0-blue.svg)](#модели)
[![platform](https://img.shields.io/badge/WSL2%20%7C%20Linux-informational.svg)](#как-это-работает)

Голосовой ввод для [opencode](https://opencode.ai): целиком внутри TUI, распознавание —
локальным whisper.cpp, без облака и внешних окон.

```
┌─ вы ────────────────────────────────────────────────────┐
│ /r                                                      │
│   ● ЗАПИСЬ 12с — /s чтобы закончить                     │
│ /s                                                      │
│   voice: текст в поле ввода (Enter — отправить)         │
│ Привет. Поставь точку останова на строке 42.█           │
└─────────────────────────────────────────────────────────┘
```

- `/r` — начать запись: тост-таймер в TUI
- `/s` — закончить: расшифровка вставляется **в поле ввода** (можно поправить перед
  отправкой) и параллельно кладётся в буфер обмена
- `/v` — диагностика: ffmpeg и его аудио-входы, тестовая запись 2 с, модель, whisper,
  буфер обмена; полный отчёт — в `~/.config/opencode-voice/diag.txt`

Работает в WSL2 и на нативном Linux.

## Содержание

- [Требования](#требования)
- [Быстрая установка](#быстрая-установка)
- [Модели](#модели)
- [Как это работает](#как-это-работает)
- [Опции](#опции)
- [Troubleshooting](#troubleshooting)
- [Разработка](#разработка)
- [Лицензия](#лицензия)

## Требования

- ~0.6–4 ГБ диска: модель (см. таблицу ниже) + исходники и сборка whisper.cpp (~1 ГБ);
- `git`, `cmake` и компилятор — установщик поставит их через `apt` (спросит sudo);
- `sudo` **не обязателен**: без apt/sudo (сервер, контейнер) ffmpeg ставится статической
  сборкой в `~/.local/bin`;
- микрофон (на нативном Linux без pulse — через ALSA);
- команды `/r` `/s` `/v` работают только в TUI — `opencode run` кастомные команды
  не запускает, тестировать в интерактивном режиме.

## Быстрая установка

```bash
curl -fsSL https://raw.githubusercontent.com/sahacky/opencode-voice/main/install.sh | bash
```

Скрипт сам:

1. определит среду (WSL2 или нативный Linux);
2. поставит недостающие зависимости — ffmpeg (через apt; без sudo — статикой в
   `~/.local/bin`; в WSL2 — сборка для Windows в `%USERPROFILE%\.voice\bin`);
3. соберёт whisper.cpp (пиннованная версия) и скачает модель — при интерактивном
   запуске предложит выбор, молча ставит `large-v3-turbo-q5_0` (можно задать
   `VOICE_MODEL=tiny|base|small|medium|large-v3|large-v3-turbo|large-v3-turbo-q5_0`);
4. определит рабочий аудиодрайвер (pulse → alsa) и dshow-микрофон в WSL2, запишет их в конфиг;
5. положит плагин в `~/.config/opencode/plugins/` (opencode грузит такие плагины сам,
   править `opencode.json` не нужно);
6. создаст команды `/r`, `/s`, `/v`;
7. сделает тестовую запись 2 с и скажет, работает ли микрофон.

После установки перезапусти opencode. Ручная установка — те же шаги из тела `install.sh`.

## Модели

| Модель | Размер | Комментарий |
| --- | --- | --- |
| `large-v3-turbo-q5_0` (по умолчанию) | ~575 МБ | квантованный turbo: качество почти как у large-v3 при скромном размере |
| `large-v3-turbo` | ~1.6 ГБ | turbo без квантования: то же качество, больше RAM |
| `large-v3` | ~3 ГБ | максимум качества, заметно медленнее на CPU |
| `small` | ~466 МБ | заметно хуже на русском, но быстрее на слабом CPU |
| `medium` | ~1.5 ГБ | проигрывает turbo по качеству и скорости — брать не стоит |
| `base` / `tiny` | ~142 / ~75 МБ | только «чтобы было» |

Смена модели без переустановки: `VOICE_MODEL=small bash install.sh` — скачается новая,
путь пропишется в конфиг, старая останется в `~/.voice/models/`.

## Как это работает

Плагин перехватывает команды `/r`, `/s`, `/v` хуком `command.execute.before` и обрывает их
шаблон (`throw`), чтобы в чат не уходило пустое сообщение. Дальше конвейер:
`ffmpeg → wav 16 кГц mono → whisper-cli → чистка текста → поле ввода TUI + буфер обмена`.

| | WSL2 | нативный Linux |
| --- | --- | --- |
| Запись | `voice-rec.ps1`: ffmpeg (dshow) на стороне Windows, остановка через файл-флаг в TEMP | `ffmpeg -f pulse` (или alsa), остановка по SIGINT |
| Fallback | — | pulse не открылся → автоматический перезапуск через alsa (если ffmpeg её умеет) |
| Расшифровка | `whisper-cli` в WSL | `whisper-cli` локально |
| Буфер обмена | `Set-Clipboard` | `wl-copy` (Wayland) / `xclip` (X11) |

Текст чистится: слова-паразиты, невербальные блоки вида `[музыка]`, заглавные буквы,
команды «новая строка» / «абзац» / «отступ». Результат доставляется через
`POST /tui/append-prompt` и в буфер обмена.

## Опции

Задаются в `~/.config/opencode-voice/config.json` (установщик пишет туда `model` и
`audioDriver`) или в `opencode.json` как опции плагина — последние имеют приоритет:

```json
{
  "submit": false,
  "language": "ru"
}
```

| Опция | По умолчанию | Описание |
| --- | --- | --- |
| `submit` | `false` | Вставить расшифровку и сразу отправить (`tui/submit-prompt`) |
| `maxSeconds` | `300` | Потолок длины записи, с |
| `toastMs` | `3000` | Длительность обычного тоста, мс |
| `language` | `"ru"` | Язык распознавания whisper |
| `audioDriver` | авто (pulse/alsa) | Нативный Linux: `pulse` или `alsa`; определяется установщиком |
| `audioSource` | `"default"` | Имя pulse-источника / alsa-устройства |
| `recorder` | `src/voice-rec.ps1` | WSL: скрипт записи (идёт в комплекте) |
| `ffmpegBin` | `"ffmpeg"` | Нативный Linux: путь к ffmpeg |
| `whisperBin` | `~/.voice/whisper.cpp/build/bin/whisper-cli` | Путь к `whisper-cli` |
| `model` | `~/.voice/models/ggml-large-v3-turbo-q5_0.bin` | Путь к ggml-модели |
| `debugLog` | `""` | Путь к логу диагностики; пусто — лог выключен |

## Troubleshooting

Общий принцип: у каждой неудачи свой тост, а `/v` показывает, что именно сломалось,
и пишет полный отчёт в `~/.config/opencode-voice/diag.txt`.

| Сообщение / симптом | Причина | Что делать |
| --- | --- | --- |
| «микрофон не открылся (pulse/…)» | pulse-сервер не запущен, а ffmpeg пишет через pulse | плагин сам пробует alsa; если не помогло — поставь `"audioDriver": "alsa"` в config.json |
| «микрофон не открылся (alsa/…)» | нет прав на `/dev/snd` или неверное устройство | `sudo usermod -aG audio $USER` и перелогин; список устройств: `arecord -l` |
| «запись пустая — нет звука или неверный audioSource» | устройство открылось, но звука нет (монитор вместо микрофона и т.п.) | найди источник: `pactl list sources short` (pulse) / `arecord -l` (alsa) и задай `"audioSource"` |
| «модель не найдена» | конфиг указывает на несуществующий ggml-файл | `VOICE_MODEL=… bash install.sh` или поправь `"model"` |
| «whisper не обработал запись / не запустился» | битый бинарник whisper-cli | пересборка: `bash install.sh` |
| «не расслышал — говори громче» | запись и whisper в порядке, но текст пустой | говори ближе к микрофону; если стабильно — возьми модель больше |
| В WSL2 рекордер умирает сразу | в `%USERPROFILE%\.voice\config.json` нет ключа `device` | перезапусти install.sh (найдёт dshow-устройство) или задай `device` руками |

Как найти свой источник звука:

```bash
pactl list sources short        # pulse: строки вида alsa_input.…
arecord -l                      # alsa: карточки и устройства (hw:X,Y)
```

Включить лог плагина для тонкой отладки: `"debugLog": "/tmp/voice.log"` в config.json.

## Разработка

```bash
bun install                      # зависимости для тестов и типчиков
bun test                         # все тесты — железо не нужно
bun run coverage                 # то же + отчёт покрытия (coverage/lcov.info)
bun run typecheck                # tsc --noEmit
bash install.sh --selftest       # самопроверка логики установщика (без сети и sudo)
shellcheck -S warning install.sh # линтер установщика
```

Структура тестов:

| Файл | Что проверяет |
| --- | --- |
| `tests/cleanText.test.ts` | табличные кейсы чистки текста (заодно документация поведения) |
| `tests/hooks.test.ts` | перехват команд, штатная деградация при сломанной среде, приоритет опций |
| `tests/recording.test.ts` | полные циклы `/r → /s` и `/v` на стабах |
| `tests/stubs/` | фейковые `ffmpeg` / `whisper` / `xclip` — happy-path'ы без микрофона |
| `tests/smoke-v.ts` | `/v` на реально установленном плагине (используется в CI) |

## Лицензия

MIT — см. [LICENSE](LICENSE).
