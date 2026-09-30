import { homedir, platform } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';

export const platformName = platform();
export const isWindows = platformName === 'win32';
export const isMac = platformName === 'darwin';

export function userHome() {
  return homedir() || process.env.USERPROFILE || process.env.HOME || process.cwd();
}

export function expandUserPath(value) {
  const input = String(value || '').trim();
  if (input === '~') return userHome();
  if (/^~[\\/]/.test(input)) return join(userHome(), input.slice(2));
  return input;
}

export function isAbsolutePath(value) {
  const expanded = expandUserPath(value);
  return isAbsolute(expanded) || win32.isAbsolute(expanded);
}

/** Windows 系统目录里的关键 exe:新版桌面沙箱的 PATH 不一定包含 C:\Windows,
 *  探测列表前先试 SystemRoot 绝对路径,explorer/powershell 不再依赖 PATH。 */
function windowsAbsoluteCandidates(names) {
  if (!isWindows || !Array.isArray(names)) return [];
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const out = [];
  for (const name of names) {
    if (!/\.exe$/i.test(name)) continue;
    out.push(join(root, 'System32', name), join(root, name));
  }
  return out;
}

export async function resolveFirst(ctx, names) {
  const absolute = windowsAbsoluteCandidates(names);
  if (absolute.length) {
    const { access } = await import('node:fs/promises');
    for (const candidate of absolute) {
      try { await access(candidate); return candidate; } catch {}
    }
  }
  for (const name of names) {
    try {
      const executable = await ctx.subprocess.resolveExecutable(name);
      if (executable) return executable;
    } catch {}
  }
  return '';
}

export async function resolvePython(ctx) {  // 便携运行时的相对位置在两个平台上不一样，且 Windows 打包实际没有 Scripts 层：
  //   macOS/Linux : python-runtime/bin/python
  //   Windows     : python-runtime/python.exe（根目录；打包清单见 runtime-manifest.txt）
  //               部分构建/Maximize 装配会额外产生 Scripts/python.exe
  // 两种都探测，否则 Windows 上会完全绕过自带运行时（Pillow/numpy/scipy/rembg/psd-tools
  // 都在里面），退回 PATH 里的系统 Python —— 而那些包系统里通常没有。
  const runtimeRoot = join(userHome(), '.dsh', 'canvas-workbench', 'python-runtime');
  const managedCandidates = isWindows
    ? [join(runtimeRoot, 'python.exe'), join(runtimeRoot, 'Scripts', 'python.exe')]
    : [join(runtimeRoot, 'bin', 'python')];
  // macOS:CLT 自带 3.9 太老 —— vtracer 的 macOS wheel 只从 cp311 起(3.9 会退到源码编译且需要 Rust,
  // 普通用户机器必败)。Homebrew 的 3.12/3.13/3.11 依赖 wheel 覆盖最全,优先于 PATH 里的系统 python。
  const brewCandidates = isMac
    ? ['3.12', '3.13', '3.11', '3.14'].flatMap((v) => [
        join('/opt/homebrew/bin', 'python' + v),
        join('/usr/local/bin', 'python' + v),
      ])
    : [];
  try {
    const { access } = await import('node:fs/promises');
    for (const candidate of [...managedCandidates, ...brewCandidates]) {
      try {
        await access(candidate);
        return { executable: candidate, prefixArgs: [], managed: candidate.includes('python-runtime') };
      } catch {}
    }
  } catch {}
  const executable = await resolveFirst(ctx, isWindows ? ['python.exe', 'python', 'py.exe', 'py'] : ['python3', 'python']);
  if (!executable) throw new Error(isWindows
    ? '未检测到 Python。基础画布仍可使用；本地去背景、OCR、PSD 和转矢量需要先安装 Python 3.11。'
    : '未检测到 Python 3');
  const lower = executable.toLowerCase();
  return { executable, prefixArgs: isWindows && /(^|[\\/])py(?:\.exe)?$/.test(lower) ? ['-3'] : [], managed: false };
}

