# DSH Canvas Suite — Windows 源码安装器（install-windows.cmd 的实际逻辑）
# 与 macOS 的 sync-local-plugins.sh 同构：把权威源码同步到 DSH 运行副本 + 健康检查。
# 兼容 Windows PowerShell 5.1（Win10/11 自带）；不需要管理员权限。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1              # 安装/更新 + 检查
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -CheckOnly   # 只检查，不改文件
#   双击 install-windows.cmd 等效第一种。
#
# 本文件必须保持 UTF-8 **带 BOM**：PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 读取，中文会乱码
# （check-windows-compat.mjs 会校验 BOM）。

param(
  [switch]$CheckOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UserHome = $env:USERPROFILE
$DshRoot = Join-Path $UserHome '.dsh'
$ProfilesRoot = Join-Path $DshRoot 'profiles'
$BackupRoot = Join-Path $DshRoot 'canvas-suite\plugin-backups'

function Say([string]$text) { Write-Host $text }
function Fail([string]$text) { Write-Host "[X] $text" -ForegroundColor Red; exit 1 }

# Desktop 2.x 可把任意命名的 Profile 设为活动 Profile；同步范围与 macOS 脚本一致：
# 全局 node_modules、desktop、web，外加活动 Profile（若不是 desktop/web）。
function Get-ActiveProfile {
  $statePath = Join-Path $env:APPDATA 'DSH Desktop\profile-selection\state.json'
  if (-not (Test-Path -LiteralPath $statePath)) { return '' }
  try {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.active) { return [string]$state.active }
  } catch {}
  return ''
}

function Get-Destinations([string]$packageName) {
  # 返回 @{ name = 路径 }，name 用于备份目录命名
  $list = [ordered]@{
    'root'     = Join-Path $ProfilesRoot "node_modules\@local\$packageName"
    'desktop'  = Join-Path $ProfilesRoot "desktop\node_modules\@local\$packageName"
    'web'      = Join-Path $ProfilesRoot "web\node_modules\@local\$packageName"
  }
  $active = Get-ActiveProfile
  if ($active -and $active -ne 'desktop' -and $active -ne 'web') {
    $list[$active] = Join-Path $ProfilesRoot "$active\node_modules\@local\$packageName"
  }
  return $list
}

