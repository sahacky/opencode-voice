// Перехват команд и штатная деградация: ffmpeg/whisper/recorder указывают на
// несуществующие пути — плагин обязан отвечать статусными тостами, а не падать.
// Отдельно — приоритет опций плагина над config.json.
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

function writeConfig(opts: Record<string, unknown>) {
    mkdirSync(join(home, ".config", "opencode-voice"), { recursive: true })
    writeFileSync(join(home, ".config", "opencode-voice", "config.json"), JSON.stringify(opts))
}

async function makeHook(options?: Record<string, unknown>) {
    const plugin = await OpencodeVoice({ client }, options)
    return (plugin as any)["command.execute.before"]
}

beforeEach(() => {
    if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    home = mkdtempSync(join(tmpdir(), "voice-test-"))
    process.env.HOME = home
    process.env.VOICE_PLATFORM = "native"
    writeConfig({
        ffmpegBin: "/nonexistent-ffmpeg",
        whisperBin: "/nonexistent-whisper",
        recorder: "/nonexistent-recorder.ps1",
    })
    toasts.length = 0
})

afterAll(() => {
    delete process.env.VOICE_PLATFORM
    try { rmSync(home, { recursive: true, force: true }) } catch {}
})

describe("command.execute.before", () => {
    test("чужие команды не перехватываются", async () => {
        hook = await makeHook()
        const out = { parts: [{}, {}] }
        const res = await hook({ command: "help" }, out)
        expect(res).toBeUndefined()
        expect(out.parts.length).toBe(2)
    })

    test("/s без записи: тост «Запись не идёт» и статус-throw", async () => {
        hook = await makeHook()
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(toasts.some((t) => t.message.includes("Запись не идёт"))).toBe(true)
    })

    test("/r с недоступным ffmpeg: тост об ошибке, хук отрабатывает штатно", async () => {
        hook = await makeHook()
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        expect(toasts.some((t) => t.variant === "error" && t.message.includes("ffmpeg"))).toBe(true)
    })

    test("/v: отчёт диагностики пишется даже при полностью сломанной среде", async () => {
        hook = await makeHook()
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const diagPath = join(home, ".config", "opencode-voice", "diag.txt")
        expect(existsSync(diagPath)).toBe(true)
        const rep = readFileSync(diagPath, "utf8")
        expect(rep).toContain("✗ модель")
        expect(rep).toContain("платформа:")
        expect(toasts.some((t) => t.message.includes("voice diag"))).toBe(true)
    })

    test("опции плагина приоритетнее config.json", async () => {
        writeConfig({ model: "/from-config/model.bin", recorder: "/nonexistent-recorder.ps1" })
        hook = await makeHook({ model: "/from-opts/model.bin" })
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("/from-opts/model.bin")
        expect(rep).not.toContain("/from-config/model.bin")
    })

    test("плагин сам создаёт слэш-команды при загрузке", async () => {
        await makeHook()
        for (const c of ["r", "s", "v"]) {
            expect(existsSync(join(home, ".config", "opencode", "commands", `${c}.md`))).toBe(true)
        }
    })
})
