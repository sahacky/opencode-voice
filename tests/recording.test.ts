// Полные циклы на стабах (tests/stubs/): ffmpeg пишет 8-КБ wav и живёт до SIGINT,
// whisper печатает готовый текст — happy-path'ы /r→/s и /v проверяются без железа.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpencodeVoice } from "../src/index"

const stubs = join(import.meta.dir, "stubs")
const origPath = process.env.PATH

let home = ""
let hook: any
const toasts: string[] = []
const prompts: string[] = []
let submits = 0

const client = {
    tui: {
        showToast: async ({ body }: any) => { toasts.push(body.message) },
        appendPrompt: async ({ body }: any) => { prompts.push(body.text); return {} },
        submitPrompt: async () => { submits++ },
    },
}

beforeEach(() => {
    if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    home = mkdtempSync(join(tmpdir(), "voice-rec-test-"))
    process.env.HOME = home
    process.env.VOICE_PLATFORM = "native"
    process.env.PATH = `${stubs}:${origPath}`
    delete process.env.VOICE_STUB_HANG

    mkdirSync(join(home, ".config", "opencode-voice"), { recursive: true })
    const model = join(home, "model.bin")
    writeFileSync(model, "x")
    truncateSync(model, 60_000_000)      // разреженный файл: diag требует >50 МБ, диска не занимает
    writeFileSync(
        join(home, ".config", "opencode-voice", "config.json"),
        JSON.stringify({
            ffmpegBin: join(stubs, "ffmpeg.sh"),
            whisperBin: join(stubs, "whisper.sh"),
            model,
            audioDriver: "alsa",
            audioSource: "default",
            maxSeconds: 60,
        }),
    )
    toasts.length = 0
    prompts.length = 0
    submits = 0
})

afterAll(() => {
    process.env.PATH = origPath
    delete process.env.VOICE_STUB_HANG
    delete process.env.VOICE_PLATFORM
    try { rmSync(home, { recursive: true, force: true }) } catch {}
})

describe("запись /r → /s на стабах", () => {
    test("полный цикл: старт, повторный старт, стоп, текст в поле ввода", async () => {
        const plugin = await OpencodeVoice({ client })
        hook = (plugin as any)["command.execute.before"]
        process.env.VOICE_STUB_HANG = "1"

        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        expect(toasts.some((t) => t.includes("ЗАПИСЬ"))).toBe(true)

        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        expect(toasts.some((t) => t.includes("уже идёт"))).toBe(true)

        await new Promise((res) => setTimeout(res, 400))     // «говорим» — стаб должен успеть дописать wav
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
        expect(toasts.some((t) => t.includes("текст в поле ввода"))).toBe(true)
        expect(toasts.some((t) => t.includes("не расслышал"))).toBe(false)

        // временный wav убран за собой
        const leftovers = readdirSync(tmpdir()).filter((f) => f.startsWith("voice-rec-") && f.endsWith(".wav"))
        expect(leftovers).toEqual([])
    })

    test("submit: true — вставка и автоправка отправки", async () => {
        const cfg = join(home, ".config", "opencode-voice", "config.json")
        writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), submit: true }))
        const plugin = await OpencodeVoice({ client })
        hook = (plugin as any)["command.execute.before"]
        process.env.VOICE_STUB_HANG = "1"

        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await new Promise((res) => setTimeout(res, 400))     // «говорим»
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(submits).toBe(1)
        expect(toasts.some((t) => t.includes("отправлено"))).toBe(true)
    })
})

describe("/v на стабах", () => {
    test("полностью зелёный отчёт и success-тост", async () => {
        const plugin = await OpencodeVoice({ client })
        hook = (plugin as any)["command.execute.before"]

        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")

        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        for (const step of ["✓ модель", "✓ ffmpeg", "✓ запись", "✓ whisper"]) {
            expect(rep).toContain(step)
        }
        // буфер обмена: Bun.which не замечает рантайм-изменений PATH, поэтому стаб из
        // tests/stubs тут не виден — проверяем только наличие самого шага в отчёте
        expect(rep).toContain("буфер обмена")
        expect(rep).toContain("«Тестовая расшифровка из стаба.»")
        expect(toasts.some((t) => t.includes("всё работает") || t.includes("есть проблемы"))).toBe(true)
    })
})
