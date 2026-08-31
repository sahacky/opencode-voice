// WSL-ветки плагина на эмуляции powershell (stubs/ps-stub.sh через патч Bun.spawn):
// полный цикл /r → /s c файл-флагом, смерть рекордера, зелёный /v, отказ TEMP и клипборда.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpencodeVoice } from "../src/index"
import { installSpawnPatch } from "./spawn_patch"

const stubs = join(import.meta.dir, "stubs")

let home = ""
let hook: any
const toasts: string[] = []
const prompts: string[] = []

const client = {
    tui: {
        showToast: async ({ body }: any) => { toasts.push(body.message) },
        appendPrompt: async ({ body }: any) => { prompts.push(body.text); return {} },
        submitPrompt: async () => {},
    },
}

const restoreSpawn = installSpawnPatch()

beforeEach(() => {
    if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    home = mkdtempSync(join(tmpdir(), "voice-wsl-"))
    process.env.HOME = home
    process.env.VOICE_PLATFORM = "wsl"
    process.env.VOICE_WIN_MNT = join(home, "mnt")
    delete process.env.VOICE_PS_FAIL
    delete process.env.VOICE_SPAWN_THROW
    delete process.env.VOICE_STUB_HANG

    mkdirSync(join(home, "mnt"), { recursive: true })
    const model = join(home, "model.bin")
    writeFileSync(model, "x")
    truncateSync(model, 60_000_000)
    mkdirSync(join(home, ".config", "opencode-voice"), { recursive: true })
    writeFileSync(
        join(home, ".config", "opencode-voice", "config.json"),
        JSON.stringify({ whisperBin: join(stubs, "whisper.sh"), model, maxSeconds: 60 }),
    )
    toasts.length = 0
    prompts.length = 0
})

afterEach(() => {
    delete process.env.VOICE_PS_FAIL
    delete process.env.VOICE_SPAWN_THROW
    delete process.env.VOICE_STUB_HANG
})

afterAll(() => {
    delete process.env.VOICE_WIN_MNT
    restoreSpawn()
    try { rmSync(home, { recursive: true, force: true }) } catch {}
})

async function makeHook() {
    const plugin = await OpencodeVoice({ client })
    return (plugin as any)["command.execute.before"]
}

describe("WSL: запись /r → /s через файл-флаг", () => {
    test("полный цикл: флаг остановки, wav из «Windows», текст в поле ввода", async () => {
        hook = await makeHook()
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await new Promise((res) => setTimeout(res, 400))
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")

        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
        expect(toasts.some((t) => t.includes("текст в поле ввода"))).toBe(true)
        // Set-Clipboard получил текст через файл в «Windows TEMP»
        const clip = join(home, "mnt", "c", "t", "voice-clip.txt")
        expect(existsSync(clip)).toBe(true)
        expect(readFileSync(clip, "utf8")).toContain("Тестовая")
    })

    test("рекордер умер: тост «микрофон не открылся» с причиной", async () => {
        hook = await makeHook()
        process.env.VOICE_PS_FAIL = "1"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await new Promise((res) => setTimeout(res, 1500))
        expect(toasts.some((t) => t.includes("микрофон не открылся") && t.includes("dshow device not found"))).toBe(true)

        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(toasts.some((t) => t.includes("Запись не идёт"))).toBe(true)
    })

    test("TEMP Windows недоступен: старт отменяется с тостом", async () => {
        hook = await makeHook()
        process.env.VOICE_SPAWN_THROW = "$env:TEMP"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        expect(toasts.some((t) => t.includes("TEMP"))).toBe(true)
    })

    test("клипборд Windows падает: цикл всё равно завершается, ошибка — в debugLog", async () => {
        const cfg = join(home, ".config", "opencode-voice", "config.json")
        writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), debugLog: join(home, "dbg.log") }))
        hook = await makeHook()
        process.env.VOICE_SPAWN_THROW = "Set-Clipboard"

        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await new Promise((res) => setTimeout(res, 400))
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(prompts).toEqual(["Тестовая расшифровка из стаба."])
        expect(readFileSync(join(home, "dbg.log"), "utf8")).toContain("clipboard failed")
    })
})

describe("WSL: /v", () => {
    test("полностью зелёный отчёт через эмуляцию dshow-рекордера", async () => {
        hook = await makeHook()
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")

        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("платформа: WSL2")
        expect(rep).toContain("драйвер: dshow")
        expect(rep).toContain("✓ модель")
        expect(rep).toContain("✓ запись (dshow + voice-rec.ps1)")
        expect(rep).toContain("✓ whisper")
        expect(toasts.some((t) => t.includes("всё работает"))).toBe(true)
    })

    test("TEMP недоступен — шаг записи провален с внятной причиной", async () => {
        hook = await makeHook()
        process.env.VOICE_SPAWN_THROW = "$env:TEMP"
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("✗ запись (dshow + voice-rec.ps1) — не удалось определить TEMP Windows")
    })

    test("рекордер умер в диагностике — exit-код и размер wav в отчёте", async () => {
        hook = await makeHook()
        process.env.VOICE_PS_FAIL = "1"
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("dshow device not found; wav 0 Б")
    })

    test("wslpath упал — внешний catch диагностики ловит исключение", async () => {
        hook = await makeHook()
        process.env.VOICE_SPAWN_THROW = "wslpath"
        await expect(hook({ command: "v" }, { parts: [] })).rejects.toThrow("voice: диагностика завершена")
        const rep = readFileSync(join(home, ".config", "opencode-voice", "diag.txt"), "utf8")
        expect(rep).toContain("stub: spawn refused (wslpath)")
    })
})
