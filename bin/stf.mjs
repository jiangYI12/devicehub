#!/usr/bin/env -S node --import ./lib/util/instrument.mjs
const packageData = (await import('../package.json', { with: { type: 'json' } })).default
await import('../lib/util/load-env-file.mjs')
console.log(`Starting DeviceHub ${packageData.version}`)
await import('../lib/cli/index.js')