/**
 * 挑一个「自带 Pillow 等依赖」的解释器:宿主裸 Python(Homebrew/CLT/系统)没有 Pillow,
 * 而 composite_edit/prepare_mask/normalize_image 等 9 个脚本依赖 PIL 且不自建 venv。
 * 优先级:便携运行时(Windows,自带全套依赖) → 预置工具链 venv(必带 Pillow)
 * → 退化到普通 resolvePython(工具链尚未就绪时,报错信息引导等待)。
 * 自举型脚本(remove_background/ocr/vectorize/psd)传入 venv 解释器时会因依赖
 * 已可导入而直接复用当前解释器,反而省掉一次重进 venv 的开销。
 */
export async function resolvePythonWithDeps(ctx) {
  const runtimeRoot = join(userHome(), '.dsh', 'canvas-workbench');
  const venvPython = isWindows ? join('Scripts', 'python.exe') : join('bin', 'python');
  const { access } = await import('node:fs/promises');
  const candidates = [
    join(runtimeRoot, 'python-runtime', isWindows ? 'python.exe' : join('bin', 'python')),
    join(runtimeRoot, 'python-runtime', 'Scripts', 'python.exe'),
    join(runtimeRoot, 'rembg-runtime', venvPython),
    join(runtimeRoot, 'vtracer-runtime', venvPython),
    join(runtimeRoot, 'ocr-runtime', venvPython),
    join(runtimeRoot, 'psd-runtime', venvPython),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { executable: candidate, prefixArgs: [], managed: candidate.includes('python-runtime') };
    } catch {}
  }
  return resolvePython(ctx);
}

export async function pickFolder(ctx, runProcess, prompt = '选择画布项目文件夹') {
  if (isWindows) {
    const powershell = await resolveFirst(ctx, ['powershell.exe', 'powershell']);
    if (!powershell) throw new Error('未找到 Windows PowerShell，无法打开文件夹选择器');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = ' + psSingleQuote(prompt),
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Write-Output $dialog.SelectedPath; exit 0 }',
      'exit 2'
    ].join('; ');
    // 必须走 -EncodedCommand：`-Command "<脚本>" <参数>` 会把参数并进命令正文，$args[0] 恒为空
    // —— 旧写法 `$dialog.Description = $args[0]` 因而永远拿不到提示文字（对话框标题为空）。
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded], userHome());
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('已取消选择文件夹');
    return result.stdout.trim().replace(/[\\/]+$/, '');
  }
  if (isMac) {
    const osascript = await resolveFirst(ctx, ['osascript']);
    const result = await runProcess(osascript, ['-e', 'tell application "Finder" to activate', '-e', 'POSIX path of (choose folder with prompt ' + JSON.stringify(prompt) + ')'], userHome());
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('已取消选择文件夹');
    return result.stdout.trim().replace(/[\\/]+$/, '');
  }
  throw new Error('当前系统暂不支持原生文件夹选择器，请粘贴项目路径');
}

export async function openFolder(ctx, runProcess, path) {
  if (isWindows) {
    // 直接 spawn explorer 经沙箱 runner 会被静默吞掉(实机:画布有反馈但窗口不弹),
    // 改走实测可用的 PowerShell -EncodedCommand 通道,Start-Process 脱离 runner 上下文。
    const powershell = await resolveFirst(ctx, ['powershell.exe', 'powershell']);
    if (!powershell) throw new Error('未找到 Windows PowerShell');
    const script = '$p = ' + psSingleQuote(String(path)) + '; Start-Process explorer.exe -ArgumentList $p';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], userHome());
    if (result.exitCode !== 0) throw new Error('资源管理器打开失败（exit ' + result.exitCode + '）：' + String(result.stderr || '').slice(0, 120));
    return result;
  }
  if (isMac) {
    const opener = await resolveFirst(ctx, ['open']);
    return runProcess(opener, [path], path);
  }
  const opener = await resolveFirst(ctx, ['xdg-open']);
  if (!opener) throw new Error('未找到系统文件管理器');
  return runProcess(opener, [path], path);
}

