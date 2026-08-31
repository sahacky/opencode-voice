// Ошибочные пути нативной ветки на стабах: пустая запись, смерть рекордера,
// fallback pulse→alsa, автостоп по maxSeconds, отказы whisper/модели/клиента.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpencodeVoice } from "../src/index"

const stubs = join(import.meta.dir, "stubs")

let home = ""
let hook: any
const toasts: string[] = []
const prompts: string[] = []
let submits = 0

function makeClient(over: Partial<Record<"showToast" | "appendPrompt" | "submitPrompt", unknown>> = {}) {
    return {
        tui: {
            showToast: over.showToast ?? (async ({ body }: any) => { toasts.push(`${body.variant}: ${body.message}`) }),
            appendPrompt: over.appendPrompt ?? (async ({ body }: any) => { prompts.push(body.text); return {} }),
            submitPrompt: over.submitPrompt ?? (async () => { submits++ }),
        },
    }
}

function writeConfig(extra: Record<string, unknown> = {}) {
    mkdirSync(join(home, ".config", "opencode-voice"), { recursive: true })
    const model = join(home, "model.bin")
    writeFileSync(model, "x")
    truncateSync(model, 60_000_000)
    writeFileSync(
        join(home, ".config", "opencode-voice", "config.json"),
        JSON.stringify({
            ffmpegBin: join(stubs, "ffmpeg.sh"),
            whisperBin: join(stubs, "whisper.sh"),
            model,
            audioDriver: "alsa",
            audioSource: "default",
            maxSeconds: 60,
            ...extra,
        }),
    )
}

async function makeHook(extra: Record<string, unknown> = {}, client = makeClient()) {
    const plugin = await OpencodeVoice({ client }, extra)
    return (plugin as any)["command.execute.before"]
}

