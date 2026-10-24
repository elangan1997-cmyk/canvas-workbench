# Windows 初级版验收清单

请在干净的 Windows 10 或 Windows 11 用户账户中测试。

## 安装

- [ ] 先启动一次 DSH Desktop，再退出
- [ ] 解压 ZIP 后运行 `windows-installer/install.ps1`
- [ ] 安装器显示两层插件均已同步
- [ ] 重启 DSH 后设计模式和画布入口出现
- [ ] `windows-installer/health-check.ps1` 不报缺文件

## 源码安装器（v1.8.0 起，仓库根 `install-windows.cmd` / `install-windows.ps1`）

- [ ] `git clone` 仓库后双击 `install-windows.cmd`：同步 canvas-workbench（+dsh-codex）到全部 Profile、退出码 0
- [ ] 中文用户名（`%USERPROFILE%` 含中文）时安装与检查都不乱码
- [ ] DSH 运行中执行：明确报"请先退出 DSH"而不是半途失败；`-Force` 可强制
- [ ] 再次运行显示"已是最新，跳过复制"
- [ ] `install-windows.cmd -CheckOnly`：副本一致 / profile 注入 / DSH HTTP 三项检查通过
- [ ] 替换旧副本前，`.dsh\canvas-suite\plugin-backups\<时间戳>\` 里有备份

## 基础画布

- [ ] 新建项目无需手输路径
- [ ] 导入已有项目可打开 Windows 文件夹选择器
- [ ] 外部拖入一张图片只出现一张
- [ ] 连续粘贴两张图片都能出现
- [ ] 移动、缩放、删除后切换聊天再回来状态不复活
- [ ] 刷新和重启后恢复上次项目及画布内容
- [ ] 多选两张图片发送至聊天，输入框显示 2 张附件
- [ ] 点击“导出 PNG”得到可打开图片
- [ ] “打开项目文件夹”和“在文件夹中显示”调用资源管理器

## 链接文件和降级

- [ ] 拖入 PSD/AI/SVG/PDF 不让画布白屏
- [ ] 无预览转换器时显示占位预览而非永久加载
- [ ] 未安装 Python 时基础画布仍正常
- [ ] 未安装 Adobe 时点击编辑给出明确错误，画布仍正常
- [ ] 已关联 Photoshop/Illustrator 时能打开对应源文件

## 反馈材料

请附上 Windows 版本、DSH 版本、失败截图、复现步骤和日志：

```text
%USERPROFILE%\.dsh\logs\dsh-canvas-windows.log
```

## Adobe 桥接（v1.8 分支；2026-09-18 起）

在装有 Photoshop / Illustrator 的 Windows 10/11 上逐项验证（代码层已做 Windows 适配：路径分隔符自适应、
远程驱动走 PowerShell COM `-EncodedCommand`、CEP 开关注册表、提权安装走 UAC；
**以下均未实机验证过**——macOS 侧已有 4 项注入 isWindows 的单测 + `check-windows-compat.mjs` 静态检查覆盖结构正确性）：

- [ ] DSH 启动后 `~/.dsh/canvas-workbench/adobe-bridge/bridge.json` 出现且 20 秒内刷新 `updatedAt`
- [ ] DSH 启动后 `%USERPROFILE%\.dsh\canvas-workbench\adobe-bridge\scripts\` 有 7 个 .jsx（启动自动同步，无需手点）
- [ ] CEP 面板：`%APPDATA%\Adobe\CEP\extensions\com.dsh.canvasbridge\` 存在；注册表 `HKCU\Software\Adobe\CSXS.6~12` 各有 `PlayerDebugMode=1`；重启 PS ≤2024 / AI 后「窗口 → 扩展(旧版/扩展功能) → DSH 画布桥接」打开，状态灯读到 bridge.json
- [ ] 菜单脚本：画布「更多 → 🔐 安装 PS / AI 菜单面板」弹 **UAC**，确认后重启 PS/AI 可见「文件 → 脚本」DSH 项；UAC 点「否」报「已取消授权（UAC）」不崩溃
- [ ] **远程驱动（PowerShell COM，重点）**：画布「取 Ps 图层」→ PowerShell 无报错、图 3 秒内上画布；若失败看 bridge-log.jsonl，并用 `powershell -NoProfile -Command "(New-Object -ComObject Photoshop.Application).DoJavaScriptFile('<一个测试jsx>')"` 手动复现（host 侧实际走 `-EncodedCommand`，中文/空格路径不受引号转义影响）
- [ ] 画布「→Ps」→ 运行中的 PS 直接置入并归位；PSD（顶层含组）落地为前缀项、图片落地为组
- [ ] 中文项目路径：项目在含中文/空格的目录时收件/发件/置入都正常（openDocSafe 有 ASCII 副本兜底）
- [ ] 长路径：项目在 %USERPROFILE% 深层目录（总长 > 260 字符）时观察是否异常

## 1.9.58 新增拆层与后台任务（2026-10-25）

代码/模拟检查已通过；下列项目仍需 Windows 10/11 与真实 Adobe 实机验收。

- [ ] npm 更新到 canvas-workbench@1.9.58，重启 DSH 后显示设计模式与后台任务入口
- [ ] 当前聊天模型通过 canvas_workbench 批量处理中文、空格目录；完成自动建立结果画布
- [ ] 矩形照片保留完整场景与原位置，不走去背景；文字标签具有独立圆角形状图层
- [ ] PSD/AI 左、中、右对齐、多行、旋转文字实际重开位置一致，字体缺失明确提示
- [ ] AI 图像已嵌入，Photoshop/Illustrator 的文字与形状可编辑，改动后保存重开正常
- [ ] 当前聊天工作目录归档；关闭面板及重启后恢复原任务、原额度与已成功素材
- [ ] 本地临时失败自动恢复；未安装 Adobe 或 COM 失败不报告 AI 导出成功；未知图像请求不盲目重发
- [ ] 仅用抠图时走本地去背景；拆层模型请求受整批额度限制

模拟证据及限制见 docs/RELEASE-1.9.58.md。UNC和扩展长路径目前验证到规格文件传输，实际Adobe文件读写需逐项核实。
