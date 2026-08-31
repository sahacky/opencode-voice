// Smoke-проверка /v после реальной установки (используется в CI):
//   HOME=<fakehome> bun tests/smoke-v.ts <путь к установленному плагину>
// В контейнере нет звуковых устройств — запись законно падает, остальное должно быть зелёным.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const pluginPath = process.argv[2] ?? join(homedir(), ".config", "opencode", "plugins", "opencode-voice.ts")
const { OpencodeVoice } = await import(pluginPath)

const toasts: string[] = []
const plugin = await OpencodeVoice({
    client: {
        tui: {
            showToast: async ({ body }: any) => { toasts.push(body.message) },
            appendPrompt: async () => ({}),
            submitPrompt: async () => ({}),
        },
    },
})

try {
    await (plugin as any)["command.execute.before"]({ command: "v" }, { parts: [] })
    console.error("FAIL: хук /v не прервал выполнение")
    process.exit(1)
} catch (e: any) {
    if (!String(e.message).includes("диагностика")) {
        console.error(`FAIL: неожиданная ошибка: ${e.message}`)
        process.exit(1)
    }
}

const rep = readFileSync(join(homedir(), ".config", "opencode-voice", "diag.txt"), "utf8")
console.log(rep)
// WSL-ветка диагностики не проверяет ffmpeg (он на стороне Windows) —
// обязательные шаги только те, что есть на обеих платформах
const mustHave = ["✓ модель", "✓ запись"]
for (const line of mustHave) {
    if (!rep.includes(line)) {
        console.error(`FAIL: в отчёте нет «${line}»`)
        process.exit(1)
    }
}
console.log("SMOKE_OK")
