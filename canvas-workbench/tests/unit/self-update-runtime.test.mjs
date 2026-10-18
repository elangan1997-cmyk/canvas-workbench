import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBundledPnpm, profileDirectoryFromPluginPath, updaterFailureSummary, updaterFallback } from '../../src/host/services/self-update-runtime.js';

for (const platform of ['darwin', 'win32']) for (const modern of [true, false]) {
  test(`updater resolves ${platform} ${modern ? 'primary-runtime' : 'legacy'} pnpm`, () => {
    const win = platform === 'win32';
    const resources = win ? 'C:\\Program Files\\DSH\\resources' : '/Applications/DSH.app/Contents/Resources';
    const suffix = modern ? 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs' : 'runtime/pnpm/bin/pnpm.mjs';
    const wanted = resources + (win ? '\\' + suffix.replace(/\//g, '\\') : '/' + suffix);
    assert.equal(resolveBundledPnpm({ execPath: win ? 'C:\\Program Files\\DSH\\DSH.exe' : '/Applications/DSH.app/Contents/MacOS/DSH',
      resourcesPath: resources, argv: [], platform, exists: (p) => p === wanted }), wanted);
  });
}

test('host-supplied pnpm wins and executable-relative layout works without resourcesPath', () => {
  const supplied = '/bundle/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
  assert.equal(resolveBundledPnpm({ argv: ['host', supplied], platform: 'darwin', exists: () => true }), supplied);
  const wanted = '/Applications/DSH.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
  assert.equal(resolveBundledPnpm({ argv: [], resourcesPath: null, execPath: '/Applications/DSH.app/Contents/MacOS/DSH', platform: 'darwin', exists: (p) => p === wanted }), wanted);
});

test('missing installer is reported before a child process can produce a misleading Node stack', () => {
  assert.throws(() => resolveBundledPnpm({ argv: [], exists: () => false }), /未找到 DSH 自带的 pnpm/);
});

test('profile is derived correctly for direct, pnpm store and Windows paths', () => {
  assert.equal(profileDirectoryFromPluginPath('/u/profiles/desktop/node_modules/canvas-workbench/src/host/services/self-update.js'), '/u/profiles/desktop');
  assert.equal(profileDirectoryFromPluginPath('/u/profiles/desktop/node_modules/.pnpm/canvas-workbench@1.9.55/node_modules/canvas-workbench/src/host/services/self-update.js'), '/u/profiles/desktop');
  assert.equal(profileDirectoryFromPluginPath('C:\\用户\\profiles\\desktop\\node_modules\\canvas-workbench\\src\\self-update.js'), 'C:/用户/profiles/desktop');
  assert.equal(profileDirectoryFromPluginPath('/project/canvas-workbench/src/self-update.js'), '');
});

test('error summary retains Cannot find module instead of only stack-tail lines', () => {
  const result = { code: 1, log: "node:internal/modules/cjs/loader:1575\n throw err;\nError: Cannot find module '/bad/pnpm.mjs'\n at Module._resolveFilename\n at Module.executeUserEntryPoint\n at node:internal/main/run_main_module:33:47" };
  assert.match(updaterFailureSummary(result), /^Error: Cannot find module '\/bad\/pnpm.mjs'/);
  assert.equal(updaterFailureSummary({ error: 'spawn ENOENT' }), 'spawn ENOENT');
});

test('fallback instructions match OS and escape spaces/apostrophes', () => {
  const opts = { exe: "C:/O'Neil/DSH.exe", pnpm: 'C:/App Space/pnpm.mjs', version: '1.9.56', profileDir: 'C:/用户/desktop' };
  const win = updaterFallback({ ...opts, platform: 'win32' });
  assert.match(win, /PowerShell/);
  assert.ok(win.includes("'C:/O''Neil/DSH.exe'"));
  const mac = updaterFallback({ ...opts, platform: 'darwin' });
  assert.doesNotMatch(mac, /PowerShell|\$env:/);
  assert.ok(mac.includes("'C:/O'\\''Neil/DSH.exe'"));
  assert.match(mac, /ELECTRON_RUN_AS_NODE=1/);
});