export async function revealFile(ctx, runProcess, path, cwd) {
  if (isWindows) {
    // 同 openFolder:explorer 直启经 runner 静默失败,走 PowerShell 通道(/select 定位)。
    const powershell = await resolveFirst(ctx, ['powershell.exe', 'powershell']);
    if (!powershell) throw new Error('未找到 Windows PowerShell');
    const script = '$p = ' + psSingleQuote(String(path)) + '; Start-Process explorer.exe -ArgumentList ("/select,`"$p`"")';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], userHome());
    if (result.exitCode !== 0) throw new Error('资源管理器定位失败（exit ' + result.exitCode + '）：' + String(result.stderr || '').slice(0, 120));
    return result;
  }
  if (isMac) {
    const opener = await resolveFirst(ctx, ['open']);
    return runProcess(opener, ['-R', path], cwd);
  }
  return openFolder(ctx, runProcess, cwd);
}

/** PowerShell 单引号字符串转义（路径含空格/中文/单引号都安全）。 */
function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Adobe 应用映射：进程名用于判断是否已在运行，COM ProgID 用于 COM 打开与 exe 解析。 */
const ADOBE_APPS = {
  photoshop: { process: 'Photoshop', progId: 'Photoshop.Application' },
  illustrator: { process: 'Illustrator', progId: 'Illustrator.Application' }
};

/**
 * 用系统默认程序打开文件。
 * @param options.app 需要指定应用时传 'photoshop' / 'illustrator'（Adobe 路由都要求指定，
 *                    macOS 侧对应 `open -b com.adobe.<App>`）。
 * @returns 除原始 stdout/stderr/exitCode 外，额外带 `ok` 与 `error`：
 *          Windows 上不能用 exitCode 判定（DSH 的 subprocess 服务对 powershell 的退出码
 *          不可靠，实测 stdout 正确却拿到非 0/null），改以脚本打印的哨兵为准 ——
 *          与 Adobe 桥接全程用 stdout 判定的做法一致。
 */
