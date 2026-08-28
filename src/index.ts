// opencode-voice — голосовой ввод внутри opencode.
// Команды /r (начать запись) и /s (закончить): расшифровка через whisper
// вставляется в поле ввода TUI (tui/append-prompt) и кладётся в буфер обмена.
// Индикатор записи — тосты с таймером.
//
// Платформы:
//   WSL2          — микрофон через powershell.exe/ffmpeg (dshow), буфер через Set-Clipboard,
//                   остановка записи — файл-флаг в TEMP Windows (voice-rec.ps1)
//   нативный Linux — ffmpeg (pulse/alsa) напрямую, остановка по SIGINT,
//                   буфер через wl-copy (Wayland) или xclip (X11)
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

declare const Bun: any

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

const isWSL = (() => {
    try { return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")) }
    catch { return false }
})()

function cleanText(raw: string): string {
    let text = raw.split(/\s+/).join(" ").trim()

    for (const p of [/\bэ+\b/gi, /\bэм+\b/gi, /\bээ+\b/gi, /\bм+м+\b/gi, /\bну+ в общем\b/gi, /\bкороче говоря\b/gi]) {
        text = text.replace(p, " ")
    }
    text = text.replace(/\*+/g, " ")

    for (const [p, r] of [[/\bновая строка\b/gi, "\n"], [/\bабзац\b/gi, "\n\n"], [/\bотступ\b/gi, "\t"]] as const) {
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
    // Приоритет: опции из opencode.json > ~/.config/opencode-voice/config.json > дефолты
    let fileOpts: any = {}
    try {
        fileOpts = JSON.parse(readFileSync(join(homedir(), ".config", "opencode-voice", "config.json"), "utf8"))
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
        whisperBin: join(homedir(), ".voice", "whisper.cpp", "build", "bin", "whisper-cli"),
        model: join(homedir(), ".voice", "models", "ggml-small.bin"),
        debugLog: "",
        ...fileOpts,
        ...(options || {}),
    }

    interface Rec {
        pid: number
        wav: string
        flag: string        // WSL: файл-флаг остановки; на нативном Linux пусто
        startedAt: number
        hb: ReturnType<typeof setInterval>
    }
    let rec: Rec | null = null
    let winTemp = ""
    let recorderWin = ""

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

    const wslPath = (win: string) => `/mnt/${win[0].toLowerCase()}${win.slice(2)}`.replace(/\\/g, "/")

    async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = opts.toastMs) {
        try {
            await client.tui.showToast({ body: { message, variant, duration } })
        } catch {}
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

    async function start() {
        dbg(`start called, rec=${!!rec}`)
        if (rec) { await toast("● Запись уже идёт — введи /s чтобы закончить", "warning"); return }

        let wav: string
        let pid: number
        let flag = ""

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
                    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
                )
                pid = proc.pid
            } else {
                wav = join(tmpdir(), `voice-rec-${stamp()}.wav`)
                const proc = Bun.spawn(
                    [
                        opts.ffmpegBin, "-y", "-hide_banner", "-loglevel", "error",
                        "-f", opts.audioDriver, "-i", opts.audioSource,
                        "-t", String(opts.maxSeconds), "-ar", "16000", "-ac", "1", wav,
                    ],
                    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
                )
                pid = proc.pid
            }
            dbg(`spawned pid=${pid} wav=${wav}`)
        } catch (e) {
            dbg(`spawn failed: ${e}`)
            await toast(isWSL
                ? "voice: не удалось запустить рекордер (нужен ffmpeg на стороне Windows)"
                : "voice: не удалось запустить ffmpeg (apt install ffmpeg)", "error")
            return
        }

        rec = { pid, wav, flag, startedAt: Date.now(), hb: null as any }
        rec.hb = setInterval(async () => {
            if (!rec) return
            const sec = (Date.now() - rec.startedAt) / 1000
            if (sec >= opts.maxSeconds) { await stop(); return }
            await toast(`● ЗАПИСЬ ${sec.toFixed(0)}с — /s чтобы закончить`, "warning", 1100)
        }, 1000)
        await toast("● ЗАПИСЬ — говори, /s чтобы закончить", "warning", 1500)
    }

    async function stop() {
        dbg(`stop called, rec=${!!rec}`)
        if (!rec) { await toast("Запись не идёт — введи /r", "info"); return }
        const { pid, wav, flag, startedAt, hb } = rec
        rec = null
        clearInterval(hb)

        if (flag) writeFileSync(flag, "stop")            // WSL: voice-rec.ps1 сам завершит ffmpeg
        else { try { process.kill(pid, "SIGINT") } catch {} }  // нативный Linux: SIGINT финализирует wav
        for (let i = 0; i < 80; i++) {
            try { process.kill(pid, 0) } catch { break }
            await new Promise((r) => setTimeout(r, 100))
        }
        try { process.kill(pid, "SIGKILL") } catch {}

        let text = ""
        if (existsSync(wav) && statSync(wav).size > 4000) {
            try {
                const p = Bun.spawn([opts.whisperBin, "-m", opts.model, "-l", opts.language, "-nt", "-np", "-f", wav], {
                    stdout: "pipe", stderr: "ignore",
                })
                text = cleanText(await new Response(p.stdout).text())
                await p.exited
            } catch (e) {
                dbg(`whisper failed: ${e}`)
            }
        }
        rmSync(wav, { force: true })
        if (flag) rmSync(flag, { force: true })

        if (!text) {
            dbg("transcript empty")
            await toast("voice: не расслышал — запись пустая или слишком короткая", "error")
            return
        }
        dbg(`transcript: ${text.slice(0, 80)}`)

        await toClipboard(text)
        let placed = false
        try {
            const r = await client.tui.appendPrompt({ body: { text } })
            placed = !r.error
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

    return {
        "command.execute.before": async (input: { command: string }, output: { parts: any[] }) => {
            if (input.command !== "r" && input.command !== "s") return
            dbg(`hook fired: command=${input.command}`)
            output.parts.length = 0
            if (input.command === "r") {
                await start()
                throw new Error("voice: запись начата")
            } else {
                await stop()
                throw new Error("voice: готово")
            }
        },
    }
}
