# DSH 画布工作台 · Canvas Workbench

> A local-first AI image workstation inside DeepSeek Harness — an affordable, bring-your-own-API alternative to cloud design agents like Lovart: generate, edit, and deliver from your own machine, with layer-level Photoshop/Illustrator round-trip as the premium edge.

**开自己的 API 生图,不交订阅费**——在 DSH 里完成「生成 → 编辑 → 交付」整条链路:聊天生图**自动上画布**、画布排版、修图擦除、可编辑 PSD/AI 交付,文件全程在你自己的磁盘上。可视为**本地版的 Lovart 平价平替**:核心链路对齐,成本是你自己的 API 用量;再叠加两个云端产品给不了的溢价点——**PS/AI 图层级双向联动**与**可编辑文件交付**。

**最新版本 [`v1.9.0`](https://github.com/elangan1997-cmyk/dsh-canvas-suite/releases/tag/v1.9.0)**:聊天生图全自动上画布(生成中占位 → 原位替换)、输入区生图**比例 13 档 + 数量 ×1~×8**、两引擎统一生效、新版官方桌面全面适配、Windows 推荐分支全量并入。

---

## 你可能在找它(Looking for one of these?)

- 「**本地生图工具 / Lovart 平替 / 不想交订阅费的 AI 设计**」→ 开自己的 API(任意 OpenAI 兼容接口,国内大模型/企业网关直连),本地零订阅
- 「**批量生图 / 抽卡 / 一次生成多张**挑图」→ 数量 ×2/×4/×8,画布占位逐张替换,同规格排列
- 「AI 生图**比例控制 / 9:16 竖版 / 16:9 / 21:9 电影感**」→ 输入区 13 档比例卡片,生成后精确裁切
- 「**DSH / DeepSeek Harness 画布插件**、无限画布、白板、设计模式」→ 对话旁的无限设计画布
- 「DSH 里怎么**修图 / 改图 / P 图 / 去背景 / 抠图 / 擦除**」→ 画布内图片工具,选中即用
- 「**AI 生成的图片**保存到哪、怎么管理、自动上画布」→ 自动归档 + 全局找回 + 自动/一键上画布
- 「DSH 图片**转 PSD / 导出分层 / 文字识别 / 文字重建 / 转矢量 / OCR**」→ 本地图片处理工具链
- 「DSH 和 **Photoshop / Illustrator 联动 / 图层互传 / PS 桥接**」→ Adobe 双向桥接
- 「DSH **素材库 / 素材管理 / 设计素材**」→ 带颜色标签的本机素材库
- 「不想开 ChatGPT 订阅,**用自己的图片 API / 国内大模型 API / 企业网关**做设计」→ 任意 OpenAI 兼容接口直连
- *DSH canvas plugin · local Lovart alternative · infinite canvas · auto image placement · batch generation · image editing · background removal · PSD export · Photoshop bridge · designer workbench*

---

## 30 秒看懂

1. DSH 聊天框上方点开**设计模式**,右侧出现无限画布;
2. 输入区选好**比例**(比如 9:16)和**数量**(比如 ×4),直接在聊天里说"生成一张……";
3. 画布上先出现 ×4 个**生成中占位**(和智能擦除同款动画),每张生成完**原位替换**成图;
4. 原图同步归档到项目 `DSH聊天生成图片/会话/日期/`,永不丢;
5. 选中图直接**改图/擦除/去背景/重建文字**,需要精修就**一键送进 PS/AI**,改完**像素级归位**。

---

## 设计师能做什么

### 🖼 对话旁的无限画布
- 输入框上方一键切换**设计模式**,左侧对话、右侧画布并排工作,分栏宽度可拖动。
- 画布基于 Excalidraw:白板级自由排版——拖入、粘贴、多选、对齐、复制、撤销重做、PNG 导出;`Alt + 滚轮`缩放贴合 PS 习惯。
- 画布内容就是本地项目文件(项目内 `canvas.json` 快照),断电不丢,跟项目走;删除画布元素不影响聊天原图。
- 未绑定画布的聊天会生成图时,输入区横幅询问「选择已有项目 / 新建画布 / 本次手动加入」,绑定后自动补上。

### 🤖 聊天生图全自动上画布(1.9.0)
设计模式开启时,聊天里每一次生图都会:
- **先占位**:画布立即出现"生成中"占位卡(智能擦除同款动画,跟随系统深浅主题),批量时标注 ×N;
- **完成即替换**:每张成图**原位替换**对应占位,同一批生成的图尺寸规格完全一致(240 盒装),不会一大一小;
- **失败有兜底**:占位替换万一失败(比如你手动删了占位),成图立即按当前视野放置并提示,不会"生成了却找不到";
- **可关可调**:不想要自动上画布时在「更多 → 图像引擎设置」关闭,回到卡片上手动「加入画布」;批量抽卡场景建议保持开启。

### 📐 生图比例与数量(1.9.0)
聊天输入区、设计模式开关旁的比例芯片,点开是完整选择面板:
- **13 档比例**:1:1、3:2/2:3、4:3/3:4、16:9/9:16、21:9/9:21(电影感)、2:1/1:2(banner/长图)、5:4/4:5(摄影/打印)+ 自动档;
- **数量 ×1/×2/×4/×8**:串行逐张生成,占位与产出严格一一对应,适合抽卡;
- **两个引擎都生效**:API 引擎请求自动映射到网关标准尺寸、生成后精确裁到所选比例;dsh-codex 引擎在提示词注入构图要求 + 生成后裁切双保险;
- **编辑也认比例**:聊天里发起的改图,只要显式选了比例就按所选比例出图;画布上的编辑和智能擦除始终跟随原图,不会被意外裁切。

### 📥 生成图不丢、随手可用
- 聊天生成的每张图**自动归档**到 `DSH聊天生成图片/<会话标题>/<日期>/<时段>/`,文件夹名跟随会话标题自动同步;
- 聊天里的**图片输出卡**逐轮聚合,支持「加入画布」「在文件夹中显示」;
- 历史会话里的图按文件名全局找回,旧图引用不再裂图。

### ✏️ 画布内直接改图
选中画布上的图,不离开 DSH 完成:
- **编辑图片**:提示词改图,可框选区域(未选区域自动作为"保持不变"约束),改完原位替换;
- **智能擦除**:涂抹要擦掉的部分,按选区原生分辨率重绘,边缘色调匹配,无补丁感;
- **去背景**:一键抠图,透明背景,选区自动扩展羽化;
- **文字识别(OCR)**:整图+选区框交给视觉模型,返回结构化 JSON(文字/位置/颜色/字号/字体/置信度);
- **转矢量**:位图转 SVG 线稿,印刷与放大可用;
- **导出 PSD**:按图层/文字分层的 PSD 落盘;
- 连续编辑以**原图母版**合成,多次蒙版不叠加、不糊图。

### ✍️ 文字重建:图片上的字变成可编辑文字
- 识别海报/包装上的文字后,用**免费商用字体**(阿里巴巴普惠体 3.0、思源黑体 SC、Inter 等)**重建为可编辑的 PSD / AI / SVG**——文字是活的,不是贴图;
- 可直接生成**原生 Illustrator 文档(.ai)** 并自动回到画布(Windows 同样支持,走 COM 驱动);
- PSD 输出含背景修复层 + 可编辑文字层,位置/字号/颜色按原图坐标换算。

### 🗂 素材库
- 画布右侧素材侧栏:**Mac 式七色标签**、多选批量标记、按颜色/类型/时间/尺寸/大小/名称排序筛选;
- 画布 ↔ 素材库**双向拖拽**;素材集中存在本机,跨项目复用;
- 项目文件夹里的新文件(PS/AI 另存、访达拷入)**实时刷新**自动上画布。

### 🔁 Photoshop / Illustrator 双向桥接
- 画布点**「取 Ps 图层」「取 Ai 对象」**:把 PS/AI 里选中的图层直接拉进画布(约 2 秒,PS 逐层裁到图层边界并记住坐标);
- 画布选中图点**「→Ps」「→Ai」**:改完按格式归位——PSD 并图层进当前文档、AI/SVG 按对象并入,**像素级归位**(PS 2025 / AI 2026 真机验收);
- 传输只靠本地文件夹握手,无端口无网络,CS6→2026 通用;
- Windows 同样支持:远程驱动走 COM 自动化,自定义安装路径(如 `C:\ps\`)也能从注册表定位;
- PS 2025+ 无旧扩展面板?画布按钮和「文件 → 脚本」一键脚本都可用。协议与排障见 [`canvas-workbench/adobe-bridge/PROTOCOL.md`](canvas-workbench/adobe-bridge/PROTOCOL.md)。

### 🧾 操作日志
「更多 → 操作日志」记录项目加载、文件刷新、图片落盘、模型请求、响应解析、预览转换、PSD 生成和失败原因。反馈问题时复制日志步骤即可,不含账号与 Key。

---

## 安装

### 方式一:插件市场 / npm(推荐,已装 DSH 的机器)

DSH 设置 → 插件 → 市场,搜索 `canvas-workbench`,点安装;或命令行:

```sh
dsh plugin --profile web add canvas-workbench
```

中国大陆网络会自动回退 registry.npmmirror.com 镜像,无需额外配置。

### 方式二:源码同步(要最新 main / 参与开发)

**macOS:**

```bash
git clone https://github.com/elangan1997-cmyk/dsh-canvas-suite.git
cd dsh-canvas-suite
./sync-local-plugins.sh     # 同步插件到本机全部 DSH Profile 并做健康检查
```

**Windows(PowerShell 或双击 `install-windows.cmd`):**

```powershell
git clone https://github.com/elangan1997-cmyk/dsh-canvas-suite.git
cd dsh-canvas-suite
.\install-windows.cmd            # 同步 + 健康检查(先完全退出 DSH)
.\install-windows.cmd -CheckOnly # 只检查不改文件
```

安装后完全退出并重启 DSH Desktop 生效。

### 方式三:完整安装包(新电脑 / 没有 DSH)

| 情况 | 推荐 |
|---|---|
| macOS 新电脑 | [`v1.5.9` Release](https://github.com/elangan1997-cmyk/dsh-canvas-suite/releases/tag/v1.5.9) 的 `macOS-Complete` DMG/PKG(整机重装验收基线),装好后按方式一/二升级画布到 1.9.0 |
| Windows 新电脑 | 源码安装(方式二,全量 Win 兼容修复已并入 main);或已实机验证的 `v1.4.0-windows-preview.4` 整包后升级 |

npm 包与源码包都不含 DSH 本体、Python 运行时、模型文件、账号或 API Key。

---

## 图片引擎(带什么 API 都行)

画布右上角「更多 → 图像引擎设置」,两条路线自由切换,不锁定任何厂商:

| 引擎 | 适合 | 说明 |
|---|---|---|
| `API`(推荐起点) | **任何 OpenAI 兼容图片接口** | 国内大模型 API、企业网关、自建服务均可直连——不需要 ChatGPT 订阅;密钥只存本机(0600) |
| `dsh-codex` | 已有 ChatGPT 订阅 | 与 [dsh-codex](https://www.npmjs.com/package/dsh-codex) 插件共用 OAuth 与订阅额度 |

比例与数量对两个引擎**统一生效**。另有**本地工具链完全不依赖任何 API**:去背景、OCR、转矢量、PSD 导出、文字重建全部在本机 Python 环境运行,断网可用、零调用成本。引擎不会静默切换,状态面板实时显示安装/登录/凭据状态。

---

## 是 Lovart 的平价平替吗?

对**核心链路——生图 → 编辑 → 交付**来说,是:

| 维度 | 云端设计 Agent | DSH 画布工作台 |
|---|---|---|
| 成本 | 平台订阅 + 按量 | 自带 API 按用量;本地工具链零 API 成本 |
| 数据 | 云端会话 | 本地项目文件 + 自动归档,不上云 |
| 交付 | 多为扁平图 | **可编辑 PSD/AI/SVG** |
| 联动 | 无 | **PS/AI 图层级双向往返** |
| 追责复现 | 黑盒 | 项目路径/模型路由/失败步骤本机可查 |
| 隐私 | 上传 | 凭据与内容留在本机,仅调用所选模型时发送必要请求 |

不在当前范围的:团队云端协作、视频/动效、模板灵感生态——需要这些时配合云端平台使用(云端出概念稿,本地精修交付)。

---

## 推荐的设计工作流

1. **抽卡**:设计模式开 → 比例选 9:16、数量 ×4 → 聊天里描述方向 → 画布 4 个占位逐张替换 → 圈选满意的;
2. **整理**:无限画布排列多版本,素材库七色标签分类,文件夹新素材实时刷新上画布;
3. **局部修改**:选中调整区域 → 编辑/智能擦除/去背景,未选区域保持原样;
4. **文字重建**:框选文字 → 视觉模型返回 JSON → 确认后输出背景图 + 可编辑 PSD/AI 文字层;
5. **精修交付**:「→Ps」「→Ai」送进 Adobe 细化,改完归位;原图、修复背景、分层文件与操作日志全程保留。

---

## 系统要求

- DeepSeek Harness(DSH),内核 0.1.0-rc.7 及以上,0.1.7-rc 系 / 官方桌面版最佳(1.9.0 已适配新版桌面的会话 v4 格式与附件 API)。
- 去背景 / OCR / 转矢量 / PSD 导出 / Windows 真实预览(PyMuPDF/psd-tools)依赖本机 Python 3.11;缺 Python 时画布仍可用,仅对应本地图片处理停用。
- Adobe 桥接需已安装 Photoshop / Illustrator(macOS 与 Windows 均支持,真机验收见 [WINDOWS-TEST-CHECKLIST](WINDOWS-TEST-CHECKLIST.md))。

## 数据与隐私

所有文件都在你的本地项目目录与 `~/.dsh` 下:画布即项目文件,生成图即归档原图,素材库即本机素材目录。不云同步、不上传、不进 Git。发布包不含开发者账号、OAuth Token、API Key;API 凭据只从使用者自己的本机读取。

---

## 文档与支持

- [Windows 完整安装说明](windows-installer/INSTALL-WINDOWS.md) · [Windows 独立插件](docs/DSH-CANVAS-WORKBENCH-WINDOWS.md) · [macOS 独立插件](docs/DSH-CANVAS-WORKBENCH-MACOS.md)
- [发布、校验和版本策略](docs/RELEASE-DISTRIBUTION.md) · [npm 分发](docs/NPM-DISTRIBUTION.md) · [Windows 验收清单](WINDOWS-TEST-CHECKLIST.md) · [Windows 推荐分支说明](WINDOWS-RECOMMENDED.md)
- [Adobe 桥接协议](canvas-workbench/adobe-bridge/PROTOCOL.md) · [变更记录](CHANGELOG.md)

**常见问题速查**

| 症状 | 处理 |
|---|---|
| 安装后仍是旧版本 | 完全退出 DSH(含托盘)重跑安装脚本,再 `-CheckOnly` 检查 |
| API 连不上/超时 | 「图像引擎设置」核对路由、地址、超时;操作日志里有精确失败阶段 |
| PDF/AI 无预览 | 文件仍可上画布;装 Poppler 或用 Illustrator 打开(macOS);Windows 已内置 PyMuPDF 预览 |
| 生成图比例偶尔不符 | 1.9.0 已做网关映射+裁切双保险;若仍遇到请附操作日志反馈 |

**报告问题**请附:操作步骤、系统版本、插件版本、操作日志失败步骤、Codex 或 API 路由。请勿粘贴 API Key、OAuth Token 或个人项目文件。

## 目录结构

```text
canvas-workbench/          画布插件源码(客户端分段源码 + 宿主服务 + Provider)
canvas-workbench/scripts/  构建/检查/打包脚本 + Python 图片工具链
install-canvas-plugin.sh   macOS 独立插件同步入口
install-windows.ps1/.cmd   Windows 源码安装器 + 健康检查
windows-installer/         Windows 完整安装器
docs/                      安装与发布说明
```

## 开发

```bash
cd canvas-workbench
npm install
npm run build    # 分段源码拼接 lib/client.js
npm run check    # 语法/构建漂移/vendor 补丁/Windows 兼容守卫
npm test         # node --test 单元测试
npm run package:npm  # 生成 dist-npm/canvas-workbench 发布变体
```

## License

MIT

---

# DSH Canvas Workbench (English)

A design-focused canvas plugin for DeepSeek Harness (DSH) Desktop. It brings chat-driven image generation (auto-placed onto the canvas with in-place placeholder replacement), aspect-ratio & batch-count controls (13 presets, ×1–×8), an infinite canvas with project persistence, in-canvas image editing / smart erase / background removal / OCR / vectorize / layered PSD export, and a layer-level Photoshop/Illustrator round-trip bridge — all local-first, bring-your-own-API. Latest: [v1.9.0](https://github.com/elangan1997-cmyk/dsh-canvas-suite/releases/tag/v1.9.0). Install via `dsh plugin add canvas-workbench` (npmmirror fallback for mainland China) or from source (`./sync-local-plugins.sh` on macOS, `install-windows.cmd` on Windows). MIT licensed.
