#!/usr/bin/env node
/**
 * 给 @deepseek-ai/dsh-mcp-client 打「启动宽限期」补丁（幂等，可在 dsh 升级后重跑）。
 *
 * 背景（2026-11-07 实测）：
 *   上游 lib/index.js 的 apply() 里 `const outcome = await connection.ready` 是无条件等待，
 *   而该包没有首次连接超时（只有 GENERATION_CLOSE_TIMEOUT_MS=5e3 与
 *   DEFAULT_TOOL_CALL_TIMEOUT_MS=6e4，都管不到首次连接）。
 *   `failOnStartupError: false` 只决定失败后是否抛错，不决定是否等待。
 *   于是 api.githubcopilot.com 这类直连慢的服务会把整个 Host 启动拖长 5~13 秒。
 *   A/B（spawn → 打印 URL，各 2 轮）：默认 16257/9431ms，禁用 MCP 后 3511/3511ms。
 *
 * 本补丁把那段 await 改成「最多等 DSH_MCP_STARTUP_GRACE_MS（默认 1500ms）」，
 * 超时就让 apply() 先返回，连接在后台继续。安全性依据：
 *   - 工具注册走独立的 syncChain（enqueueSync → ctx.tools.register），不依赖 apply 等完；
 *   - 包自带重连（默认 enabled:true / initialDelayMs:500 / maxDelayMs:30000 / maxAttempts:10）。
 *   所以代理没开时启动快，中途开代理后重连成功、GitHub 工具会自己出现。
 *
 * 用法：
 *   node scripts/patch-mcp-startup-grace.mjs            # 打补丁（自动备份）
 *   node scripts/patch-mcp-startup-grace.mjs --check    # 只检查状态，不写
 *   node scripts/patch-mcp-startup-grace.mjs --revert   # 从最近备份还原
 *   node scripts/patch-mcp-startup-grace.mjs --file <path>  # 指定 index.js
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const MARKER = 'LOCAL PATCH 2026-11-07 (dsh-shell-linux investigation)';
const ORIGINAL = `\tconst outcome = await connection.ready;
\tif (outcome.error !== void 0 && config.failOnStartupError) throw new Error(\`mcp-client(\${config.serverName}): initial connection or tool synchronization failed\`, { cause: outcome.error });`;

const PATCHED = `\t/* ${MARKER}: cap how long plugin
\t* activation waits for the first connection. Upstream awaits \`connection.ready\`
\t* unconditionally and has no connect timeout, so a slow/unreachable server
\t* (e.g. api.githubcopilot.com direct from CN, 5-13s) delays the whole Host boot.
\t* Tool registration runs on its own syncChain (see enqueueSync -> ctx.tools.register),
\t* and the built-in reconnect policy keeps retrying, so returning early is safe:
\t* tools appear as soon as the connection settles. Tune with DSH_MCP_STARTUP_GRACE_MS.
\t* Re-apply after a dsh upgrade with: node <dsh-shell-linux>/scripts/patch-mcp-startup-grace.mjs
\t*/
\tconst graceMs = Number(process.env.DSH_MCP_STARTUP_GRACE_MS ?? 1500);
\tlet graceTimer;
\tconst outcome = await Promise.race([connection.ready, new Promise((resolve) => {
\t\tgraceTimer = setTimeout(() => resolve({ deferred: true }), graceMs);
\t\tgraceTimer.unref?.();
\t})]);
\tif (graceTimer !== void 0) clearTimeout(graceTimer);
\tif (outcome.deferred) {
\t\tctx.logger.info(\`mcp-client(\${config.serverName}): still connecting after \${graceMs}ms; continuing in background (tools register on connect)\`);
\t\tvoid connection.ready.then((late) => {
\t\t\tif (late.error !== void 0) ctx.logger.warn(\`mcp-client(\${config.serverName}): background initial connection failed: \${String(late.error)}\`);
\t\t});
\t\treturn;
\t}
\tif (outcome.error !== void 0 && config.failOnStartupError) throw new Error(\`mcp-client(\${config.serverName}): initial connection or tool synchronization failed\`, { cause: outcome.error });`;

function resolveTarget() {
  const explicit = process.argv.indexOf('--file');
  if (explicit !== -1) {
    const p = process.argv[explicit + 1];
    if (!p) throw new Error('--file 需要一个路径');
    return path.resolve(p);
  }
  // 从全局 dsh 安装里解析（npm root -g 的常见布局）
  const candidates = [
    '/home/li/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js',
  ];
  try {
    const require = createRequire(import.meta.url);
    candidates.unshift(require.resolve('@deepseek-ai/dsh-mcp-client/lib/index.js'));
  } catch { /* 本地没装就忽略 */ }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 dsh-mcp-client/lib/index.js，请用 --file <path> 指定');
}

const target = resolveTarget();
const src = fs.readFileSync(target, 'utf8');
const already = src.includes(MARKER);

if (process.argv.includes('--check')) {
  console.log(`file    : ${target}`);
  console.log(`patched : ${already}`);
  if (!already) console.log(`original snippet present: ${src.includes(ORIGINAL)}`);
  process.exit(0);
}

if (process.argv.includes('--revert')) {
  const dir = path.dirname(target);
  const baks = fs.readdirSync(dir)
    .filter((n) => n.startsWith(path.basename(target) + '.bak-'))
    .sort()
    .reverse();
  if (baks.length === 0) throw new Error('没有备份可还原');
  const bak = path.join(dir, baks[0]);
  fs.copyFileSync(bak, target);
  console.log(`已从 ${bak} 还原`);
  process.exit(0);
}

if (already) {
  console.log(`已经打过补丁，跳过：${target}`);
  process.exit(0);
}
if (!src.includes(ORIGINAL)) {
  console.error('找不到预期的原始代码片段——上游可能已改动这段逻辑。');
  console.error('请先人工核对 apply() 里 `await connection.ready` 那一段，再更新本脚本。');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const bak = `${target}.bak-${stamp}`;
fs.copyFileSync(target, bak);
fs.writeFileSync(target, src.replace(ORIGINAL, PATCHED), 'utf8');
console.log(`备份    : ${bak}`);
console.log(`已打补丁: ${target}`);
console.log('生效方式: 重启 dsh（承载当前会话的进程请由你自己重启）');
console.log('可调宽限: DSH_MCP_STARTUP_GRACE_MS=1500（毫秒）');
