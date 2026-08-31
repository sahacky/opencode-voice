// Хуки плагина с изолированным HOME: ffmpeg/whisper/recorder указывают на несуществующие
// пути — все сценарии должны деградировать штатно, без необработанных исключений.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpencodeVoice } from "../src/index"

let home = ""
let hook: any
const toasts: Array<{ variant: string; message: string }> = []

const client = {
    tui: {
        showToast: async ({ body }: any) => { toasts.push({ variant: body.variant, message: body.message }) },
        appendPrompt: async () => ({}),
        submitPrompt: async () => ({}),
    },
}

beforeEach(async () => {
    if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    home = mkdtempSync(join(tmpdir(), "voice-test-"))
    process.env.HOME = home
    mkdirSync(join(home, ".config", "opencode-voice"), { recursive: true })
    writeFileSync(
        join(home, ".config", "opencode-voice", "config.json"),
        JSON.stringify({
            ffmpegBin: "/nonexistent-ffmpeg",
            whisperBin: "/nonexistent-whisper",
            recorder: "/nonexistent-recorder.ps1",
        }),
    )
    toasts.length = 0
    const plugin = await OpencodeVoice({ client })
    hook = plugin["command.execute.before"]
})

afterAll(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

describe("command.execute.before", () => {
    test("чужие команды не перехватываются", async () => {
        const out = { parts: [{}, {}] }
        const res = await hook({ command: "help" }, out)
        expect(res).toBeUndefined()
        expect(out.parts.length).toBe(2)
    })

    test("/s без записи: тост «Запись не идёт» и статус-throw", async () => {
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(toasts.some((t) => t.message.includes("Запись не идёт"))).toBe(true)
    })

    test("/r с недоступным рекордером: хук отрабатывает штатно, без необработанной ошибки", async () => {
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
    })

    test("/v: отчёт диагностики пишется даже при полностью сломанной среде", async () => {
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const diagPath = join(home, ".config", "opencode-voice", "diag.txt")
        expect(existsSync(diagPath)).toBe(true)
        const rep = readFileSync(diagPath, "utf8")
        expect(rep).toContain("✗ модель")
        expect(rep).toContain("платформа:")
        expect(toasts.some((t) => t.message.includes("голос") || t.message.includes("voice diag"))).toBe(true)
    })

    test("плагин сам создаёт слэш-команды при загрузке", () => {
        for (const c of ["r", "s", "v"]) {
            expect(existsSync(join(home, ".config", "opencode", "commands", `${c}.md`))).toBe(true)
        }
    })
})
