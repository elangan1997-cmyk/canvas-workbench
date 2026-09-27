# Windows 版本（推荐安装分支）

本分支 `windows-recommended` 在 v1.8.0 基础上完成了 **Windows 平台的全量兼容修复**。
**Windows 用户请安装本分支** —— `main` 分支的 Windows 支持不完整（多处功能只有 macOS 实现）。

## 与 main 的差异

### 功能修复（8 项，全部 Windows 实机验证）

| 功能 | main 分支行为 | 本分支行为 |
|---|---|---|
| 在 Photoshop/Illustrator 中打开 | 点了没反应 / 假成功 | 已运行走 COM，未运行走命令行 |
| 编辑文字（PS） | 只有栅格化像素层 | **原生可编辑文字图层** |
| 编辑文字（AI 格式） | 降级为 SVG | 原生可编辑 .ai |
| PSD 预览 | 占位图 | Pillow 真实渲染 |
| AI / PDF 预览 | 占位图 | PyMuPDF 真实渲染 |
| SVG 预览 | 背景整块丢失 | 自动内联 AI 导出的外链位图 |
| 打开失败 | 静默无提示 | 原因回传到画布反馈条 |
| Adobe 应用发现 | 只扫 Program Files | 注册表反推，支持自定义安装路径 |

### 安装器修复（3 处，装卸测试发现）

- `dsh-codex` 已存在时跳过覆盖与 profile 注入 —— 旧行为导致 **DSH 启动即崩**
  （`EEXIST symlink runtime\plugins\dsh-codex -> profiles\node_modules\dsh-codex`）
- 本机没有 desktop profile 时跳过副本同步与检查（不再制造残缺 profile）
- web profile 的 canvas-workbench 注入检查降级为提示（web `cordis.patch.yml` 保持
  空 `[]` 是正确状态，全局 plugins.cordis.yml 已声明）
- 补入 `canvas-workbench/cordis.patch.yml`（1.8.0 包内不自带，安装必需）

## 安装（Windows 10/11）

前置：已安装 [DSH Desktop](https://github.com/elangan1997-cmyk/dsh-canvas-suite) 并**至少启动过一次**；
Photoshop / Illustrator（可选，用于 Adobe 相关功能）。

```cmd
git clone -b windows-recommended https://github.com/elangan1997-cmyk/dsh-canvas-suite.git
cd dsh-canvas-suite
install-windows.cmd
```

1. **完全退出 DSH Desktop**（含托盘图标，否则会锁住插件文件）
2. 双击 `install-windows.cmd`（无需管理员权限）
3. 重新启动 DSH，打开画布即可使用

### AI / PDF 预览的 Python 依赖

安装器使用仓库自带便携 Python。AI/PDF 预览需要一次性安装 PyMuPDF（其余功能零依赖）：

```cmd
"%USERPROFILE%\.dsh\canvas-workbench\python-runtime\python.exe" -m pip install pymupdf
```

## 装卸测试记录

2026-09-19 于 Windows 实机（PowerShell 5.1 / DSH Desktop 0.1.1-rc.2 / PS 2022 / AI 2022）完成：

- **卸载**：移除三处运行副本与 web profile 注入 → 确认"未安装"状态
- **安装**：`install-windows.ps1` 全流程 → 三副本同步一致、profile 注入、语法检查
- **启动**：DSH 正常拉起，端到端验证 health / PSD·AI·SVG 预览 / Adobe 打开 / 原生文字层 —— 全部通过
- 测试过程中**发现并修复了安装器 3 处缺陷**（见上文），并把发现固化进本分支

已知说明：安装器以"实体副本"方式同步（`profiles\node_modules\@local\canvas-workbench`
等三处），程序内置副本（`resources\app\node_modules\@local\canvas-workbench`）保留不动；
DSH 升级后重跑一次 `install-windows.cmd` 即可恢复全部补丁。

## macOS 兼容性承诺（2026-09-19 逐项核对）

本分支基线是 main 的 v1.8.0（a82fa89），**所有 macOS 代码路径的行为完全不变**：

- 全部新逻辑都由 `isWindows` / `!isMac` 守卫，或位于仅 Windows 调用的函数里：
  - `openWithSystem`：mac 分支仍原样 `open -b com.adobe.*`
  - `pickFolder`：mac 仍原样 osascript `choose folder`
  - `psdPreviewPath`：mac 仍原样 `sips`
  - `documentPreviewPath`：mac 严格保持原顺序 `pdftoppm → qlmanage → 占位图`（新增的
    PyMuPDF 分支已用 `!isMac` 排除，mac 不多走一步）
  - PS/AI 原生文字层：mac 的 osascript 分支一字未改，JSX 脚本内容逐字节相同
    （仅把字符串提取为函数，纯等价重构）
  - Adobe 应用目录发现：mac 仍原样扫 `/Applications`
  - 提权 / CEP / PlayerDebugMode：mac 分支原样
- 唯一跨平台增强：SVG 预览的外链位图内联 —— **失败安全**（无外链图或处理失败时
  返回原文件，与 v1.8.0 行为一致；有外链图则 mac 上渲染同样更正确）
- 测试归因：新旧代码（a82fa89 vs 本分支）跑 unit 测试的失败集合完全一致
  （3 例为 macOS 上编写的测试在 Windows 环境的天然失败，如 chmod 0o555 模拟只读），
  **新代码引入零测试回归**
- 安装器修复仅涉及 `install-windows.ps1`（mac 使用 mac-installer，不受影响）

**结论：macOS 可以继续用 main 的 1.8.0，也可以直接用本分支 —— 行为完全一致，
本分支额外获得 Windows 的全部修复。**
