// preload для bun test (подхватывается через bunfig.toml).
// Bun.spawn без явного env наследует реальный environ процесса, а не текущий
// process.env — мутации окружения из тестов до стабов бы не доезжали.
// Здесь spawn всегда получает снапшот process.env на момент вызова;
// VOICE_SPAWN_THROW=<подстрока> заставляет spawn бросить исключение
// (покрытие catch-веток плагина).
const real = (Bun as any).spawn.bind(Bun)
;(Bun as any).spawn = (cmd: string[] | string, opts: any = {}) => {
    const needle = process.env.VOICE_SPAWN_THROW
    if (needle && (Array.isArray(cmd) ? cmd.join(" ") : String(cmd)).includes(needle)) {
        throw new Error(`stub: spawn refused (${needle})`)
    }
    return real(cmd, { ...opts, env: opts?.env ?? { ...process.env } })
}
