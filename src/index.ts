// opencode-voice — голосовой ввод внутри opencode.
// Команды /r (начать запись), /s (закончить) и /v (диагностика): расшифровка
// через whisper вставляется в поле ввода TUI (tui/append-prompt) и кладётся в буфер обмена.
// Индикатор записи — тосты с таймером.
//
// Платформы:
//   WSL2          — микрофон через powershell.exe/ffmpeg (dshow), буфер через Set-Clipboard,
//                   остановка записи — файл-флаг в TEMP Windows (voice-rec.ps1)
//   нативный Linux — ffmpeg (pulse/alsa, с авто-fallback pulse → alsa) напрямую,
//                   остановка по SIGINT, буфер через wl-copy (Wayland) или xclip (X11)
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

declare const Bun: any

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

// HOME из окружения приоритетнее системного homedir — позволяет переопределять каталог (тесты, песочницы)
const homeDir = () => process.env.HOME || homedir()

export function cleanText(raw: string): string {
    // невербальные вставки whisper ([музыка], (шум)) — вырезаются целиком в любом месте
    let text = raw.replace(/[\[\(][^\]\)]*[\]\)]/g, " ")

    text = text.split(/\s+/).join(" ").trim()

    // слова-паразиты; границы слов — юникод-лукэраунды: \b в JS не знает кириллицу
    for (const p of [
        /(?<![\p{L}\p{N}])э+(?![\p{L}\p{N}])/giu,
        /(?<![\p{L}\p{N}])эм+(?![\p{L}\p{N}])/giu,
        /(?<![\p{L}\p{N}])м{2,}(?![\p{L}\p{N}])/giu,
        /(?<![\p{L}\p{N}])ну+ в общем(?![\p{L}\p{N}])/giu,
        /(?<![\p{L}\p{N}])короче говоря(?![\p{L}\p{N}])/giu,
    ]) {
        text = text.replace(p, " ")
    }
    text = text.replace(/\*+/g, " ")
    text = text.replace(/[ \t]{2,}/g, " ").trim()

    for (const [p, r] of [
        [/(?<![\p{L}\p{N}])новая строка(?![\p{L}\p{N}])/giu, "\n"],
        [/(?<![\p{L}\p{N}])абзац(?![\p{L}\p{N}])/giu, "\n\n"],
        [/(?<![\p{L}\p{N}])отступ(?![\p{L}\p{N}])/giu, "\t"],
    ] as const) {
        text = text.replace(p, r)
    }

    const lines: string[] = []
    for (let line of text.split("\n")) {
        line = line.replace(/^[ \t]+|[ \t]+$/g, "")
        if (!line || /^[\[\(].*[\]\)]$/.test(line)) continue
        line = line[0].toUpperCase() + line.slice(1)
        if (!".!?:".includes(line[line.length - 1])) line += "."
        lines.push(line)
    }
    return lines.join("\n").trim()
}

