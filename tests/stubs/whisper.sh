#!/usr/bin/env bash
# стаб whisper-cli. Режимы: VOICE_STUB_WHISPER=fail — падает с ошибкой,
# empty — «не расслышал» (пустой stdout), по умолчанию — нормальный текст.
if [ "${VOICE_STUB_WHISPER:-}" = "fail" ]; then
    echo "whisper stub: failed to load model" >&2
    exit 1
fi
if [ "${VOICE_STUB_WHISPER:-}" = "empty" ]; then
    exit 0
fi
echo " тестовая   расшифровка из стаба "
exit 0
