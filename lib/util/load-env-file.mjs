import { existsSync, readFileSync } from 'node:fs'

const configPath = process.env.DEVICEHUB_ENV_FILE

if (configPath && existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf8')

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) {
            continue
        }

        const separatorIndex = line.indexOf('=')
        if (separatorIndex === -1) {
            continue
        }

        const name = line.slice(0, separatorIndex).trim()
        const value = line.slice(separatorIndex + 1).trim()

        if (!name) {
            continue
        }

        process.env[name] = value
    }
}
