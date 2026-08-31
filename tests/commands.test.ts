// Команды /m и /u: умное кольцо моделей с докачкой и самообновление.
// Скачивание имитируется curl'ом с file://, проверка обновлений — локальным HTTP-сервером.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpencodeVoice } from "../src/index"

let home = ""
let hook: any
const toasts: string[] = []

const client = {
    tui: {
        showToast: async ({ body }: any) => { toasts.push(`${body.variant}: ${body.message}`) },
        appendPrompt: async () => ({}),
        submitPrompt: async () => {},
    },
}

// локальный «репозиторий»: файл-модель для file:// и HTTP-сервер с «удалённым» плагином
let srv: any = null
let remoteBody = ""

function sparse(path: string) {
    writeFileSync(path, "x")
    truncateSync(path, 60_000_000)
}

async function makeHook(extra: Record<string, unknown> = {}) {
    const plugin = await OpencodeVoice({ client }, extra)
    return (plugin as any)["command.execute.before"]
}

function writeConfig(extra: Record<string, unknown> = {}) {
    mkdirSync(join(home, ".config", "opencode-voice"), { recursive: true })
    writeFileSync(
        join(home, ".config", "opencode-voice", "config.json"),
        JSON.stringify({
            ffmpegBin: "/nonexistent-ffmpeg",
            whisperBin: "/nonexistent-whisper",
            recorder: "/nonexistent-recorder.ps1",
            ...extra,
        }),
    )
}

function cfgModel(): string {
    return JSON.parse(readFileSync(join(home, ".config", "opencode-voice", "config.json"), "utf8")).model
}

beforeEach(() => {
    if (home) { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    home = mkdtempSync(join(tmpdir(), "voice-cmd-"))
    process.env.HOME = home
    process.env.VOICE_PLATFORM = "native"
    for (const k of ["VOICE_SPAWN_THROW", "VOICE_STUB_HANG"]) delete process.env[k]
    toasts.length = 0
})

afterEach(() => { for (const k of ["VOICE_SPAWN_THROW", "VOICE_STUB_HANG"]) delete process.env[k] })

afterAll(() => {
    delete process.env.VOICE_PLATFORM
    try { srv?.stop(true) } catch {}
    try { rmSync(home, { recursive: true, force: true }) } catch {}
})

describe("/m — умное кольцо моделей", () => {
    test("переключает на следующую скачанную мгновенно", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        sparse(join(models, "ggml-large-v3-turbo-q5_0.bin"))
        writeConfig({ model: join(models, "ggml-small.bin") })
        hook = await makeHook()

        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(cfgModel()).toBe(join(models, "ggml-large-v3-turbo-q5_0.bin"))
        expect(toasts.some((t) => t.includes("small → large-v3-turbo-q5_0"))).toBe(true)
    })

    test("кольцо из одного → предложение докачки; повтор /m скачивает и применяет", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        const fake = join(home, "fake-model.bin")
        writeFileSync(fake, "0".repeat(2_000_000))
        writeConfig({ model: join(models, "ggml-small.bin"), modelUrl: `file://${fake}` })
        hook = await makeHook()

        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(toasts.some((t) => t.includes("Лучшая недостающая — large-v3-turbo-q5_0"))).toBe(true)

        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(toasts.some((t) => t.includes("качаю модель large-v3-turbo-q5_0"))).toBe(true)
        expect(cfgModel()).toBe(join(models, "ggml-large-v3-turbo-q5_0.bin"))
        expect(existsSync(join(models, "ggml-large-v3-turbo-q5_0.bin"))).toBe(true)
        expect(toasts.some((t) => t.includes("small → large-v3-turbo-q5_0"))).toBe(true)
    })

    test("просроченное согласие не качает, а снова листает кольцо", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        writeConfig({ model: join(models, "ggml-small.bin"), confirmMs: 60 })
        hook = await makeHook()

        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        await new Promise((res) => setTimeout(res, 150))   // согласие протухло
        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(toasts.some((t) => t.includes("качаю"))).toBe(false)
        expect(toasts.filter((t) => t.includes("недостающая")).length).toBe(2)
        expect(cfgModel()).toBe(join(models, "ggml-small.bin"))
    })

    test("неудачная докачка оставляет модель как была", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        writeConfig({ model: join(models, "ggml-small.bin"), modelUrl: "http://127.0.0.1:9/none" })
        hook = await makeHook()

        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(toasts.some((t) => t.includes("не удалось скачать"))).toBe(true)
        expect(cfgModel()).toBe(join(models, "ggml-small.bin"))
    })

    test("во время записи /m отказывает до переключения", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        sparse(join(models, "ggml-base.bin"))
        writeConfig({
            model: join(models, "ggml-small.bin"),
            ffmpegBin: join(import.meta.dir, "stubs", "ffmpeg.sh"),
            audioDriver: "alsa",
        })
        hook = await makeHook()
        process.env.VOICE_STUB_HANG = "1"
        await expect(hook({ command: "r" }, { parts: [] })).rejects.toThrow("voice: запись начата")
        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(toasts.some((t) => t.includes("Идёт запись"))).toBe(true)
        await expect(hook({ command: "s" }, { parts: [] })).rejects.toThrow("voice: готово")
        expect(cfgModel()).toBe(join(models, "ggml-small.bin"))
    })
})

