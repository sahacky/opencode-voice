// Обёртка Bun.spawn для WSL-тестов: вызовы powershell.exe и wslpath подменяются
// bash-стабами, остальные проходят насквозь. Отказы spawn — через VOICE_SPAWN_THROW
// в tests/preload.ts.
import { join } from "node:path"

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

export function installSpawnPatch() {
    const real = (Bun as any).spawn.bind(Bun)
    const restore = () => { (Bun as any).spawn = real }

    ;(Bun as any).spawn = (cmd: string[] | string, opts: any = {}) => {
        // отказ имитируем по исходной команде — до подмены PS/wslpath
        const needle = process.env.VOICE_SPAWN_THROW
        if (needle && (Array.isArray(cmd) ? cmd.join(" ") : String(cmd)).includes(needle)) {
            throw new Error(`stub: spawn refused (${needle})`)
        }
        if (Array.isArray(cmd) && cmd[0] === PS) {
            return real(["bash", join(import.meta.dir, "stubs", "ps-stub.sh"), ...cmd.slice(1)], opts)
        }
        if (Array.isArray(cmd) && cmd[0] === "wslpath") {
            return real(["bash", "-c", "printf 'C:\\\\t\\\\voice-rec.ps1\\n'"], opts)
        }
        return real(cmd, opts)
    }
    return restore
}
