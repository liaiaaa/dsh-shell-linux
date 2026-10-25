/**
 * The About window's document, built as a string.
 *
 * Kept as a pure function so the content rules (escaping, which versions are shown, the safe-mode
 * badge, the initial update state) are unit-testable without an Electron runtime. The page has no
 * Node access: buttons call the preload bridge (`window.dshUI`), and the main process pushes new
 * update states back as `ABOUT_IPC.state`.
 */
import type { AboutUpdateState } from '../shared/about-ipc.ts'

export type AboutVersions = {
  /** The shell's own version (`app.getVersion()`). */
  shellVersion: string
  /** The system DSH install the shell references. */
  dshVersion: string
  electron: string
  node: string
  chrome: string
  /** The standalone Node that runs the host child. */
  hostNode: string
}

export type AboutProps = AboutVersions & {
  safeMode: boolean
  /** `data:image/png;base64,…` for the inline icon; empty when the file could not be read. */
  iconDataUri: string
  update: AboutUpdateState
}

/** Escape text for HTML text nodes and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** JSON that cannot close the surrounding `<script>` element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

function versionRows(versions: AboutVersions): string {
  const rows: readonly (readonly [string, string])[] = [
    ['壳子', versions.shellVersion],
    ['DSH（系统安装）', versions.dshVersion],
    ['Electron', versions.electron],
    ['Node（主进程）', versions.node],
    ['Chrome', versions.chrome],
    ['host 子进程解释器', versions.hostNode],
  ]
  return rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')
}

/** The page script: renders update states and forwards clicks to the preload bridge. */
const PAGE_SCRIPT = `
const el = (id) => document.getElementById(id)
let state = initial
function render(next) {
  state = next
  const status = el('update-status')
  const log = el('update-log')
  el('check').disabled = false
  el('upgrade').hidden = true
  el('cancel').hidden = true
  el('relaunch').hidden = true
  switch (state.kind) {
    case 'idle':
      status.textContent = '还没有检查更新。'
      break
    case 'checking':
      status.textContent = '正在检查 npm registry…'
      el('check').disabled = true
      break
    case 'latest':
      status.textContent = '已是最新版本 ' + state.version + '（跟踪 npm 的 ' + state.channel + ' 标签）。'
      break
    case 'available':
      status.textContent = '发现新版本 ' + state.version + '（跟踪 ' + state.channel + ' 标签）。'
      el('upgrade').hidden = false
      el('upgrade').textContent = state.canUpgrade ? '立即升级' : '复制升级命令'
      break
    case 'unreachable':
    case 'error':
      status.textContent = '检查失败：' + state.reason
      break
    case 'upgrading':
      status.textContent = '正在升级…（完成后重启壳子生效）'
      el('check').disabled = true
      el('cancel').hidden = false
      break
    case 'upgraded':
      status.textContent = '已升级到 ' + state.version + '，重启壳子后生效。'
      el('relaunch').hidden = false
      break
    case 'dry-run':
      status.textContent = '演练模式：没有真正安装。将执行 ' + state.command
      break
  }
  const lines = state.log || []
  log.hidden = lines.length === 0
  log.textContent = lines.join('\\n')
}
el('check').onclick = () => { void window.dshUI.check() }
el('upgrade').onclick = async () => {
  if (state.kind === 'available' && !state.canUpgrade) {
    await window.dshUI.copyText(state.command)
    el('update-status').textContent = '命令已复制：' + state.command
    return
  }
  await window.dshUI.upgrade()
}
el('cancel').onclick = () => { void window.dshUI.cancelUpgrade() }
el('relaunch').onclick = () => { void window.dshUI.relaunch() }
el('copy').onclick = () => { void window.dshUI.copySummary() }
el('repo').onclick = () => { void window.dshUI.openRepo() }
el('close').onclick = () => { void window.dshUI.close() }
if (window.dshUI) window.dshUI.onState(render)
render(initial)
`

/**
 * Build the About window document.
 *
 * @param props - the shell's versions, mode, icon, and the update state to show immediately.
 * @returns a complete HTML document for a `data:` URL.
 */
export function aboutDocument(props: AboutProps): string {
  const badge = props.safeMode
    ? '<span class="badge" id="mode-badge">安全模式</span>'
    : '<span class="badge normal" id="mode-badge">正常</span>'
  const icon = props.iconDataUri === ''
    ? ''
    : `<img id="app-icon" alt="" src="${escapeHtml(props.iconDataUri)}">`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>关于 dsh-shell-linux</title>
<style>
:root { color-scheme: light dark }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1c1c; --fg:#efefef; --muted:#9a9a9a; --card:#242424; --line:#3a3a3a; --accent:#4a9eff } }
@media (prefers-color-scheme: light) { :root { --bg:#f6f6f6; --fg:#1c1c1c; --muted:#666; --card:#ffffff; --line:#dddddd; --accent:#0a66c2 } }
* { box-sizing: border-box }
html, body { margin: 0 }
body { height: 100vh; overflow: auto; padding: 20px 24px; background: var(--bg); color: var(--fg);
  font: 14px/1.6 system-ui, "Noto Sans CJK SC", "Source Han Sans SC", sans-serif }
header { display: flex; align-items: center; gap: 14px }
header img { width: 56px; height: 56px; border-radius: 12px }
h1 { margin: 0; font-size: 18px; font-weight: 600 }
.sub { color: var(--muted); font-size: 13px }
.badge { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px; font-size: 12px;
  border: 1px solid var(--line); color: var(--muted) }
.badge.normal { color: var(--fg) }
h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600 }
section { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card) }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 8px 0 0; font-size: 13px }
dt { color: var(--muted) }
dd { margin: 0; word-break: break-all }
#update-status { margin: 0 0 8px; min-height: 1.6em }
.row { display: flex; gap: 8px; flex-wrap: wrap }
button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line);
  background: transparent; color: var(--fg); cursor: pointer }
button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff }
button:disabled { opacity: .5; cursor: default }
[hidden] { display: none !important }
pre { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,.25); color: var(--muted);
  font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; max-height: 140px; overflow: auto }
footer { margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end }
</style></head>
<body><header>${icon}<div><h1>dsh-shell-linux <span class="sub">${escapeHtml(props.shellVersion)}</span>${badge}</h1>
<div class="sub">个人用的 Linux 桌面壳，把系统已装的 DSH 装进独立窗口。</div></div></header>
<section><h2>版本</h2><dl>${versionRows(props)}</dl></section>
<section><h2>更新</h2><p id="update-status"></p>
<div class="row"><button id="check" class="primary">检查更新</button><button id="upgrade" hidden>立即升级</button>
<button id="cancel" hidden>取消升级</button><button id="relaunch" hidden>重启壳子</button></div>
<pre id="update-log" hidden></pre></section>
<footer><button id="copy">复制版本信息</button><button id="repo">GitHub</button><button id="close">关闭</button></footer>
<script>const initial = ${jsonForScript(props.update)};${PAGE_SCRIPT}</script>
</body></html>`
}