export async function openWithSystem(ctx, runProcess, path, cwd, options = {}) {
  if (isWindows) {
    const powershell = await resolveFirst(ctx, ['powershell.exe', 'powershell']);
    if (!powershell) throw new Error('未找到 Windows PowerShell');
    const app = ADOBE_APPS[options.app] || null;
    const q = psSingleQuote;
    // Windows 有两条打开路径，实测结论，勿随意合并：
    //  a) 目标 Adobe 应用**已在运行** → 必须走 COM `Application.Open`。命令行传参由应用
    //     自己完成实例转交，实测 Illustrator 在此场景下起了一个新进程却丢掉文件参数
    //     （文档没打开、进程却在，接口还返回成功）；COM 直接作用于实例，0.4s 打开。
    //  b) 应用**未运行** → 命令行启动（ProgID → CLSID → LocalServer32 定位真实 exe，与
    //     安装路径无关，自定义安装路径如 C:\ps\... 也能找到），实测 6s 打开；此场景改走
    //     COM 反而要 26s（Activator 激活 + 冷启动），明显更慢。
    // 必须用 -EncodedCommand：`-Command "<脚本>" <参数>` 会把参数并进命令正文，$args[0]
    // 恒为空，旧写法 `Start-Process -FilePath $args[0]` 在 Windows 上必然抛
    // 「无法对参数 FilePath 执行操作，验证错误为 Null 或空」。脚本按行拼、不要用 '; ' 拼
    // if/else（单行化后 `if(){...}; else{...}` 会解析失败）。
    // 全程只用 .NET API（不调 cmdlet），避免 powershell 首次导入模块往 stderr 吐 CLIXML。
    const lines = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$file = ' + q(path),
      '$how = ""',
      '$running = $false',
      app ? 'try { $running = [System.Diagnostics.Process]::GetProcessesByName(' + q(app.process) + ').Length -gt 0 } catch { }' : '',
      app ? 'if ($running) {' : '',
      app ? 'try {' : '',
      app ? '$t = [type]::GetTypeFromProgID(' + q(app.progId) + ')' : '',
      app ? 'if ($t) {' : '',
      app ? '$a = [Activator]::CreateInstance($t)' : '',
      app ? 'if ($a) {' : '',
      app ? 'try { $d = $a.Open($file); if ($d) { $how = "com:" + [string]$d.Name } else { $how = "com-null" } } catch { $how = "com-open-error:" + $_.Exception.Message }' : '',
      app ? '} else { $how = "com-null-app" }' : '',
      app ? '} else { $how = "com-no-progid" }' : '',
      app ? '} catch { $how = "com-activate-error:" + $_.Exception.Message }' : '',
      app ? '}' : '',
      'if ($how -eq "") {',
      '$exe = ""',
      '$srv = ""',
      '$clsid = ""',
      app ? '$k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(' + q('SOFTWARE\\Classes\\' + app.progId + '\\CLSID') + '); if ($k) { $clsid = [string]$k.GetValue(""); $k.Close() }' : '',
      'if ($clsid) { $k2 = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(' + q('SOFTWARE\\Classes\\CLSID\\') + ' + $clsid + ' + q('\\LocalServer32') + '); if ($k2) { $srv = [string]$k2.GetValue(""); $k2.Close() } }',
      'if ($srv) { $exe = ($srv -replace "\\s+[/-]\\w+\\s*$", "").Trim([char]34) }',
      'try {',
      'if ($exe -ne "" -and [System.IO.File]::Exists($exe)) { $p = [System.Diagnostics.Process]::Start($exe, [char]34 + $file + [char]34); $how = "exe:" + $exe }',
      'elseif ([System.IO.File]::Exists($file)) { $p = [System.Diagnostics.Process]::Start($file); $how = "association" }',
      'else { $how = "file-missing" }',
      '} catch { $how = "error:" + $_.Exception.Message }',
      '}',
      'if ($how -eq "" -or $how -eq "file-missing" -or $how -like "error:*" -or $how -like "com-*") { [Console]::WriteLine("DSH_OPEN_ERR=" + $how) } else { [Console]::WriteLine("DSH_OPEN_OK=" + $how) }'
    ].filter((line) => line !== '');
    const script = lines.join('\r\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], cwd);
    const stdout = String(result.stdout || '');
    const ok = stdout.includes('DSH_OPEN_OK=');
    const failLine = (stdout.split('DSH_OPEN_ERR=')[1] || '').split(/\r?\n/)[0].trim();
    return { ...result, ok, error: ok ? '' : (failLine || result.stderr.trim() || '打开失败') };
  }
  if (isMac) {
    const opener = await resolveFirst(ctx, ['open']);
    const result = await runProcess(opener, [path], cwd);
    return { ...result, ok: result.exitCode === 0, error: result.exitCode === 0 ? '' : result.stderr.trim() };
  }
  const opener = await resolveFirst(ctx, ['xdg-open']);
  if (!opener) throw new Error('未找到系统打开程序');
  const result = await runProcess(opener, [path], cwd);
  return { ...result, ok: result.exitCode === 0, error: result.exitCode === 0 ? '' : result.stderr.trim() };
}

/**
 * 在 Windows 上通过 COM 让 Adobe 应用执行一个 .jsx（ExtendScript）。
 *
 * 与 Adobe 桥接的远程驱动同一机制：`-EncodedCommand`(UTF-16LE) 传 PowerShell，
 * `Application.DoJavaScriptFile()` 同步执行，结果按 stdout 判定
 * （DSH 的 subprocess 服务对 powershell 的 exitCode 不可靠，桥接同样只用 stdout）。
 *
 * ⚠️ JSX 文件必须是 **UTF-8 带 BOM**：Windows 下 ExtendScript 读文件依赖 BOM 判定编码，
 * 否则会按系统 ANSI 解码，脚本里的中文 `contents` 直接变乱码。
 * （macOS 侧走 osascript `read POSIX file … as «class utf8»`，是另一条路径，要求不同。）
 *
 * @param params.app       'photoshop' | 'illustrator'
 * @param params.jsxPath   JSX 绝对路径（UTF-8 with BOM）
 * @param params.workDir   子进程工作目录
 * @param params.timeoutMs 超时（打开大 PSD + 建图层 + 保存可能较久，默认 180s）
 * @returns { ...result, ok, error } —— ok 以脚本返回值为准
 */
