# Canvas Workbench · 本地生图工作台

**简体中文** | [English summary](#english-summary) · 完整文档见 [GitHub README](https://github.com/elangan1997-cmyk/canvas-workbench)

> A local-first AI image workstation inside DeepSeek Harness — zero subscription, bring your own API: generate, edit, and deliver from your own machine, with layer-level Photoshop/Illustrator round-trip as the premium edge.

**开自己的 API 生图,不交订阅费**——在 DSH 里完成「生成 → 编辑 → 交付」整条链路:聊天生图**自动上画布**、画布排版、修图擦除、可编辑 PSD/AI 交付,文件全程在你自己的磁盘上。可视为**零订阅的本地 AI 设计工作台**:核心链路对齐,成本是你自己的 API 用量;再叠加两个云端产品给不了的溢价点——**PS/AI 图层级双向联动**与**可编辑文件交付**。

**最新 [`v1.9.51`](https://github.com/elangan1997-cmyk/canvas-workbench/releases/tag/v1.9.51)(文档版)**。近期看点:市场/npm **安装即全功能**(依赖自动装齐)+「检查更新」一键自升级;新版桌面原生缩略图带与文件卡片菜单均可**「加入画布」**,**任何渠道**产出的图(含换渠道重试成功)自动上画布;画布**复制即原图字节**;失败占位卡自动清除、判重字节级确认。

### 你可能在找它(Looking for one of these?)

- 「**本地生图工具 / 零订阅 AI 设计 / 不想交订阅费的 AI 设计**」→ 开自己的 API(任意 OpenAI 兼容接口,国内大模型/企业网关直连),本地零订阅
- 「**批量生图 / 抽卡 / 一次生成多张**挑图」→ 数量 ×2/×4/×8,画布占位逐张原位替换
- 「AI 生图**比例控制 / 9:16 竖版 / 16:9 / 21:9 电影感**」→ 输入区 13 档比例,生成后精确裁切
- 「DSH **聊天生成的图自动放到画布 / 自动上画布**」→ 生成中占位 → 完成原位替换,全自动
- 「**DSH / DeepSeek Harness 画布插件**、无限画布、白板、设计模式」→ 对话旁的无限设计画布
- 「DSH 里怎么**修图 / 改图 / P 图 / 去背景 / 抠图 / 擦除**」→ 画布内图片工具,选中即用
- 「**AI 生成的图片**保存到哪、怎么管理、DSH 生成图归档」→ 自动归档 + 全局找回 + 一键上画布
- 「DSH 图片**转 PSD / 导出分层 / 文字识别 / 文字重建 / 转矢量 / OCR**」→ 本地图片处理工具链
- 「DSH 和 **Photoshop / Illustrator 联动 / 图层互传 / PS 桥接**」→ Adobe 双向桥接
- 「DSH **素材库 / 素材管理 / 设计素材**」→ 带颜色标签的本机素材库
- *DSH canvas plugin · local AI design workstation · infinite canvas · image editing · background removal · PSD export · Photoshop bridge · designer workbench*

---

## 设计师能做什么

### 🖼 对话旁的无限画布
- 输入框上方一键切换**设计模式**,左侧对话、右侧画布并排工作。
- 画布基于 Excalidraw:白板级自由排版,支持多项目、快照、撤销重做。
- 画布上的内容就是本地项目文件,断电不丢,跟项目走。

### 🤖 聊天生图全自动上画布
设计模式开启时,聊天里每一次生图都会:
- **先占位**:画布立即出现"生成中"占位卡(智能擦除同款动画),批量时标注 ×N;
- **完成即替换**:每张成图**原位替换**对应占位,同一批规格完全一致;
- **任何渠道都认**:agent 换工具、换通道(包括重试成功)写出的图,同样自动归档上画布;
- **失败有兜底**:替换失败立即按视野放置;新图上画布后残留的失败占位**自动清除**,删除过的不复活;
- **绝不重复**:文件名主干疑似比对 + **md5 字节级确认**,同名新生成放行、同一张图不重复;
- **可关可调**:批量抽卡建议开启;不想要时在「更多 → 图像引擎设置」关闭,回到手动「加入画布」。

### 📐 生图比例与数量
聊天输入区、设计模式开关旁的比例芯片,点开是完整选择面板:
- **13 档比例**:1:1、3:2/2:3、4:3/3:4、16:9/9:16、21:9/9:21、2:1/1:2、5:4/4:5 + 自动档;
- **数量 ×1/×2/×4/×8**:串行逐张生成,占位与产出严格一一对应,适合抽卡;
- **两个引擎都生效**:API 引擎自动映射网关标准尺寸 + 生成后精确裁切;dsh-codex 提示词构图 + 裁切双保险;
- 聊天里发起的**编辑也认比例**;画布编辑/智能擦除始终跟随原图。

### 📥 生成图不丢、随手可用
- 聊天生成的每张图**自动归档**到项目的 `DSH聊天生成图片/会话/日期/` 目录,永远有落盘原图。
- **「加入画布」入口全覆盖**:聊天图片输出卡、新版桌面原生缩略图带、文件卡片「打开方式」菜单里都有;聊天附件图同样一键上画布。
- **复制即原图**:画布上复制图片得到**原图字节**(不是渲染截图),贴到哪里都不降质。
- 历史会话里的图按文件名全局找回,旧图引用不再裂图。

### ✏️ 画布内直接改图
选中画布上的图,不离开 DSH 完成:
- **编辑图片**:提示词改图(可框选区域,未选区域保持不变),改完原位替换;
- **智能擦除**:涂抹要擦掉的部分,原生分辨率重绘;**蒙版必然送达模型**(无 mask 参数的引擎自动烘焙选区标记),紧邻元素不误伤;
- **去背景**:一键抠图,透明背景,默认 BiRefNet-lite;
- **文字识别(OCR)**:返回结构化 JSON(文字/位置/颜色/字号/字体);
- **转矢量**:位图转 SVG 线稿;**导出 PSD**:按图层/文字分层落盘;
- 连续编辑以原图母版合成,多次蒙版不叠加、不糊图。

### ✍️ 文字重建:图片上的字变成可编辑文字
- 识别海报/包装上的文字后,用**免费商用字体**(阿里巴巴普惠体、思源黑体等)**重建为可编辑的 PSD / AI / SVG**——文字是活的,不是贴图。
- 可直接生成原生 Illustrator 文档(.ai)并自动回到画布(Windows 走 COM 驱动)。

### 🗂 素材库
- 画布右侧素材侧栏:Mac 式七色标签、多选批量、按类型/时间/尺寸/大小/名称排序。
- 画布 ↔ 素材库**双向拖拽**;素材集中存在本机,跨项目复用。

### 🔁 Photoshop / Illustrator 双向桥接
- 画布点**「取 Ps 图层」「取 Ai 对象」**:把 PS/AI 里选中的图层直接拉进画布(约 2 秒)。
- 画布选中图点**「→Ps」「→Ai」**:改完按格式归位,像素级对齐(PS 2025 / AI 2026 真机验收)。
- 传输只靠本地文件夹握手,无端口无网络,CS6→2026 通用;Windows 走 COM 自动化,同样已实机验收。

## 安装

**插件市场**(推荐):DSH 设置 → 插件 → 市场,搜索 `canvas-workbench`,点安装。

**命令行**:

```sh
dsh plugin --profile web add canvas-workbench
```

中国大陆网络:插件管理器会自动回退到 registry.npmmirror.com 镜像,无需额外配置。

1.9.42 起市场/npm 安装即全功能可用(依赖自动装齐);后续升级用画布内「更多 → 检查更新」一键完成,当天新版也能立即装。

## 图片引擎(带什么 API 都行)

画布右上角「更多 → 图像引擎设置」,两条路线自由切换,不锁定任何厂商:

| 引擎 | 适合 | 说明 |
|---|---|---|
| `API` | **任何 OpenAI 兼容图片接口** | 国内大模型 API、企业网关、自建服务直连;密钥只存本机 |
| `dsh-codex` | 已有 ChatGPT 订阅 | 与 [dsh-codex](https://www.npmjs.com/package/dsh-codex) 插件共用 OAuth 与订阅额度;未安装时自动装**与当前内核兼容的最新版**(0.2.0 正式桌面 → 0.3.2),走其代理设置,国内网络可用 |

另有**本地工具链完全不依赖任何 API**:去背景、OCR、转矢量、PSD 导出、文字重建全部在本机 Python 环境运行,断网可用、零调用成本(缺库自动自举隔离运行时)。

引擎不会静默切换,状态面板实时显示安装/登录/凭据状态;你选的引擎/比例/数量升级也不丢(覆盖前自动留备份)。

## 和云端订阅平台比?

对**核心链路——生图 → 编辑 → 交付**来说,是:

- **成本**:开你自己的 API(国内大模型/企业网关/ChatGPT 订阅均可),按用量付费,没有平台订阅;去背景/OCR/转矢量/PSD 导出/文字重建是**本地工具链,零 API 成本**;
- **数据**:画布即本地项目文件,生成图自动归档落盘,不上云;
- **独有溢价**:图层级 **Photoshop/Illustrator 双向桥接**与**可编辑 PSD/AI/SVG 交付**——云端产品架构上做不到与本机 Adobe 图层级往返。

不在当前范围的:团队云端协作、视频/动效、模板灵感生态——需要这些时配合云端平台使用(云端出概念稿,本地精修交付)。

## 系统要求

- DeepSeek Harness(DSH)**0.2.0 系正式桌面(推荐)或 0.1.7-rc 系内核**;新版会话 v4 格式、附件 API 与原生图片展示带均已适配。
- 去背景 / OCR / 转矢量 / PSD 导出 / `.ai`/`.pdf` 预览依赖本机 Python 3.11(缺失时自动自举隔离环境);完全没有 Python 时画布仍可用,仅对应本地图片处理停用。
- Adobe 桥接需已安装 Photoshop / Illustrator,**macOS 与 Windows 均已实机验收**(详见仓库 `WINDOWS-TEST-CHECKLIST.md`)。
- npm 包不含 DSH 本体、Python 运行时、模型文件、账号或 API Key。

## 数据与隐私

所有文件都在你的本地项目目录与 `~/.dsh` 下:画布即项目文件,生成图即归档原图,素材库即本机素材目录。不云同步、不上传、不进 Git。

## English summary

Canvas Workbench is a design-focused canvas plugin for DeepSeek Harness (DSH) Desktop — a local-first, zero-subscription AI image workstation with your own API. Chat-driven image generation lands on the infinite canvas automatically (animated placeholders replaced in place; images from any channel, including retried ones, are picked up too), with 13 aspect presets and ×1–×8 batch counts. On-canvas tools: prompt editing, smart erase (mask always delivered to the model), background removal (BiRefNet), OCR, vectorize, and layered PSD export; recognized text is rebuilt into editable PSD/AI/SVG with free-for-commercial fonts. A layer-level Photoshop/Illustrator bridge round-trips selected layers both ways (macOS and Windows, verified on real machines). Any OpenAI-compatible image API works; the dsh-codex engine auto-installs the version matching your DSH core. Copying a canvas image yields the original bytes. Install from the DSH plugin marketplace or `dsh plugin --profile web add canvas-workbench`; upgrade in one click via in-canvas "Check for Updates". Full documentation: [GitHub README](https://github.com/elangan1997-cmyk/canvas-workbench).

## License

MIT
