# Canvas Workbench · 本地生图工作台

> A local-first AI image workstation inside DeepSeek Harness — an affordable, bring-your-own-API alternative to cloud design agents like Lovart: generate, edit, and deliver from your own machine, with layer-level Photoshop/Illustrator round-trip as the premium edge.

**开自己的 API 生图,不交订阅费**——在 DSH 里完成「生成 → 编辑 → 交付」整条链路:聊天生图、画布排版、修图擦除、可编辑 PSD/AI 交付,文件全程在你自己的磁盘上。可视为**本地版的 Lovart 平价平替**:核心链路对齐,成本是你自己的 API 用量;再叠加两个云端产品给不了的溢价点——**PS/AI 图层级双向联动**与**可编辑文件交付**。

### 你可能在找它(Looking for one of these?)

- 「**本地生图工具 / Lovart 平替 / 不想交订阅费的 AI 设计**」→ 开自己的 API(任意 OpenAI 兼容接口,国内大模型/企业网关直连),本地零订阅
- 「**DSH / DeepSeek Harness 画布插件**、无限画布、白板、设计模式」→ 对话旁的无限设计画布
- 「DSH 里怎么**修图 / 改图 / P 图 / 去背景 / 抠图 / 擦除**」→ 画布内图片工具,选中即用
- 「**AI 生成的图片**保存到哪、怎么管理、DSH 生成图归档」→ 自动归档 + 全局找回 + 一键上画布
- 「DSH 图片**转 PSD / 导出分层 / 文字识别 / 文字重建 / 转矢量 / OCR**」→ 本地图片处理工具链
- 「DSH 和 **Photoshop / Illustrator 联动 / 图层互传 / PS 桥接**」→ Adobe 双向桥接
- 「DSH **素材库 / 素材管理 / 设计素材**」→ 带颜色标签的本机素材库
- 「不想开 ChatGPT 订阅,**用自己的图片 API / 国内大模型 API / 企业网关**做设计」→ 任意 OpenAI 兼容接口直连
- *DSH canvas plugin · local Lovart alternative · infinite canvas · image editing · background removal · PSD export · Photoshop bridge · designer workbench*

---

## 设计师能做什么

### 🖼 对话旁的无限画布
- 输入框上方一键切换**设计模式**,左侧对话、右侧画布并排工作。
- 画布基于 Excalidraw:白板级自由排版,支持多项目、快照、撤销重做。
- 画布上的内容就是本地项目文件,断电不丢,跟项目走。

### 📥 生成图不丢、随手可用
- 聊天生成的每张图**自动归档**到项目的 `DSH聊天生成图片/会话/日期/` 目录,永远有落盘原图。
- 图片卡片上点一下**「加入画布」**,即刻进入排版。
- 历史会话里的图按文件名全局找回,旧图引用不再裂图。

### ✏️ 画布内直接改图
选中画布上的图,不离开 DSH 完成:
- **编辑图片**:提示词改图,改完原位替换。
- **智能擦除**:涂抹要擦掉的部分,按选区原生分辨率重绘,边缘色调匹配,无补丁感。
- **去背景**:一键抠图。
- **文字识别(OCR)**:识别图里的文字内容与位置。
- **转矢量**:位图转 SVG 线稿,印刷与放大可用。
- **导出 PSD**:按图层/文字分层的 PSD 落盘。

### ✍️ 文字重建:图片上的字变成可编辑文字
- 识别海报/包装上的文字后,用**免费商用字体**(阿里巴巴普惠体、思源黑体等)**重建为可编辑的 PSD / AI / SVG**——文字是活的,不是贴图。
- 可直接生成原生 Illustrator 文档(.ai)并自动回到画布。

### 🗂 素材库
- 画布右侧素材侧栏:Mac 式七色标签、多选批量、按类型/时间/尺寸/大小/名称排序。
- 画布 ↔ 素材库**双向拖拽**;素材集中存在本机,跨项目复用。

### 🔁 Photoshop / Illustrator 双向桥接
- 画布点**「取 Ps 图层」「取 Ai 对象」**:把 PS/AI 里选中的图层直接拉进画布(约 2 秒)。
- 画布选中图点**「→Ps」「→Ai」**:改完按格式归位——PSD 并图层进当前文档、AI/SVG 按对象并入,像素级归位(PS 2025 / AI 2026 真机验收)。
- 传输只靠本地文件夹握手,无端口无网络,CS6→2026 通用。

## 安装

**插件市场**(推荐):DSH 设置 → 插件 → 市场,搜索 `canvas-workbench`,点安装。

**命令行**:

```sh
dsh plugin --profile web add canvas-workbench
```

中国大陆网络:插件管理器会自动回退到 registry.npmmirror.com 镜像,无需额外配置。

## 图片引擎(带什么 API 都行)

画布右上角「更多 → 图像引擎设置」,两条路线自由切换,不锁定任何厂商:

| 引擎 | 适合 | 说明 |
|---|---|---|
| `API`(推荐起点) | **任何 OpenAI 兼容图片接口** | 国内大模型 API、企业网关、自建服务均可直连——不需要 ChatGPT 订阅,不用科学上网;密钥只存本机 |
| `dsh-codex` | 已有 ChatGPT 订阅 | 与 [dsh-codex](https://www.npmjs.com/package/dsh-codex) 插件共用 OAuth 与订阅额度,聊天生图同一路由 |

另有**本地工具链完全不依赖任何 API**:去背景、OCR、转矢量、PSD 导出、文字重建全部在本机 Python 环境运行,断网可用、零调用成本。

引擎不会静默切换,状态面板实时显示安装/登录/凭据状态。

## 是 Lovart 的平价平替吗?

对**核心链路——生图 → 编辑 → 交付**来说,是:

- **成本**:开你自己的 API(国内大模型/企业网关/ChatGPT 订阅均可),按用量付费,没有平台订阅;去背景/OCR/转矢量/PSD 导出/文字重建是**本地工具链,零 API 成本**;
- **数据**:画布即本地项目文件,生成图自动归档落盘,不上云;
- **独有溢价**:图层级 **Photoshop/Illustrator 双向桥接**与**可编辑 PSD/AI/SVG 交付**——云端产品架构上做不到与本机 Adobe 图层级往返。

不在当前范围的:团队云端协作、视频/动效、模板灵感生态——需要这些时配合云端平台使用(云端出概念稿,本地精修交付)。

## 系统要求

- DeepSeek Harness(DSH),内核 0.1.0-rc.7 及以上,0.1.7-rc 系最佳。
- 去背景 / OCR / 转矢量 / PSD 导出依赖本机 Python 3.11;缺 Python 时画布仍可用,仅对应本地图片处理停用。
- Adobe 桥接需已安装 Photoshop / Illustrator(macOS 完整支持;Windows 远程驱动已适配,实机验证进行中,详见仓库 `WINDOWS-TEST-CHECKLIST.md`)。
- npm 包不含 DSH 本体、Python 运行时、模型文件、账号或 API Key。

## 数据与隐私

所有文件都在你的本地项目目录与 `~/.dsh` 下:画布即项目文件,生成图即归档原图,素材库即本机素材目录。不云同步、不上传、不进 Git。

## License

MIT