export async function runAdobeJsxViaCom(ctx, runProcess, params) {
  const { app, jsxPath, workDir, timeoutMs = 180000 } = params || {};
  const entry = ADOBE_APPS[app];
  if (!entry) throw new Error('未知 Adobe 应用：' + app);
  if (!isWindows) throw new Error('COM 驱动仅在 Windows 可用');
  const powershell = await resolveFirst(ctx, ['powershell.exe', 'powershell']);
  if (!powershell) throw new Error('未找到 Windows PowerShell');
  const q = psSingleQuote;
  const lines = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$t = [type]::GetTypeFromProgID(' + q(entry.progId) + ')',
    '$a = $null',
    'if ($t) { try { $a = [Activator]::CreateInstance($t) } catch { } }',
    'if ($a -eq $null) { [Console]::WriteLine("DSH_JSX_ERR=com-activate-failed") }',
    'else { try { $r = [string]$a.DoJavaScriptFile(' + q(jsxPath) + '); [Console]::WriteLine("DSH_JSX=" + $r) } catch { [Console]::WriteLine("DSH_JSX_ERR=" + $_.Exception.Message) } }'
  ];
  const encoded = Buffer.from(lines.join('\r\n'), 'utf16le').toString('base64');
  const result = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], workDir, timeoutMs);
  const stdout = String(result.stdout || '');
  const ok = stdout.includes('DSH_JSX=');
  const errLine = (stdout.split('DSH_JSX_ERR=')[1] || '').split(/\r?\n/)[0].trim();
  return { ...result, ok, error: ok ? '' : (errLine || stdout.trim() || result.stderr.trim() || 'JSX 执行失败') };
}

/**
 * 通过 COM 关闭 Adobe 应用中「文件路径以 prefix 开头」的文档（不保存）。
 *
 * 为什么需要：Illustrator 的 ExtendScript 关不掉自己新建的文档（macOS 侧实测如此，
 * 才改用 AppleScript 关全部文档）。若不处理，生成流程留下的临时 .ai 会一直挂在 AI 里，
 * 而它的临时文件随即被删除 —— 用户会看到一个指向已删除文件的文档，不知道从哪来的。
 * 这里只关闭**指定前缀下**的文档，绝不触碰用户自己打开的文件。
 */
export async function closeAdobeDocumentsUnder(ctx, runProcess, params) {
  const { app, prefix, workDir, timeoutMs = 60000 } = params || {};
  const entry = ADOBE_APPS[app];
  if (!entry) throw new Error('未知 Adobe 应用：' + app);
  if (!isWindows) throw new Error('COM 驱动仅在 Windows 可用');
  const powershell = await resolveFirst(ctx, ['powershell.exe', 'powershell']);
  if (!powershell) return { ok: false, closed: 0, error: '未找到 Windows PowerShell' };
  const q = psSingleQuote;
  const lines = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$t = [type]::GetTypeFromProgID(' + q(entry.progId) + ')',
    '$a = $null',
    'if ($t) { try { $a = [Activator]::CreateInstance($t) } catch { } }',
    '$closed = 0',
    'if ($a) {',
    'for ($i = $a.Documents.Count; $i -ge 1; $i--) {',
    '$d = $a.Documents.Item($i)',
    '$p = ""',
    'try { $p = [string]$d.FullName.fsName } catch { }',
    'if ($p -eq "") { try { $p = [string]$d.FullName } catch { } }',
    'if ($p -ne "" -and $p.StartsWith(' + q(prefix) + ')) { try { $d.Close(2); $closed = $closed + 1 } catch { } }',
    '}',
    '}',
    '[Console]::WriteLine("DSH_CLOSE=" + $closed)'
  ];
  const encoded = Buffer.from(lines.join('\r\n'), 'utf16le').toString('base64');
  const result = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], workDir, timeoutMs);
  const stdout = String(result.stdout || '');
  const matched = stdout.match(/DSH_CLOSE=(\d+)/);
  return { ...result, ok: Boolean(matched), closed: matched ? Number(matched[1]) : 0, error: matched ? '' : (stdout.trim() || result.stderr.trim() || '关闭失败') };
}

export function platformCapabilities() {
  return {
    platform: platformName,
    windows: isWindows,
    macOS: isMac,
    nativeFolderPicker: isWindows || isMac,
    revealFile: true,
    adobeNativeTextLayers: isMac,
    adobeOpenByFileAssociation: isWindows,
    localPythonFeatures: 'requires-python'
  };
}