export const OpencodeVoice = async ({ client }: any, options?: any) => {
    // платформа определяется на момент создания плагина; VOICE_PLATFORM=native|wsl
    // принудительно переопределяет авто-детект (тесты, отладка на нетипичных машинах)
    const isWSL = (() => {
        if (process.env.VOICE_PLATFORM === "native") return false
        if (process.env.VOICE_PLATFORM === "wsl") return true
        try { return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")) } catch { return false }
    })()

    // Приоритет: опции из opencode.json > ~/.config/opencode-voice/config.json > дефолты
    let fileOpts: any = {}
    try {
        fileOpts = JSON.parse(readFileSync(join(homeDir(), ".config", "opencode-voice", "config.json"), "utf8"))
    } catch {}

    const opts = {
        submit: false,                       // после вставки сразу отправить промпт
        maxSeconds: 300,                     // потолок записи
        toastMs: 3000,                       // сколько висит обычный тост
        language: "ru",
        audioDriver: "pulse",                // нативный Linux: pulse | alsa
        audioSource: "default",              // pulse-источник или alsa-устройство
        recorder: import.meta.dir + "/voice-rec.ps1",     // WSL: скрипт записи (идёт в комплекте)
        ffmpegBin: "ffmpeg",                 // нативный Linux: бинарь ffmpeg
        whisperBin: join(homeDir(), ".voice", "whisper.cpp", "build", "bin", "whisper-cli"),
        model: join(homeDir(), ".voice", "models", "ggml-large-v3-turbo-q5_0.bin"),
        debugLog: "",
        ...fileOpts,
        ...(options || {}),
    }

    interface Rec {
        proc: any
        pid: number
        wav: string
        flag: string        // WSL: файл-флаг остановки; на нативном Linux пусто
        startedAt: number
        hb: ReturnType<typeof setInterval>
        driver: string      // эффективный драйвер записи (нативный Linux)
        stderrTxt: Promise<string>
        diedEarly: boolean  // рекордер умер до /s (устройство не открылось)
        stopping: boolean
        fallbackTried: boolean
    }
    let rec: Rec | null = null
    let winTemp = ""
    let recorderWin = ""
    let driverOverride = ""          // рабочий драйвер, найденный fallback'ом или диагностикой
    let ffmpegDevicesCache = ""

    const dbg = (msg: string) => {
        if (!opts.debugLog) return
        try { appendFileSync(opts.debugLog, `${new Date().toISOString()} ${msg}\n`) } catch {}
    }
    dbg(`plugin loaded (isWSL=${isWSL})`)

    const stamp = () => {
        const d = new Date()
        const p = (n: number) => String(n).padStart(2, "0")
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }

    // точка монтирования дисков Windows; переопределяется тестами на локальный каталог
const wslPath = (win: string) => `${process.env.VOICE_WIN_MNT || "/mnt"}/${win[0].toLowerCase()}${win.slice(2)}`.replace(/\\/g, "/")

    const effDriver = () => driverOverride || opts.audioDriver

    const firstLine = (s: string) => (s || "").split(/\r?\n/).map((l) => l.trim()).find((l) => l) || ""

    const safeText = async (p: Promise<string>): Promise<string> => {
        try { return await p } catch { return "" }
    }

    async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = opts.toastMs) {
        try {
            await client.tui.showToast({ body: { message, variant, duration } })
        } catch {}
    }

    // какие аудио-входы умеет собранный ffmpeg (pulse/alsa)
    async function ffmpegDevicesText(): Promise<string> {
        if (isWSL) return ""
        if (ffmpegDevicesCache) return ffmpegDevicesCache
        try {
            const p = Bun.spawn([opts.ffmpegBin, "-hide_banner", "-devices"], { stdout: "pipe", stderr: "pipe" })
            ffmpegDevicesCache = await new Response(p.stdout).text()
            await p.exited
        } catch {}
        return ffmpegDevicesCache
    }

    async function getWinTemp(): Promise<string> {
        if (winTemp) return winTemp
        try {
            const p = Bun.spawn([PS, "-NoProfile", "-Command", '$env:TEMP -replace "\\\\","/"'], { stdout: "pipe", stderr: "pipe" })
            winTemp = (await new Response(p.stdout).text()).trim()
            await p.exited
        } catch (e) {
            dbg(`getWinTemp failed: ${e}`)
        }
        return winTemp
    }

    // wsl-путь -> UNC-путь, доступный powershell.exe
    async function toWinPath(wsl: string): Promise<string> {
        const p = Bun.spawn(["wslpath", "-w", wsl], { stdout: "pipe", stderr: "pipe" })
        const out = (await new Response(p.stdout).text()).trim()
        await p.exited
        return out
    }

    async function toClipboard(text: string) {
        if (isWSL) {
            try {
                const tmpWin = `${await getWinTemp()}\\voice-clip.txt`
                writeFileSync(wslPath(tmpWin), "\uFEFF" + text)
                const p = Bun.spawn(
                    [
                        PS, "-NoProfile", "-Command",
                        `[System.IO.File]::ReadAllText('${tmpWin}', [System.Text.Encoding]::UTF8) | Set-Clipboard; Remove-Item '${tmpWin}'`,
                    ],
                    { stdout: "ignore", stderr: "ignore" },
                )
                await p.exited
            } catch (e) {
                dbg(`clipboard failed: ${e}`)
            }
            return
        }

        // нативный Linux: wl-copy (Wayland) или xclip (X11)
        try {
            const tmp = join(tmpdir(), `voice-clip-${stamp()}.txt`)
            writeFileSync(tmp, text)
            const cmd = process.env.WAYLAND_DISPLAY
                ? `wl-copy < '${tmp}'`
                : `xclip -selection clipboard -i '${tmp}'`
            Bun.spawn(["bash", "-c", cmd], { stdout: "ignore", stderr: "ignore" })
        } catch (e) {
            dbg(`clipboard failed: ${e}`)
        }
    }

    function spawnLinux(driver: string, wav: string) {
        const proc = Bun.spawn(
            [
                opts.ffmpegBin, "-y", "-hide_banner", "-loglevel", "error",
                "-f", driver, "-i", opts.audioSource,
                "-t", String(opts.maxSeconds), "-ar", "16000", "-ac", "1", wav,
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
        )
        return { proc, stderrTxt: new Response(proc.stderr).text() }
    }

    async function start() {
        dbg(`start called, rec=${!!rec}`)
        if (rec) { await toast("● Запись уже идёт — введи /s чтобы закончить", "warning"); return }

        let spawned: { proc: any; stderrTxt: Promise<string> }
        let wav: string
        let flag = ""
        let driver = effDriver()

        try {
            if (isWSL) {
                const temp = await getWinTemp()
                if (!temp) { await toast("voice: не удалось определить TEMP Windows", "error"); return }
                if (!recorderWin) recorderWin = await toWinPath(opts.recorder)

                const s = stamp()
                const wavWin = `${temp}\\voice-rec-${s}.wav`
                const flagWin = `${temp}\\voice-rec.stop`
                wav = wslPath(wavWin)
                flag = wslPath(flagWin)
                rmSync(flag, { force: true })

                const proc = Bun.spawn(
                    [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", recorderWin, "-Wav", wavWin, "-StopFlag", flagWin],
                    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
                )
                spawned = { proc, stderrTxt: new Response(proc.stderr).text() }
            } else {
                wav = join(tmpdir(), `voice-rec-${stamp()}.wav`)
                spawned = spawnLinux(driver, wav)
            }
            dbg(`spawned pid=${spawned.proc.pid} wav=${wav} driver=${driver}`)
        } catch (e) {
            dbg(`spawn failed: ${e}`)
            await toast(isWSL
                ? "voice: не удалось запустить рекордер (нужен ffmpeg на стороне Windows)"
                : "voice: не удалось запустить ffmpeg (apt install ffmpeg)", "error")
            return
        }

        const r: Rec = {
            ...spawned,
            pid: spawned.proc.pid,
            wav,
            flag,
            startedAt: Date.now(),
            hb: null as any,
            driver,
            diedEarly: false,
            stopping: false,
            fallbackTried: false,
        }
        rec = r
        r.hb = setInterval(async () => {
            if (!rec || rec !== r || r.stopping) return
            const sec = (Date.now() - r.startedAt) / 1000
            if (sec >= opts.maxSeconds) { await stop(); return }
            if (r.proc.exitCode !== null && !r.diedEarly) {
                r.diedEarly = true
                await onRecorderDied(r)
                return
            }
            await toast(`● ЗАПИСЬ ${sec.toFixed(0)}с — /s чтобы закончить`, "warning", 1100)
        }, 1000)
        await toast("● ЗАПИСЬ — говори, /s чтобы закончить", "warning", 1500)
    }

    // рекордер умер сам по себе до /s: устройство не открылось
    async function onRecorderDied(r: Rec) {
        clearInterval(r.hb)
        const why = firstLine(await safeText(r.stderrTxt))
        dbg(`recorder died early (exit=${r.proc.exitCode}): ${why}`)

        // pulse не открылся, а ffmpeg умеет alsa — перезапускаем запись через alsa
        if (!isWSL && r.driver === "pulse" && !r.fallbackTried) {
            r.fallbackTried = true
            if ((await ffmpegDevicesText()).includes("alsa")) {
                driverOverride = "alsa"
                await toast("voice: pulse не открылся — перезапускаю запись через alsa", "warning")
                if (rec === r) rec = null
                rmSync(r.wav, { force: true })
                await start()
                return
            }
        }

        if (rec === r) rec = null
        rmSync(r.wav, { force: true })
        rmSync(r.flag, { force: true })
        await toast(isWSL
            ? `voice: микрофон не открылся${why ? ` (${why})` : ""} — проверь ffmpeg и «device» в %USERPROFILE%\\.voice\\config.json, детали: /v`
            : `voice: микрофон не открылся (${r.driver}/${opts.audioSource})${why ? `: ${why}` : ""} — источники: pactl list sources short / arecord -l, детали: /v`,
            "error", 8000)
    }

    async function stop() {
        dbg(`stop called, rec=${!!rec}`)
        if (!rec) { await toast("Запись не идёт — введи /r", "info"); return }
        const r = rec
        r.stopping = true
        rec = null
        clearInterval(r.hb)

        const diedBefore = r.proc.exitCode !== null

        if (r.flag) writeFileSync(r.flag, "stop")            // WSL: voice-rec.ps1 сам завершит ffmpeg
        else { try { process.kill(r.pid, "SIGINT") } catch {} }  // нативный Linux: SIGINT финализирует wav
        for (let i = 0; i < 80; i++) {
            try { process.kill(r.pid, 0) } catch { break }
            await new Promise((res) => setTimeout(res, 100))
        }
        try { process.kill(r.pid, "SIGKILL") } catch {}

        const why = firstLine(await safeText(r.stderrTxt))

        const wavOk = existsSync(r.wav) && statSync(r.wav).size > 4000
        if (!wavOk) {
            rmSync(r.wav, { force: true })
            rmSync(r.flag, { force: true })
            if (diedBefore) {
                await toast(isWSL
                    ? `voice: микрофон не открылся${why ? ` (${why})` : ""} — детали: /v`
                    : `voice: микрофон не открылся (${r.driver}/${opts.audioSource})${why ? `: ${why}` : ""} — детали: /v`,
                    "error", 8000)
            } else {
                await toast("voice: запись пустая — нет звука или неверный audioSource. Детали: /v", "error", 8000)
            }
            return
        }

        if (!existsSync(opts.model)) {
            rmSync(r.wav, { force: true })
            rmSync(r.flag, { force: true })
            await toast(`voice: модель не найдена: ${opts.model} — перезапусти install.sh или поправь «model» в config.json`, "error", 8000)
            return
        }

        let text = ""
        try {
            const p = Bun.spawn([opts.whisperBin, "-m", opts.model, "-l", opts.language, "-nt", "-np", "-f", r.wav],
                { stdout: "pipe", stderr: "pipe" })
            const errP = new Response(p.stderr).text()
            const out = await new Response(p.stdout).text()
            const code = await p.exited
            const werr = firstLine(await safeText(errP))
            if (code !== 0) {
                dbg(`whisper exit=${code}: ${werr}`)
                rmSync(r.wav, { force: true })
                rmSync(r.flag, { force: true })
                await toast(`voice: whisper не обработал запись${werr ? `: ${werr}` : ""} (exit ${code}) — детали: /v`, "error", 8000)
                return
            }
            text = cleanText(out)
        } catch (e) {
            dbg(`whisper failed: ${e}`)
            rmSync(r.wav, { force: true })
            rmSync(r.flag, { force: true })
            await toast(`voice: whisper не запустился (${opts.whisperBin}) — перезапусти install.sh`, "error", 8000)
            return
        }

        rmSync(r.wav, { force: true })
        rmSync(r.flag, { force: true })

        if (!text) {
            dbg("transcript empty")
            await toast("voice: не расслышал — говори громче и ближе к микрофону", "error")
            return
        }
        dbg(`transcript: ${text.slice(0, 80)}`)

        await toClipboard(text)
        let placed = false
        try {
            const res = await client.tui.appendPrompt({ body: { text } })
            placed = !res.error
        } catch (e) {
            dbg(`appendPrompt failed: ${e}`)
        }
        if (placed && opts.submit) {
            try { await client.tui.submitPrompt({ body: {} }) } catch {}
        }
        if (placed) {
            await toast(opts.submit ? "voice: отправлено" : "voice: текст в поле ввода (Enter — отправить)", "success")
        } else {
            await toast("voice: текст в буфере обмена — вставь Ctrl+V", "success")
        }
    }

    // /v — самопроверка: ffmpeg, устройство (тестовая запись), модель, whisper
    async function diag() {
        if (rec) { await toast("Идёт запись — закончи её через /s", "warning"); return }
        await toast("voice diag: проверяю…", "info", 1500)

        const rep: string[] = [
            `opencode-voice диагностика ${new Date().toISOString()}`,
            `платформа: ${isWSL ? "WSL2" : "нативный Linux"}`,
            `драйвер: ${isWSL ? "dshow" : `${effDriver()}${driverOverride && driverOverride !== opts.audioDriver ? ` (в сессии заменил ${opts.audioDriver})` : ""}`}`,
            `источник: ${opts.audioSource}`,
            "",
        ]
        let allOk = true
        const step = (name: string, ok: boolean, detail = "") => {
            rep.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
            if (!ok) allOk = false
        }

        const modelOk = existsSync(opts.model) && statSync(opts.model).size > 50_000_000
        step("модель", modelOk, modelOk ? opts.model : `не найдена или слишком мала: ${opts.model}`)

        const testWav = join(tmpdir(), `voice-diag-${stamp()}.wav`)
        let recOk = false

        if (isWSL) {
            const temp = await getWinTemp()
            let detail = ""
            if (!temp) {
                detail = "не удалось определить TEMP Windows"
            } else {
                try {
                    if (!recorderWin) recorderWin = await toWinPath(opts.recorder)
                    const wavWin = `${temp}\\voice-diag.wav`
                    const flagWin = `${temp}\\voice-diag.stop`
                    const wavL = wslPath(wavWin)
                    const flagL = wslPath(flagWin)
                    rmSync(flagL, { force: true })
                    rmSync(wavL, { force: true })
                    const p = Bun.spawn(
                        [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", recorderWin, "-Wav", wavWin, "-StopFlag", flagWin],
                        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
                    )
                    const errP = new Response(p.stderr).text()
                    await new Promise((res) => setTimeout(res, 2500))
                    try { writeFileSync(flagL, "stop") } catch {}
                    await p.exited
                    recOk = existsSync(wavL) && statSync(wavL).size > 4000
                    if (!recOk) {
                        const size = existsSync(wavL) ? statSync(wavL).size : 0
                        detail = `${firstLine(await safeText(errP)) || `powershell exit=${p.exitCode}`}; wav ${size} Б — проверь «device» в %USERPROFILE%\\.voice\\config.json`
                    } else {
                        try { copyFileSync(wavL, testWav) } catch {}
                    }
                    rmSync(wavL, { force: true })
                    rmSync(flagL, { force: true })
                } catch (e: any) {
                    detail = `${e}`
                }
            }
            step("запись (dshow + voice-rec.ps1)", recOk, recOk ? "тестовая запись ~2 с" : detail || "не удалась")
        } else {
            let ffVer = ""
            try {
                const p = Bun.spawn([opts.ffmpegBin, "-version"], { stdout: "pipe", stderr: "ignore" })
                ffVer = firstLine(await new Response(p.stdout).text())
                await p.exited
            } catch {}
            const devs = await ffmpegDevicesText()
            const hasPulse = /pulse/i.test(devs)
            const hasAlsa = /alsa/i.test(devs)
            const inputs = [hasPulse && "pulse", hasAlsa && "alsa"].filter(Boolean).join(", ")
            step("ffmpeg", !!ffVer && !!inputs, `${ffVer || "не найден"}; аудио-входы: ${inputs || "нет pulse/alsa"}`)

            let detail = ""
            const tries: string[] = [effDriver()]
            if (effDriver() === "pulse" && hasAlsa) tries.push("alsa")
            if (effDriver() === "alsa" && hasPulse) tries.push("pulse")
            for (const d of tries) {
                rmSync(testWav, { force: true })
                try {
                    const p = Bun.spawn(
                        [opts.ffmpegBin, "-y", "-hide_banner", "-loglevel", "error",
                            "-f", d, "-i", opts.audioSource, "-t", "2", "-ar", "16000", "-ac", "1", testWav],
                        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
                    )
                    const errP = new Response(p.stderr).text()
                    const code = await p.exited
                    const size = existsSync(testWav) ? statSync(testWav).size : 0
                    if (code === 0 && size > 4000) {
                        recOk = true
                        if (d !== opts.audioDriver) {
                            driverOverride = d
                            rep.push(`! источник через ${opts.audioDriver} молчит — в этой сессии использую ${d}; закрепи: "audioDriver": "${d}" в config.json`)
                        }
                        break
                    }
                    detail = `через ${d}: exit=${code}, wav ${size} Б; ${firstLine(await safeText(errP))}`
                } catch (e: any) {
                    detail = `через ${d}: ${e}`
                }
            }
            step("запись", recOk, recOk ? `${effDriver()}/${opts.audioSource}, тестовая запись ~2 с` : detail || "не удалась")
        }

        if (recOk) {
            try {
                const p = Bun.spawn([opts.whisperBin, "-m", opts.model, "-l", opts.language, "-nt", "-np", "-f", testWav],
                    { stdout: "pipe", stderr: "pipe" })
                const out = await new Response(p.stdout).text()
                const errP = new Response(p.stderr).text()
                const code = await p.exited
                const sample = cleanText(out).slice(0, 60)
                step("whisper", code === 0, code === 0
                    ? `${opts.whisperBin}; тест: ${sample ? `«${sample}»` : "тишина (это нормально, если вокруг тихо)"}`
                    : `exit=${code}; ${firstLine(await safeText(errP))}`)
            } catch (e: any) {
                step("whisper", false, `${e}`)
            }
        } else {
            const binOk = existsSync(opts.whisperBin)
            step("whisper", binOk, binOk ? "пропущено: нет тестовой записи" : `не найден: ${opts.whisperBin}`)
        }
        rmSync(testWav, { force: true })

        if (!isWSL) {
            const clipBin = process.env.WAYLAND_DISPLAY ? "wl-copy" : "xclip"
            // PATH передаётся явно: иначе бинаррь ищется по окружению на момент старта процесса
            const clipOk = !!Bun.which(clipBin, { PATH: process.env.PATH })
            step(`буфер обмена (${clipBin})`, clipOk, clipOk ? "" : `не найден; apt install ${clipBin === "wl-copy" ? "wl-clipboard" : "xclip"}`)
        }

        const diagPath = join(homeDir(), ".config", "opencode-voice", "diag.txt")
        try {
            mkdirSync(dirname(diagPath), { recursive: true })
            writeFileSync(diagPath, rep.join("\n") + "\n")
        } catch {}

        await toast(allOk ? `voice diag: всё работает ✓ (отчёт: ${diagPath})` : `voice diag: есть проблемы — полный отчёт: ${diagPath}`,
            allOk ? "success" : "error", 10000)
    }

    // слэш-команды должны существовать, чтобы хук вообще срабатывал
    const ensureCommand = (name: string, description: string) => {
        const f = join(homeDir(), ".config", "opencode", "commands", `${name}.md`)
        try {
            if (!existsSync(f)) {
                mkdirSync(dirname(f), { recursive: true })
                writeFileSync(f, `---\ndescription: ${description}\n---\n`)
            }
        } catch {}
    }
    ensureCommand("r", "● Голос: начать запись")
    ensureCommand("s", "■ Голос: закончить — текст в поле ввода")
    ensureCommand("v", "🔧 Голос: проверить микрофон и whisper")

    return {
        "command.execute.before": async (input: { command: string }, output: { parts: any[] }) => {
            if (input.command !== "r" && input.command !== "s" && input.command !== "v") return
            dbg(`hook fired: command=${input.command}`)
            output.parts.length = 0
            if (input.command === "r") {
                await start()
                throw new Error("voice: запись начата")
            } else if (input.command === "s") {
                await stop()
                throw new Error("voice: готово")
            } else {
                await diag()
                throw new Error("voice: диагностика завершена")
            }
        },
    }
}