describe("/u — самообновление", () => {
    test("нет обновлений: удалённый файл совпадает с локальным", async () => {
        const local = readFileSync("src/index.ts", "utf8")
        srv = Bun.serve({ port: 0, fetch: () => new Response(local) })
        writeConfig({ updateUrl: `http://localhost:${srv.port}/` })
        hook = await makeHook()
        await expect(hook({ command: "u" }, { parts: [] })).rejects.toThrow("voice: обновление завершено")
        expect(toasts.some((t) => t.includes("обновлений нет"))).toBe(true)
        srv.stop(true)
    })

    test("есть обновление: запускает updateCmd и просит перезапуск", async () => {
        srv = Bun.serve({ port: 0, fetch: () => new Response("// newer version\n" + readFileSync("src/index.ts", "utf8")) })
        writeConfig({ updateUrl: `http://localhost:${srv.port}/`, updateCmd: "true" })
        hook = await makeHook()
        await expect(hook({ command: "u" }, { parts: [] })).rejects.toThrow("voice: обновление завершено")
        expect(toasts.some((t) => t.includes("перезапусти opencode"))).toBe(true)
        srv.stop(true)
    })

    test("установщик упал — тост об ошибке", async () => {
        srv = Bun.serve({ port: 0, fetch: () => new Response("different") })
        writeConfig({ updateUrl: `http://localhost:${srv.port}/`, updateCmd: "false" })
        hook = await makeHook()
        await expect(hook({ command: "u" }, { parts: [] })).rejects.toThrow("voice: обновление завершено")
        expect(toasts.some((t) => t.includes("обновление не удалось"))).toBe(true)
        srv.stop(true)
    })

    test("сеть недоступна — внятная ошибка", async () => {
        writeConfig({ updateUrl: "http://127.0.0.1:9/none" })
        hook = await makeHook()
        await expect(hook({ command: "u" }, { parts: [] })).rejects.toThrow("voice: обновление завершено")
        expect(toasts.some((t) => t.includes("не удалось проверить обновления"))).toBe(true)
    })

    test("updateCmd упал на спавне — catch отрабатывает", async () => {
        srv = Bun.serve({ port: 0, fetch: () => new Response("different") })
        writeConfig({ updateUrl: `http://localhost:${srv.port}/`, updateCmd: "echo boom" })
        hook = await makeHook()
        process.env.VOICE_SPAWN_THROW = "boom"
        await expect(hook({ command: "u" }, { parts: [] })).rejects.toThrow("voice: обновление завершено")
        expect(toasts.some((t) => t.includes("обновление не удалось"))).toBe(true)
        srv.stop(true)
    })
})

describe("команды", () => {
    test("конфиг незаписываем — переключение живёт в памяти, ошибка в catch", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        sparse(join(models, "ggml-base.bin"))
        writeConfig({ model: join(models, "ggml-small.bin"), debugLog: join(home, "dbg.log") })
        const cfgFile = join(home, ".config", "opencode-voice", "config.json")
        chmodSync(cfgFile, 0o400)
        try {
            hook = await makeHook()
            await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
            expect(toasts.some((t) => t.includes("small → base"))).toBe(true)
            expect(cfgModel()).toBe(join(models, "ggml-small.bin"))          // файл не тронут — пишем в память
            expect(readFileSync(join(home, "dbg.log"), "utf8")).toContain("setConfig(model) failed")
        } finally {
            chmodSync(cfgFile, 0o600)
        }
    })

    test("долгая докачка отмечается прогрессом в debugLog", async () => {
        const models = join(home, "models")
        mkdirSync(models, { recursive: true })
        sparse(join(models, "ggml-small.bin"))
        const slow = Bun.serve({
            port: 0,
            fetch: () => new Response(new ReadableStream({
                start(c) {
                    setTimeout(() => c.enqueue(new Uint8Array(2_500_000)), 500)   // файл появился до тика прогресса
                    setTimeout(() => c.close(), 2600)                              // общая длина > 2 с
                },
            })),
        })
        writeConfig({ model: join(models, "ggml-small.bin"), modelUrl: `http://localhost:${slow.port}/m.bin`, debugLog: join(home, "dbg.log") })
        hook = await makeHook()

        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        await expect(hook({ command: "m" }, { parts: [] })).rejects.toThrow("voice: модель переключена")
        expect(cfgModel()).toBe(join(models, "ggml-large-v3-turbo-q5_0.bin"))
        expect(readFileSync(join(home, "dbg.log"), "utf8")).toMatch(/download .+ МБ/)
        slow.stop(true)
    })

    test("ensureCommand создаёт m.md и u.md", async () => {
        writeConfig()
        await makeHook()
        for (const c of ["m", "u"]) {
            expect(existsSync(join(home, ".config", "opencode", "commands", `${c}.md`))).toBe(true)
        }
    })
})
