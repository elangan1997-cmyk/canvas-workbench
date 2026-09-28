// 独立运行 canvas-workbench 的 Host 半边（不依赖 DSH Desktop）。
//
// 用假 ctx 捕获 apply(ctx) 通过 ctx.webServer.register 注册的 /dsh-canvas 处理器，
// 挂到本地 http 端口，供 integration 测试与「重构前 / 重构后」API 对等比较使用。
// 模块解析：把插件目录拷到临时 stage，并在 stage 上层放一个 node_modules 软链指向
// DSH profile 的 node_modules（@deepseek-ai/dsh-llm 等由 DSH 提供，仓库本身不带）。
//
//   const host = await startHost({ pluginDir: 'canvas-workbench' });
//   const r = await fetch(host.baseUrl + '/dsh-canvas/health');
//   await host.close();

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, cp, stat, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function defaultDshNodeModules() {
  return process.env.DSH_NODE_MODULES || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');
}

function which(name) {
  return new Promise((res, rej) => {
    const p = spawn(process.platform === 'win32' ? 'where' : 'which', [name]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => code === 0 && out.trim() ? res(out.trim().split('\n')[0]) : rej(new Error('executable not found: ' + name)));
  });
}

/** 与 DSH ctx.subprocess.spawn 形状一致的最小实现：handle.done / handle.collected.stdout.readFrom(0).text / terminate。 */
function makeSubprocess() {
  return {
    async resolveExecutable(name) { return which(name); },
    spawn({ argv, cwd }) {
      const [cmd, ...args] = argv;
      const child = spawn(cmd, args, { cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
      const buf = { stdout: [], stderr: [] };
      child.stdout.on('data', (d) => buf.stdout.push(d));
      child.stderr.on('data', (d) => buf.stderr.push(d));
      const done = new Promise((res) => {
        child.on('error', (err) => res({ exitCode: 127, error: err }));
        child.on('close', (code, signal) => res({ exitCode: code === null ? 1 : code, signal }));
      });
      const collected = {
        stdout: { readFrom: () => ({ text: Buffer.concat(buf.stdout).toString('utf8') }) },
        stderr: { readFrom: () => ({ text: Buffer.concat(buf.stderr).toString('utf8') }) }
      };
      return { done, collected, terminate: async () => { try { child.kill('SIGTERM'); } catch {} } };
    }
  };
}

export function makeFakeCtx({ workspaceRoot, onRegister, log = () => {} } = {}) {
  const effects = [];
  const listeners = new Map();
  const services = {
    fs: {
      async stat(p) { return stat(p); },
      async resolve(p) { return resolve(p); },
      async readBytes(p) { return readFile(p); }
    },
    sandboxPolicy: { workspaceRoot: workspaceRoot || null },
    webServer: {
      register(spec) {
        onRegister(spec);
        return () => { spec.disposed = true; };
      }
    },
    subprocess: makeSubprocess(),
    llm: {
      async prepareCall() { throw new Error('harness: llm unavailable'); },
      async resolveModelInfo() { throw new Error('harness: llm unavailable'); }
    },
    attachments: {
      async saveImage() { throw new Error('harness: attachments unavailable'); },
      async readImage() { throw new Error('harness: attachments unavailable'); }
    },
    agents: { list: () => [], get: () => null },
    tools: { get: () => null, register: () => () => {} }
  };
  const ctx = {
    get(name) { return services[name]; },
    fs: services.fs,
    webServer: services.webServer,
    subprocess: services.subprocess,
    llm: services.llm,
    attachments: services.attachments,
    agents: services.agents,
    tools: services.tools,
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    effect(fn, label) { const d = fn(); effects.push({ dispose: d, label }); },
    inject(deps, cb) { cb(ctx); },
    emit(event, payload) { return Promise.all((listeners.get(event) || []).map((fn) => fn(payload))); },
    dispose() { for (const e of effects.splice(0)) { try { if (typeof e.dispose === 'function') e.dispose(); } catch {} } },
    log
  };
  return ctx;
}

/**
 * 启动独立 Host。pluginDir 为 canvas-workbench 目录（仓库工作树或 git archive 导出）。
 * 返回 { baseUrl, port, ctx, stageDir, close }。
 */
export async function startHost({ pluginDir, port = 0, workspaceRoot = null, nodeModules = defaultDshNodeModules() } = {}) {
  const stageRoot = await mkdtemp(join(tmpdir(), 'dsh-host-harness-'));
  const stage = join(stageRoot, 'plugin');
  await cp(pluginDir, stage, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.git|tests|docs)([\\/]|$)/.test(src) && !/[\\/]\._/.test(src)
  });
  try { await realpath(nodeModules); await symlink(nodeModules, join(stageRoot, 'node_modules'), 'dir'); }
  catch (err) { throw new Error('DSH node_modules 不可用（用于解析 @deepseek-ai/*）：' + nodeModules + ' — ' + err.message); }

  // cp 到隔离 stage 时会刻意排除 node_modules，但候选版 Host 仍必须能解析
  // package.json 正式声明的运行时依赖（如 ag-psd）。逐项链接工作树已安装副本，
  // 既不把整棵 node_modules 复制进临时目录，也不用假 stub 掩盖真实包装缺失。
  const stagedPackage = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(stagedPackage.dependencies || {})) {
    const installed = join(pluginDir, 'node_modules', ...dependency.split('/'));
    try { await realpath(installed); }
    catch (err) { throw new Error(`候选插件运行时依赖未安装：${dependency} — ${err.message}`); }
    const target = join(stage, 'node_modules', ...dependency.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await symlink(installed, target, 'dir');
  }

  // Electron 内置的 @deepseek-ai/dsh-tools 由宿主模块加载器提供，不一定作为
  // 实体包出现在 profile/node_modules。独立 Host 只需 defineTool 的最小形状，
  // 因此在实体包缺席时为测试 stage 放一个局部 stub；生产插件仍由 DSH 提供真包。
  try {
    await realpath(join(nodeModules, '@deepseek-ai', 'dsh-tools'));
  } catch {
    const stub = join(stage, 'node_modules', '@deepseek-ai', 'dsh-tools');
    await mkdir(stub, { recursive: true });
    await writeFile(join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', exports: './index.js' }), 'utf8');
    await writeFile(join(stub, 'index.js'), 'export const defineTool = (spec) => spec;\n', 'utf8');
  }

  let handlerSpec = null;
  const ctx = makeFakeCtx({ workspaceRoot, onRegister: (spec) => { handlerSpec = spec; } });
  const mod = await import(pathToFileURL(join(stage, 'lib', 'index.js')).href + '?t=' + Date.now());
  const apply = mod.apply || (mod.default && mod.default.apply) || mod.default;
  if (typeof apply !== 'function') throw new Error('lib/index.js 未导出 apply');
  apply(ctx);
  if (!handlerSpec) throw new Error('apply(ctx) 没有注册 webServer 处理器');

  const server = createServer((req, res) => {
    const url = String(req.url || '/');
    if (!url.startsWith(handlerSpec.path)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    Promise.resolve(handlerSpec.handler(req, res)).catch((err) => {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('handler error: ' + (err && err.message)); }
    });
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const actualPort = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    ctx,
    stageDir: stage,
    async close() {
      ctx.dispose();
      await new Promise((res) => server.close(() => res()));
      await rm(stageRoot, { recursive: true, force: true });
    }
  };
}

/** 对某个 Host 执行请求清单，返回归一化后的响应字典。 */
export async function runRequests(baseUrl, requests, { normalizeResponse, fixtureDir, fixtureRoot, sha256 }) {
  const results = {};
  for (const req of requests) {
    const init = { method: req.method };
    if (req.method !== 'GET' && req.method !== 'OPTIONS') { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(req.body || {}); }
    const r = await fetch(baseUrl + req.path, init);
    const contentType = r.headers.get('content-type') || '';
    const res = { status: r.status, contentType, binary: Boolean(req.binary) };
    if (req.binary) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.byteLength = buf.byteLength; res.sha256 = sha256(buf);
    } else {
      const text = await r.text();
      res.byteLength = text.length;
      try { res.body = /json/.test(contentType) ? JSON.parse(text) : text; } catch { res.body = text; }
    }
    results[req.name] = normalizeResponse(res, { fixtureDir, fixtureRoot });
  }
  return results;
}