function Test-SourceComplete([string]$source) {
  foreach ($file in @('package.json', 'lib\client.js', 'lib\index.js', 'lib\image-engine.js', 'lib\chat-image-router.js', 'lib\platform.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file))) { Fail "源码缺少文件：$file（源码目录：$source）" }
  }
  return $true
}

function Copy-Tree([string]$source, [string]$destination) {
  # 先整树复制到同级临时目录再原子替换：DSH 若恰好启动，不会读到“只复制一半”的插件
  $parent = Split-Path -Parent $destination
  $stage = Join-Path $parent ('.' + (Split-Path -Leaf $destination) + '.stage')
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $stage -Recurse -Force
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
  Move-Item -LiteralPath $stage -Destination $destination
}

function Backup-Destination([string]$destination, [string]$slotName) {
  if (-not (Test-Path -LiteralPath $destination)) { return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $target = Join-Path $BackupRoot "$stamp\$slotName"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -LiteralPath $destination -Destination $target -Recurse -Force
}

function Get-TreeMap([string]$root) {
  # 相对路径 → SHA-256 的有序表；用于“已是最新则跳过”与 CheckOnly 一致性校验
  $map = @{}
  if (-not (Test-Path -LiteralPath $root)) { return $map }
  Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
    $rel = [System.IO.Path]::GetFullPath($_.FullName).Substring([System.IO.Path]::GetFullPath($root).Length + 1)
    $map[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
  return $map
}

function Test-TreesEqual([string]$source, [string]$destination) {
  $a = Get-TreeMap $source
  $b = Get-TreeMap $destination
  if ($a.Count -ne $b.Count) { return $false }
  foreach ($key in $a.Keys) {
    if (-not $b.Contains($key)) { return $false }
    if ($a[$key] -ne $b[$key]) { return $false }
  }
  return $true
}

# 与 macOS ensure_patch_entry 同语义：只在缺失时插入，兼容 [] / 已有条目 / 带各种引号的 name。
function Ensure-PatchEntry([string]$patchPath, [string]$packageId, [string]$packageName) {
  if (-not (Test-Path -LiteralPath $patchPath)) { return }
  $raw = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
  $already = ($raw -match [regex]::Escape("name: '$packageName'")) -or ($raw -match [regex]::Escape("name: ""$packageName""")) -or ($raw -match [regex]::Escape("name: $packageName"))
  if ($already) { return }
  $entry = "- insert:`r`n    - id: $packageId`r`n      name: '$packageName'"
  if ($raw -match '(?m)^[ \t]*\[\][ \t\r]*$') {
    # scriptblock 替换：$entry 里的字符不做正则替换语义处理
    $updated = [regex]::Replace($raw, '(?m)^[ \t]*\[\][ \t\r]*$', { param($m) $entry }, 1)
  } else {
    $updated = $raw.TrimEnd("`r", "`n") + "`r`n$entry`r`n"
  }
  [System.IO.File]::WriteAllText($patchPath, $updated, (New-Object System.Text.UTF8Encoding($true)))
  Say "已补入 profile：$packageName -> $patchPath"
}

function Test-PatchEntry([string]$patchPath, [string]$packageName) {
  if (-not (Test-Path -LiteralPath $patchPath)) { return $false }
  $raw = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
  return ($raw -match [regex]::Escape("name: '$packageName'")) -or ($raw -match [regex]::Escape("name: ""$packageName""")) -or ($raw -match [regex]::Escape("name: $packageName"))
}

function Get-ProfileList {
  $profiles = @('web', 'desktop')
  $active = Get-ActiveProfile
  if ($active -and $profiles -notcontains $active) { $profiles += $active }
  return $profiles
}

# ---------------- 主流程 ----------------

Say "== DSH Canvas Suite Windows 安装器（源码方式） =="
if (-not (Test-Path -LiteralPath $ProfilesRoot)) {
  Fail "未找到 DSH profiles 目录：$ProfilesRoot。请先安装 DSH Desktop 并启动一次，再运行本脚本。"
}

$canvasSource = Join-Path $ScriptDir 'canvas-workbench'
Test-SourceComplete $canvasSource | Out-Null

# Windows 上 DSH 运行中会锁住 node_modules；默认要求先退出（README 步骤也这么写）
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running -and -not $CheckOnly -and -not $Force) {
  Fail "DSH Desktop 正在运行，会锁住插件文件。请完全退出 DSH（含托盘）后重试，或加 -Force 强制。"
}

if (-not $CheckOnly) {
  # 1) 同步 canvas-workbench 到各运行副本（有变化才替换，替换前备份）
  $destinations = Get-Destinations 'canvas-workbench'
  foreach ($slot in $destinations.Keys) {
    $destination = $destinations[$slot]
    # desktop：仅当该 profile 目录真实存在时才同步 —— 否则会凭空制造一个 DSH 无法识别的
    # 残缺 profile（只有 node_modules，缺 cordis.patch.yml 等结构文件）。
    if ($slot -eq 'desktop' -and -not (Test-Path -LiteralPath (Join-Path $ProfilesRoot 'desktop'))) {
      Say "跳过 desktop 副本（本机没有 desktop profile）"
      continue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    if (Test-Path -LiteralPath $destination) {
      if (Test-TreesEqual $canvasSource $destination) {
        Say "已是最新，跳过复制：$destination"
        continue
      }
      Backup-Destination $destination $slot
    }
    Copy-Tree $canvasSource $destination
    Say "已同步 canvas-workbench -> $destination"
  }

  # 2) dsh-codex 兼容组件（仓库里存在才处理；与 macOS 脚本同构）
  # 注意：目标已存在的机器上**不注入 profile**——它的 insert 指向的副本若被跳过安装，
  # cordis 会在启动时因找不到包而崩（实测 2026-09-19：启动即弹 "failed to start"）。
  $codexSource = Join-Path $ScriptDir 'dsh-codex'
  $codexInstalled = $false
  if (Test-Path -LiteralPath (Join-Path $codexSource 'package.json')) {
    $codexTargets = [ordered]@{ 'root' = Join-Path $ProfilesRoot 'node_modules\dsh-codex' }
    $active = Get-ActiveProfile
    if ($active) { $codexTargets[$active] = Join-Path $ProfilesRoot "$active\node_modules\dsh-codex" }
    foreach ($slot in $codexTargets.Keys) {
      $codexTarget = $codexTargets[$slot]
      if (Test-Path -LiteralPath $codexTarget) {
        # 目标已存在就跳过：dsh-codex 的运行时链接（resources\app\runtime\plugins\dsh-codex）
        # 由 DSH 自己管理，安装器用源码覆盖会破坏链接对应关系 —— 实测（2026-09-19）会导致
        # DSH 启动即崩：EEXIST symlink 'runtime\plugins\dsh-codex' -> profiles\node_modules\dsh-codex。
        # 只在目标不存在（全新机器）时安装；如需重装请先手动移除目标目录再重跑本脚本。
        Say "dsh-codex 已存在，跳过（避免破坏 DSH 运行时链接）：$codexTarget"
        continue
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $codexTarget) | Out-Null
      Copy-Tree $codexSource $codexTarget
      $codexInstalled = $true
      Say "已同步 dsh-codex -> $codexTarget"
    }
  }

  # 3) profile 注入（cordis.patch.yml）
  foreach ($profile in (Get-ProfileList)) {
    Ensure-PatchEntry (Join-Path $ProfilesRoot "$profile\cordis.patch.yml") 'canvas-workbench' '@local/canvas-workbench'
  }
  if ((Test-Path -LiteralPath $codexSource) -and $codexInstalled) {
    foreach ($profile in (@('web') + @(Get-ActiveProfile) | Where-Object { $_ } | Select-Object -Unique)) {
      Ensure-PatchEntry (Join-Path $ProfilesRoot "$profile\cordis.patch.yml") 'llm-openai-codex' 'dsh-codex'
    }
  }
}

# ---------------- 检查（安装与 CheckOnly 都跑） ----------------

$failures = 0

# 语法（装有 Node 才查；没有也不阻塞——DSH 加载的是打包产物）
if (Get-Command node -ErrorAction SilentlyContinue) {
  foreach ($file in @('lib\client.js', 'lib\index.js', 'lib\image-engine.js', 'lib\chat-image-router.js', 'lib\platform.js')) {
    node --check (Join-Path $canvasSource $file) 2>$null
    if ($LASTEXITCODE -ne 0) { Say "[X] 语法检查失败：$file"; $failures++ }
  }
  if ($failures -eq 0) { Say "语法通过：canvas-workbench" }
} else {
  Say "未安装 Node.js，跳过开发期语法检查（不影响 DSH 加载已打包插件）"
}

# 运行副本一致性
$destinations = Get-Destinations 'canvas-workbench'
foreach ($slot in $destinations.Keys) {
  $destination = $destinations[$slot]
    # 与同步逻辑一致：本机没有 desktop profile 时（同步被跳过）检查也跳过
    if ($slot -eq 'desktop' -and -not (Test-Path -LiteralPath (Join-Path $ProfilesRoot 'desktop'))) { continue }
  if (-not (Test-Path -LiteralPath (Join-Path $destination 'package.json'))) {
    Say "[X] 安装副本缺失：$destination"; $failures++
    continue
  }
  if (-not (Test-TreesEqual $canvasSource $destination)) {
    Say "[X] 安装副本与源码不一致：$destination"; $failures++
    continue
  }
  Say "副本一致：$destination"
}

# profile 注入
foreach ($profile in (Get-ProfileList)) {
  $patch = Join-Path $ProfilesRoot "$profile\cordis.patch.yml"
  if (Test-Path -LiteralPath $patch) {
    if (-not (Test-PatchEntry $patch '@local/canvas-workbench')) {
      Say "profile 未注入 canvas-workbench（不影响加载：全局 plugins.cordis.yml 已声明，实测 web 注入有重复注册风险）：$profile"
    } else {
      Say "profile 通过：$profile"
    }
  }
}

# DSH HTTP（401/403 = 已监听但要求授权，不算失败）
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:43120/' -TimeoutSec 3
  Say "DSH HTTP 检查通过：HTTP $($response.StatusCode)"
} catch {
  $status = 0
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 401 -or $status -eq 403) {
    Say "DSH HTTP 检查通过：HTTP $status（服务已监听并要求授权）"
  } else {
    Say "DSH HTTP 当前不可用（未启动不算失败；启动 DSH 后重跑 -CheckOnly 确认）"
  }
}

if ($failures -gt 0) { Fail "检查未通过：$failures 项" }
if ($CheckOnly) { Say "[OK] 健康检查完成" } else { Say "[OK] 同步与健康检查完成" }
exit 0