async function record(h: any) {
    process.env.VOICE_STUB_HANG = "1"
    await expect(h({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
    await new Promise((res) => setTimeout(res, 400))
    await expect(h({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
}

async function waitFor(cond: () => boolean, ms: number) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline && !cond()) await new Promise((res) => setTimeout(res, 100))
    expect(cond()).toBe(true)
}

beforeEach(() => {
    if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    home = mkdtempSync(join(tmpdir(), "voice-err-"))
    process.env.HOME = home
    process.env.VOICE_PLATFORM = "native"
    for (const k of ["VOICE_STUB_HANG", "VOICE_STUB_FAIL_DRIVER", "VOICE_STUB_NOWAV", "VOICE_STUB_WHISPER", "VOICE_SPAWN_THROW", "VOICE_STUB_DEVICES"]) delete process.env[k]
    writeConfig()
    toasts.length = 0
    prompts.length = 0
    submits = 0
})

afterEach(() => {
    for (const k of ["VOICE_STUB_HANG", "VOICE_STUB_FAIL_DRIVER", "VOICE_STUB_NOWAV", "VOICE_STUB_WHISPER", "VOICE_SPAWN_THROW", "VOICE_STUB_DEVICES"]) delete process.env[k]
})

afterAll(() => {
    delete process.env.VOICE_PLATFORM
    try { rmSync(home, { recursive: true, force: true }) } catch {}
})

describe("конфиг и загрузка", () => {
    test("без config.json плагин работает на дефолтах", async () => {
        rmSync(join(home, ".config"), { recursive: true, force: true })
        hook = await makeHook()
        const out = { parts: [{}] }
        await hook({ command: "help" }, out)
        expect(out.parts.length).toBe(1)
    })

    test("авто-детект платформы (без VOICE_PLATFORM) не ломает загрузку", async () => {
        delete process.env.VOICE_PLATFORM
        hook = await makeHook()
        await hook({ command: "help" }, { parts: [] })
    })

    test("кривой config.json не валит плагин", async () => {
        writeFileSync(join(home, ".config", "opencode-voice", "config.json"), "{не json")
        hook = await makeHook()
        await hook({ command: "help" }, { parts: [] })
    })

    test("командный каталог занят файлом — плагин всё равно грузится", async () => {
        mkdirSync(join(home, ".config"), { recursive: true })
        writeFileSync(join(home, ".config", "opencode"), "")
        // .config/opencode как файл → mkdir для commands бросит и уйдёт в catch
        await makeHook()
        expect(existsSync(join(home, ".config", "opencode"))).toBe(true)
    })
})

describe("ошибки распознавания", () => {
    test("модель не найдена", async () => {
        writeConfig({ model: join(home, "нет-модели.bin") })
        hook = await makeHook()
        await record(hook)
        expect(toasts.some((t) => t.includes("модель не найдена"))).toBe(true)
    })

    test("whisper упал (exit != 0)", async () => {
        hook = await makeHook()
        process.env.VOICE_STUB_WHISPER = "fail"
        await record(hook)
        expect(toasts.some((t) => t.includes("whisper не обработал запись"))).toBe(true)
    })

    test("whisper вернул пустоту — «не расслышал»", async () => {
        hook = await makeHook()
        process.env.VOICE_STUB_WHISPER = "empty"
        await record(hook)
        expect(toasts.some((t) => t.includes("не расслышал"))).toBe(true)
    })

    test("бинаря whisper нет — «не запустился»", async () => {
        writeConfig({ whisperBin: "/nonexistent-whisper" })
        hook = await makeHook()
        await record(hook)
        expect(toasts.some((t) => t.includes("whisper не запустился"))).toBe(true)
    })

    test("запись без звука — «запись пустая»", async () => {
        hook = await makeHook()
        process.env.VOICE_STUB_HANG = "1"
        process.env.VOICE_STUB_NOWAV = "1"
        await record(hook)
        expect(toasts.some((t) => t.includes("запись пустая"))).toBe(true)
    })

    test("рекордер умер до /s — «микрофон не открылся» с драйвером", async () => {
        hook = await makeHook()
        process.env.VOICE_STUB_FAIL_DRIVER = "alsa"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await new Promise((res) => setTimeout(res, 150))   // exitCode готов, heartbeat ещё не тикал
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(toasts.some((t) => t.includes("микрофон не открылся") && t.includes("alsa"))).toBe(true)
    })
})

describe("fallback и автостоп", () => {
    test("pulse умер → перезапуск через alsa → текст доезжает", async () => {
        writeConfig({ audioDriver: "pulse" })
        hook = await makeHook()
        process.env.VOICE_STUB_HANG = "1"
        process.env.VOICE_STUB_FAIL_DRIVER = "pulse"

        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await waitFor(() => toasts.some((t) => t.includes("перезапускаю запись через alsa")), 4000)
        await new Promise((res) => setTimeout(res, 400))
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
    })

    test("maxSeconds: запись останавливается сама", async () => {
        writeConfig({ maxSeconds: 1 })
        hook = await makeHook()
        process.env.VOICE_STUB_HANG = "1"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await waitFor(() => prompts.length === 1, 6000)
        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
    })

    test("/v во время записи просит сначала закончить", async () => {
        hook = await makeHook()
        process.env.VOICE_STUB_HANG = "1"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await new Promise((res) => setTimeout(res, 1300))   // тост-таймер записи
        expect(toasts.some((t) => t.includes("ЗАПИСЬ 1с"))).toBe(true)
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        expect(toasts.some((t) => t.includes("Идёт запись"))).toBe(true)
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
    })

    test("fallback невозможен (alsa во входах нет) — тост об ошибке", async () => {
        writeConfig({ audioDriver: "pulse" })
        hook = await makeHook()
        process.env.VOICE_STUB_DEVICES = "pulse"
        process.env.VOICE_STUB_FAIL_DRIVER = "pulse"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await waitFor(() => toasts.some((t) => t.includes("микрофон не открылся") && t.includes("pulse")), 4000)
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(toasts.some((t) => t.includes("Запись не идёт"))).toBe(true)
    })

    test("нативный буфер обмена недоступен — ошибка уходит в catch", async () => {
        hook = await makeHook()
        process.env.VOICE_SPAWN_THROW = "xclip"
        await record(hook)
        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
    })
})

describe("клиент TUI", () => {
    test("appendPrompt упал — текст остаётся в буфере обмена", async () => {
        hook = await makeHook({}, makeClient({ appendPrompt: async () => { throw new Error("tui down") } }))
        await record(hook)
        expect(toasts.some((t) => t.includes("буфере обмена"))).toBe(true)
    })

    test("submit при падающем submitPrompt не ломает завершение", async () => {
        writeConfig({ submit: true })
        hook = await makeHook({}, makeClient({ submitPrompt: async () => { throw new Error("submit down") } }))
        await record(hook)
        expect(toasts.some((t) => t.includes("отправлено"))).toBe(true)
    })

    test("падающие тосты не роняют хук", async () => {
        hook = await makeHook({}, makeClient({ showToast: async () => { throw new Error("toast down") } }))
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
    })
})

describe("/v: деградация на нативной ветке", () => {
    test("запись молчит → шаг записи провален, whisper пропущен", async () => {
        hook = await makeHook()
        process.env.VOICE_STUB_NOWAV = "1"
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("✗ запись")
        expect(rep).toContain("пропущено: нет тестовой записи")
    })

    test("diag сам находит alsa, когда pulse молчит", async () => {
        writeConfig({ audioDriver: "pulse" })
        process.env.PATH = `${stubs}:${process.env.PATH}`   // xclip-стаб: буфер обмена зелёный
        hook = await makeHook()
        process.env.VOICE_STUB_FAIL_DRIVER = "pulse"
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("✓ запись")
        expect(rep).toContain("в этой сессии использую alsa")
        expect(toasts.some((t) => t.includes("всё работает"))).toBe(true)
    })

    test("diag: битый whisper-бинарь при живой записи — шаг провален", async () => {
        writeConfig({ whisperBin: "/nonexistent-whisper" })
        hook = await makeHook()
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("✓ запись")
        expect(rep).toContain("✗ whisper")
    })
})
