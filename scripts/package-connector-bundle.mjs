import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))

const args = parseArgs(process.argv.slice(2))
const outDir = path.resolve(projectRoot, args.outDir || path.join('temp', 'connector-bundle'))
const zipPath = `${outDir}.zip`
const adbDir = detectAdbDir(args.adbDir)
const nodeDir = path.resolve(args.nodeDir || path.dirname(process.execPath))

await ensureBuildArtifacts()
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await copyRuntime(nodeDir, outDir)
await copyApp(outDir)
await copyAdb(outDir, adbDir)
await writeBundleFiles(outDir, adbDir)

if (args.zip) {
  await rm(zipPath, { force: true })
  await createZipArchive(outDir, zipPath)
}

console.log(`Connector bundle ready: ${outDir}`)
if (args.zip) {
  console.log(`Connector archive ready: ${zipPath}`)
}
if (!adbDir) {
  console.warn('ADB platform-tools were not found on this computer. The bundle includes a placeholder README in /adb.')
}

function parseArgs(argv) {
  const parsed = {
    outDir: null,
    adbDir: null,
    nodeDir: null,
    zip: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
    case '--out-dir':
      parsed.outDir = argv[++index]
      break
    case '--adb-dir':
      parsed.adbDir = argv[++index]
      break
    case '--node-dir':
      parsed.nodeDir = argv[++index]
      break
    case '--zip':
      parsed.zip = true
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return parsed
}

async function ensureBuildArtifacts() {
  const requiredPaths = ['.build', 'node_modules']

  for (const relativePath of requiredPaths) {
    const fullPath = path.join(projectRoot, relativePath)
    if (!existsSync(fullPath)) {
      throw new Error(
        `Missing ${relativePath}. Run "npm ci" in ${projectRoot} before bundling the connector package.`
      )
    }
  }
}

async function copyRuntime(nodeSourceDir, bundleRoot) {
  const runtimeDir = path.join(bundleRoot, 'node')
  await mkdir(runtimeDir, { recursive: true })

  const nodeEntries = await readdir(nodeSourceDir)
  const includeEntry = (entry) => {
    if (process.platform === 'win32') {
      return (
        entry === 'node.exe' ||
        entry.toLowerCase().endsWith('.dll') ||
        entry.toLowerCase() === 'license'
      )
    }

    return entry === 'node' || entry.toLowerCase() === 'license'
  }

  for (const entry of nodeEntries.filter(includeEntry)) {
    await cp(path.join(nodeSourceDir, entry), path.join(runtimeDir, entry), { recursive: true })
  }
}

async function copyApp(bundleRoot) {
  const appDir = path.join(bundleRoot, 'app')
  await mkdir(appDir, { recursive: true })

  const entriesToCopy = ['.build', 'node_modules', 'package.json', 'package-lock.json']

  for (const entry of entriesToCopy) {
    await cp(path.join(projectRoot, entry), path.join(appDir, entry), {
      recursive: true,
      dereference: true,
    })
  }
}

async function copyAdb(bundleRoot, adbSourceDir) {
  const adbTargetDir = path.join(bundleRoot, 'adb')
  await mkdir(adbTargetDir, { recursive: true })

  if (!adbSourceDir) {
    return
  }

  await cp(adbSourceDir, adbTargetDir, { recursive: true })
}

async function writeBundleFiles(bundleRoot, adbSourceDir) {
  const configDir = path.join(bundleRoot, 'config')
  const scriptsDir = path.join(bundleRoot, 'scripts')
  await mkdir(configDir, { recursive: true })
  await mkdir(scriptsDir, { recursive: true })

  await writeFile(path.join(configDir, 'provider.env'), createProviderEnvTemplate(), 'utf8')
  await writeFile(path.join(scriptsDir, 'start-adb.ps1'), createStartAdbScript(), 'utf8')
  await writeFile(path.join(scriptsDir, 'start-provider.ps1'), createStartProviderScript(), 'utf8')
  await writeFile(
    path.join(bundleRoot, 'README.md'),
    createReadme(adbSourceDir),
    'utf8'
  )
  await writeFile(
    path.join(bundleRoot, 'bundle-manifest.json'),
    JSON.stringify(
      {
        package: packageJson.name,
        version: packageJson.version,
        createdAt: new Date().toISOString(),
        createdOnHost: os.hostname(),
        includedAdb: Boolean(adbSourceDir),
        nodeSource: nodeDir,
      },
      null,
      2
    ),
    'utf8'
  )

  if (!adbSourceDir) {
    await writeFile(
      path.join(bundleRoot, 'adb', 'README.txt'),
      'Copy Android platform-tools into this directory before running start-adb.ps1.',
      'utf8'
    )
  }
}

async function createZipArchive(sourceDir, destinationZip) {
  if (process.platform !== 'win32') {
    return
  }

  const sourcePath = toPowerShellPath(sourceDir)
  const destinationPath = toPowerShellPath(destinationZip)
  await execFile('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${sourcePath}\\*' -DestinationPath '${destinationPath}' -Force`,
  ], {
    cwd: projectRoot,
  })
}

function detectAdbDir(customAdbDir) {
  const candidates = []

  if (customAdbDir) {
    candidates.push(customAdbDir)
  }

  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools'))
  }

  if (process.env.ANDROID_HOME) {
    candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools'))
  }

  if (process.env.ANDROID_SDK_ROOT) {
    candidates.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools'))
  }

  candidates.push('C:\\platform-tools')

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    const adbExecutable = path.join(candidate, process.platform === 'win32' ? 'adb.exe' : 'adb')
    if (existsSync(adbExecutable)) {
      return path.resolve(candidate)
    }
  }

  return null
}

function createProviderEnvTemplate() {
  return [
    '# Update these values for each connection machine before running start-provider.ps1',
    'SERVER_HOST=device.huangqiu.org',
    'PROVIDER_NAME=connector-01',
    'PROVIDER_IP=CHANGE_ME',
    'MIN_PORT=12010',
    'MAX_PORT=12100',
    'STF_SECRET=CHANGE_ME',
    'ALLOW_SELF_SIGNED=0',
    '',
  ].join('\n')
}

function createStartAdbScript() {
  return [
    "$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path",
    '$RootDir = Split-Path -Parent $ScriptDir',
    '$AdbExe = Join-Path $RootDir "adb\\adb.exe"',
    'if (-not (Test-Path $AdbExe)) {',
    '    Write-Error "adb.exe not found. Put Android platform-tools into the adb directory first."',
    '    exit 1',
    '}',
    'Set-Location (Split-Path -Parent $AdbExe)',
    '& $AdbExe kill-server | Out-Host',
    '& $AdbExe start-server | Out-Host',
    '& $AdbExe devices',
    '',
  ].join('\r\n')
}

function createStartProviderScript() {
  return [
    '$ErrorActionPreference = "Stop"',
    '$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$RootDir = Split-Path -Parent $ScriptDir',
    '$EnvFile = Join-Path $RootDir "config\\provider.env"',
    'if (-not (Test-Path $EnvFile)) {',
    '    Write-Error "provider.env not found."',
    '    exit 1',
    '}',
    'Get-Content $EnvFile | ForEach-Object {',
    '    if ($_ -match "^\\s*#") { return }',
    '    if ($_ -match "^\\s*$") { return }',
    '    $name, $value = $_ -split "=", 2',
    '    [System.Environment]::SetEnvironmentVariable($name, $value)',
    '}',
    '$NodeExe = Join-Path $RootDir "node\\node.exe"',
    'if (-not (Test-Path $NodeExe)) {',
    '    Write-Error "node.exe not found in bundle runtime."',
    '    exit 1',
    '}',
    'if ($env:ALLOW_SELF_SIGNED -eq "1") {',
    '    $env:NODE_TLS_REJECT_UNAUTHORIZED = "0"',
    '}',
    '$AppDir = Join-Path $RootDir "app"',
    'Set-Location $AppDir',
    '& $NodeExe ".build\\bin\\stf.mjs" provider `',
    '  --name $env:PROVIDER_NAME `',
    '  --adb-host 127.0.0.1 `',
    '  --adb-port 5037 `',
    '  --no-cleanup `',
    '  --connect-sub ("tcp://" + $env:SERVER_HOST + ":7250") `',
    '  --connect-push ("tcp://" + $env:SERVER_HOST + ":7270") `',
    '  --storage-url ("https://" + $env:SERVER_HOST + "/") `',
    '  --public-ip $env:PROVIDER_IP `',
    '  --min-port $env:MIN_PORT `',
    '  --max-port $env:MAX_PORT `',
    '  --heartbeat-interval 10000 `',
    '  --screen-ws-url-pattern ("wss://" + $env:SERVER_HOST + "/d/" + $env:PROVIDER_IP + "/<%= publicPort %>/") `',
    '  --secret $env:STF_SECRET',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

function createReadme(adbSourceDir) {
  return [
    '# DeviceHub Connector Bundle',
    '',
    `Built from ${packageJson.name} ${packageJson.version}.`,
    '',
    '## Directory Layout',
    '- `node/`: bundled Node.js runtime for Windows',
    '- `adb/`: Android platform-tools',
    '- `app/`: DeviceHub provider runtime (`.build` + `node_modules`)',
    '- `config/provider.env`: per-connector settings',
    '- `scripts/start-adb.ps1`: starts the local adb server and lists devices',
    '- `scripts/start-provider.ps1`: starts the DeviceHub provider',
    '',
    '## First Run',
    '1. Edit `config/provider.env` and set `PROVIDER_IP` plus the shared `STF_SECRET`.',
    '2. Connect Android phones and enable USB debugging.',
    '3. Run `scripts/start-adb.ps1`.',
    '4. Run `scripts/start-provider.ps1`.',
    '',
    adbSourceDir
      ? `ADB platform-tools were copied from: \`${adbSourceDir}\``
      : 'ADB platform-tools were not found on the build computer. Copy them into `adb/` before using this bundle.',
    '',
  ].join('\n')
}

function toPowerShellPath(targetPath) {
  return targetPath.replace(/'/g, "''")
}
