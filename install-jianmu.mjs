#!/usr/bin/env node
/**
 * install-jianmu.mjs —— 建木一键安装（2026-11-13）
 *
 * 做四件事，任一步失败就**自动还原** profile 三文件：
 *   1) 备份 profile 的 package.json / pnpm-lock.yaml / cordis.patch.yml（带时间戳 + sha256）
 *   2) 把 tarball 装进 profile（优先用 DSH 自带 pnpm，其次 npm）
 *   3) 往 package.json 的 dsh.profile.bundles 写入包名（去重、保住原有顺序）
 *   4) 核验：五个包目录都在、bundles 里都有；打印下一步
 *
 * 用法：
 *   node install-jianmu.mjs                              # 装默认 profile（desktop）
 *   node install-jianmu.mjs --profile desktop
 *   node install-jianmu.mjs --profile "C:\\path\\to\\profile"
 *   node install-jianmu.mjs --dry-run                    # 只打印将做什么
 *   node install-jianmu.mjs --meta                       # 装元包 jianmu-all（只写一行 bundle）
 *
 * 安全：不碰数据根（~/.dsh/memory-jianmu 与 session-recall），不删任何东西。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, renameSync } from 'node:fs'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'

// 用 fileURLToPath，避免解压到含中文/空格的目录时 URL 百分号编码导致路径找不到
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKS = [
  { name: 'dsh-semantic-recall', file: 'dsh-semantic-recall-0.4.5.tgz' },
  { name: 'dsh-memory-store', file: 'dsh-memory-store-0.2.7.tgz' },
  { name: 'dsh-memory-process', file: 'dsh-memory-process-0.2.7.tgz' },
  { name: 'dsh-memory-yearring', file: 'dsh-memory-yearring-0.4.3.tgz' },
  { name: 'dsh-memory-persona', file: 'dsh-memory-persona-0.3.7.tgz' },
]
const META = { name: 'jianmu-all', file: 'meta/jianmu-all-0.1.0.tgz' }
const THREE = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']

// ── 参数
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const DRY = flag('--dry-run')
const USE_META = flag('--meta')
const profileArg = opt('--profile', 'desktop')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = /[\\/]/.test(profileArg) || isAbsolute(profileArg)
  ? resolve(profileArg)
  : join(DSH_HOME, 'profiles', profileArg)

const say = (s) => console.log(s)
const die = (s) => { console.error(`\n❌ ${s}`); process.exit(1) }

// ── 0. 前置检查
const nodeMajor = Number(String(process.versions.node).split('.')[0])
if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  die(`需要 Node.js 22 或更高（当前 ${process.versions.node}）。\n`
    + '   没有单独装 Node 的话，用 DSH 自带 node 运行：\n'
    + '   "%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe" install-jianmu.mjs')
}
if (!existsSync(profileDir)) die(`profile 目录不存在：${profileDir}\n   用 --profile <名字> 或 --profile <完整路径>`)
if (!existsSync(join(profileDir, 'package.json'))) die(`不是 DSH profile（缺 package.json）：${profileDir}`)

const packs = USE_META ? [META] : PACKS
const missing = packs.filter((p) => !existsSync(join(HERE, p.file)))
if (missing.length) {
  if (USE_META) {
    die(`公开版不随附元包（${META.file}）。\n   请去掉 --meta，用默认的五包安装。`)
  }
  die(`安装包里缺文件：${missing.map((m) => m.file).join('、')}\n   （请在解压后的发布目录里运行本脚本）`)
}

say(`\n建木安装${DRY ? '（演练模式，不改任何文件）' : ''}`)
say(`  profile：${profileDir}`)
say(`  方式：${USE_META ? '元包 jianmu-all（一行）' : '五包逐个装（五 行）'}`)
say(`  包：${packs.map((p) => p.name).join('、')}`)

// ── 1. 备份
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = join(profileDir, 'backup-jianmu-install-' + ts)
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

const existed = THREE.filter((f) => existsSync(join(profileDir, f)))
if (!DRY) {
  mkdirSync(backupDir, { recursive: true })
  const sums = []
  for (const f of existed) {
    copyFileSync(join(profileDir, f), join(backupDir, f))
    sums.push(`${sha(join(profileDir, f))}  ${f}`)
  }
  writeFileSync(join(backupDir, 'SHA256SUMS.before'), sums.join('\n') + '\n')
}
say(`\n[1/4] 备份 → ${DRY ? '（演练跳过）' : backupDir}（${existed.length} 个文件）`)

// ── 2. 装包
function findPnpm() {
  const nodeDir = dirname(process.execPath)
  const cands = [
    process.env.JIANMU_PNPM,
    // 用 DSH 自带 node 启动时：<deps>/node/bin/node.exe → <deps>/pnpm/bin/pnpm.cjs
    join(nodeDir, '..', '..', 'pnpm', 'bin', 'pnpm.cjs'),
    // DSH 把运行时复制到 ~/.dsh/dsh-runtimes/<runtime>/dependencies/
    join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
    // 安装版 DSH 的默认位置
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
      : null,
  ].filter(Boolean)
  return cands.find((p) => existsSync(p)) || null
}

function install() {
  // 把 tgz 复制进 profile 自己保管：以后用户清下载目录/移动发布目录，已装的依赖与重装都不受影响
  const vendorDir = join(profileDir, '.jianmu-packages')
  mkdirSync(vendorDir, { recursive: true })
  // 用相对路径安装：profile 整体搬目录也不会指向旧位置
  const files = packs.map((p) => {
    copyFileSync(join(HERE, p.file), join(vendorDir, p.file))
    return `.jianmu-packages/${p.file}`
  })
  const pnpmCjs = findPnpm()
  const win = platform() === 'win32'
  // node 直调（自带 pnpm）不需要 shell；PATH 上的 npm/pnpm 是 .cmd 垫片，必须 shell，
  // 但 shell 模式不会替我们加引号 —— 路径里有空格会被切断。
  const runners = []
  if (pnpmCjs) runners.push({ label: 'pnpm（DSH 自带）', cmd: process.execPath, args: [pnpmCjs, 'add', '--ignore-scripts', ...files], shell: false })
  runners.push({ label: win ? 'pnpm（PATH）' : 'pnpm', cmd: 'pnpm', args: ['add', '--ignore-scripts', ...files], shell: win })
  runners.push({ label: 'npm', cmd: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...files], shell: win })

  const errors = []
  for (const r of runners) {
    try {
      say(`      用 ${r.label} 安装…`)
      const args = r.shell ? r.args.map((a) => `"${a}"`) : r.args
      execFileSync(r.cmd, args, { cwd: profileDir, stdio: 'pipe', timeout: 600000, shell: r.shell })
      return r.label
    } catch (e) {
      errors.push(`${r.label}: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' ').slice(0, 200)}`)
    }
  }
  throw new Error('三种安装方式都失败：\n  ' + errors.join('\n  '))
}

let usedPm = '(演练未执行)'
if (!DRY) {
  try {
    usedPm = install()
  } catch (e) {
    say(`\n❌ 安装失败，正在还原 profile 三文件…`)
    restore()
    die(String(e?.message || e))
  }
}
say(`[2/4] 安装完成（${usedPm}）`)

// ── 3. 写 bundles
const pkgFile = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const before = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : []
const want = packs.map((p) => p.name)
const added = want.filter((n) => !before.includes(n))
pkg.dsh.profile.bundles = [...before, ...added]
say(`[3/4] bundles：${added.length ? '新增 ' + added.join('、') : '已存在，无需改动'}`)
if (!DRY && added.length) {
  const tmp = pkgFile + '.tmp-jianmu'
  writeFileSync(tmp, JSON.stringify(pkg, null, 2) + '\n')
  renameSync(tmp, pkgFile)
}

// ── 4. 核验
if (!DRY) {
  const nm = join(profileDir, 'node_modules')
  const notInstalled = want.filter((n) => !existsSync(join(nm, n)))
  if (notInstalled.length) {
    say(`\n❌ 安装后找不到：${notInstalled.join('、')}，正在还原…`)
    restore()
    die('安装核验失败')
  }
  const now = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const notListed = want.filter((n) => !(now.dsh?.profile?.bundles || []).includes(n))
  if (notListed.length) die(`bundles 里缺：${notListed.join('、')}（请手工补）`)
}
say(DRY ? '[4/4] 核验：（演练跳过）' : '[4/4] 核验通过：包在、bundles 在')

// ── 收尾
function restore() {
  try {
    for (const f of existed) copyFileSync(join(backupDir, f), join(profileDir, f))
    say(`   已从 ${backupDir} 还原 ${existed.length} 个文件`)
  } catch (e) {
    say(`   ⚠️ 还原失败，请手工从 ${backupDir} 复制回去：${e?.message || e}`)
  }
}

say(`\n${DRY ? '（演练结束，没有改动任何文件）' : '✅ 装好了'}`)
say(`  备份：${DRY ? '（无）' : backupDir}`)
say(`  下一步：重启 DSH 桌面版（关掉窗口再打开），侧栏会出现对应入口。`)
say(`  卸载：${USE_META ? '从 bundles 删掉 jianmu-all' : '从 bundles 删掉这五个名字'}，再卸包；**数据不会被删**。`)
