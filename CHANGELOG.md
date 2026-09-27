# Changelog

## 1.9.2

- **修复自动上画布出现两张重复图**:宿主的完成记录是环形列表、每轮轮询都会重放,占位替换路径此前未登记去重,第二轮轮询走了兜底"普通加入"导致同图两次入画。现在同一路径无论占位替换还是兜底加入都只处理一次(上限 500 条防无界)。
- **修复画布冷启动窗口丢占位**:生成开始时若画布 iframe 尚未就绪(大项目快照加载中),占位创建此前被直接丢弃;现在 iframe 回报 deferred,客户端下一轮轮询自动重建,占位不再因撞上冷启动而消失。

## 1.9.1

- **修复聊天生图整轮报错(v4 会话格式不兼容)**:设计模式下调 imagegen 后,注入的上下文消息仍用 v3 旧写法 `source:{kind:'plugin',plugin:'canvas-workbench'}`,被会话格式 v4 的 producer-owned 校验整轮拒收(「本轮运行失败 format v4 message requires a producer-owned source kind」),重试全部失败、后续任务卡住。改为 `Object.freeze({kind:'plugin:canvas-workbench'})`(dsh-codex 同款模式,与 v3→v4 迁移器对旧会话的改写结果一致,新旧会话形态统一);文字分析服务的同类旧写法一并修正。

## 1.9.0

- **聊天生图自动上画布(新功能,默认开启)**:聊天里生成图片时,画布中出现与「编辑图片」同款的**生成中占位图**(深色渐变+斜纹+转圈 SVG,占据图片即将落地的位置,批量时自动排布并标注数量);图片落盘归档后**原位替换为真实图片**,不再需要逐张点「加入画布」。占位失败/超时(25 分钟)自动标记失败态,可删除重试。设置 → 图像生成引擎里新增开关,含建议文案:**批量生图或大量抽卡重跑时建议关闭,改回卡片手动加入,避免画布被占满**。
- 机制:宿主侧 `chat-generation` 服务精确记录生成起止与产出路径(`/dsh-canvas/generation-status` 只读端点);客户端设计模式开启时每 2 秒轮询,自动上画布**只认宿主登记的本轮产出路径**——`read_image` 等工具结果里提到的旧文件永远不会被误加;派发复用手动按钮完全相同的令牌通道(`CANVAS_ADD_TOKEN`),不新增旁路。
- 工程侧:状态注册表抽为 peer-free 的 `src/host/services/chat-generation.js` 并新增 3 组单测(计数增减/快照防篡改/环形上限)。

## 1.8.4

- **定位聚焦「本地生图工作台 / Lovart 平价平替」**:标题与简介改为生图优先(开自己的 API、零订阅、本地数据),PS/AI 图层级桥接与可编辑 PSD/AI 交付作为独有溢价点;新增「是 Lovart 的平价平替吗?」FAQ(诚实划定边界:协作/视频/模板生态不在范围,可并用);keywords 增 lovart-alternative、ai-image-generator(共 28);GitHub 仓库描述同步。
- 引擎中立定位强化:README 引擎章节改为「带什么 API 都行」——API 直连(任意 OpenAI 兼容接口/国内大模型/企业网关,无需 ChatGPT 订阅)列为推荐起点,并明确本地工具链零 API 依赖;新增「和云端 AI 设计平台(如 Lovart)怎么选?」FAQ(不贬竞品,按场景分工,含并用组合)。
- AI 检索优化(GEO):README 新增「你可能在找它」问句式检索段(覆盖画布/修图/去背景/归档/PSD/桥接/素材库等用户问法,中英双语);npm keywords 扩充至 24 个用户词(deepseek-harness、remove-background、psd-export、text-recognition、infinite-canvas 等);GitHub 仓库描述改为设计师定位中文、topics 增至 11 个(excalidraw/photoshop/illustrator/adobe/ocr/psd 等)。

## 1.8.3

- **vendored Excalidraw 加固**:中性化上游官方构建里烘入的 Firebase 协作配置(`VITE_APP_FIREBASE_CONFIG`,含形似 GCP apiKey 的公开客户端 key)——本地画布从不使用协作功能,该配置是死数据,却是安全扫描器"硬编码密钥"误报的来源。新增 `npm run patch:vendor`(`scripts/patch-vendor-excalidraw.mjs`,幂等可重放,已入 `npm run check` 校验链);对 vendored 文件的改动仅此一处,升级 Excalidraw 后重跑即可。上游原文件(npm excalidraw@0.17.6 压缩产物)sha256:`27b133f845543f091aa518924b5b2fdd7eb52a9e490de100b9bc3bfd2ae2f314`,可自行核对。vet 扫描 high 由 24 降至 1(仅剩 Excalidraw 自带浏览器 polyfill 的标记,iframe 隔离)。

## 1.8.2

- npm 门面重写(面向设计师):简介与 README 改为设计师工作流视角——画布内修图/擦除/去背景/OCR/转矢量/PSD 导出、文字重建为可编辑 PSD/AI/SVG、素材库、Photoshop/Illustrator 双向桥接、生成图自动归档;补装引擎说明、系统要求与数据隐私说明。补 keywords(designer/psd/ocr/photoshop 等)。

## 1.8.1

- 图像引擎（dsh-codex 路由）诊断加固：模块加载失败时不再只显示笼统的"验证失败"，健康检查会透出**具体缺失的依赖包名**与补救命令（`npm install --prefix ~/.dsh/profiles <包名>`）。背景：dsh-codex 入口静态依赖一组由宿主提供的 peer 包（pi-ai、cordis 等），画布走 Node 原生导入时依赖 `~/.dsh` 层级解析链；新装环境或清理过全局层的机器可能缺包，此前无从得知缺哪个。

## 1.8.0（2026-09-18）

> 架构重构 + **Adobe 桥接**（Photoshop / Illustrator ⇄ 画布，macOS 真机验收通过）。核心画布行为与 1.7.0 一致（真实 DSH 回归：DOM 结构 0 差异、30 条 API 样例仅 1 处预期修复差异、Codex 端到端生成通过）。Windows：代码层适配 + 自动检查 + 源码安装器已就绪，实机验收清单见 `WINDOWS-TEST-CHECKLIST.md`（经用户确认按此门槛发布）。

- **「更多」菜单安装入口按需显示**：桥接安装是一次性动作，不再常驻三个按钮——打开菜单时查 `GET /status`，菜单脚本 / CEP 面板缺哪个才显示对应安装按钮（装完即隐）；「刷新脚本副本」按钮删除（DSH 启动已自动同步）。
- **Windows 适配与检查（本版本新增）**：① 仓库根新增 `install-windows.ps1` / `install-windows.cmd` 源码安装器（同步运行副本 + profile 注入 + 备份 + 健康检查，PowerShell 5.1 兼容、免管理员、UTF-8 BOM 防中文乱码，README 引用的这个文件此前并不存在）；② Adobe 桥接远程驱动的 PowerShell 命令全部改走 `-EncodedCommand`（Base64/UTF-16LE），绕开命令行引号/反斜杠转义与代码页问题，中文/空格路径直达；③ 🔐 菜单脚本安装在 Windows 走 `Start-Process -Verb RunAs` **UAC 提权**（内层 .ps1 带结果 JSON 回写，取消时明确报「已取消授权（UAC）」，此前 Windows 直接抛错不可用）；④ `createAdobeBridge` 支持 `isWindows` 注入，macOS 上即可单测 Windows 分支（新增 4 项单测：EncodedCommand 内容解码校验、UAC 提权流程、取消路径、Get-Process 探测）；⑤ 新增 `check-windows-compat.mjs` 入 `npm run check`：安装器 BOM/PS5.1 语法/括号配平、禁 `-Command` 直拼、平台专属调用必须 40 行内有 isWindows/isMac 守卫（支持 `platform-guard-ok` 人工确认注释）、禁硬编码 `/tmp`。

- **Adobe 桥接（Photoshop / Illustrator ⇄ 画布，真机验收通过：PS 2025 / AI 2026 往返像素级归位）**：PS/AI 内的 **CEP 常驻面板**（可停靠、非模态、自动检测发件箱；CC 2014→2026 通用；DSH 启动自动装进用户目录，免密码）+ ExtendScript 模态面板/一键脚本兜底旧版本（成功后自动关闭；ExtendScript 不支持常驻 palette）把选中图层/对象（透明 PNG，裁到边界，记录文档坐标）或整个文档（PSD/.ai 副本）送进项目 `ADOBE桥接/来自Photoshop|Illustrator/`，画布 3s 内自动上画布；画布选中工具栏新增「→Ps」「→Ai」，把图片/分层 PSD/.ai 原样放进 `ADOBE桥接/发件箱/`（序号永不覆盖），返回**按格式分流**：PSD → PS 把全部图层并进当前文档（文字层保持可编辑、组承接、归位）；.ai/.svg → AI 按对象并入（文字可编辑、归位）；其它格式仍作为图片置入/智能对象——真机数值全部精确命中；或「打开为新文档」。传输只靠文件夹 + `~/.dsh/canvas-workbench/adobe-bridge/bridge.json` 握手心跳，无端口无网络，CS6→2026 通用。菜单面板入口：「更多」菜单**按需显示**——检测到未安装（`GET /status` 的 `scriptsInstalled`/`cepInstalled`）才出现「🔐 安装 PS / AI 菜单面板」（PS/AI 都只扫描 root 权限的应用目录，弹一次 macOS 管理员密码框；装好按钮即隐）/ `npm run install:adobe-bridge`。契约 `canvas-workbench/adobe-bridge/PROTOCOL.md`；新增 `check-adobe-bridge-jsx.mjs`（BOM/ES3 守卫）与 6 项单测；脚本支持无头模式供自动化回归。**日常主路径不进 Adobe**：画布顶栏「取 Ps 图层 / 取 Ai 对象」与选中工具栏「→Ps / →Ai」直接远程驱动运行中的 PS/AI（macOS osascript；Windows COM 待验证），取图≈2s、返回并归位≈2s；DSH 启动时自动同步脚本副本（远程驱动零配置）。
- **Host 拆分**：`lib/index.js` 2,256 行的单个 `apply()` 拆为 `src/host/`（routes 9 文件 / services / server / jobs / adapters）与 `src/shared/utils/`，handler 逐字迁移，`lib/index.js` 成薄壳；API 对等测试 55 条请求 0 差异。
- **Provider Registry**：`image-engine.js` 拆为 dsh-codex / openai-compatible 两个 Provider + 注册表 + 门面（签名与行为不变）；设置与 API Key 存储路径不变（本地 0600）。
- **Job Manager**：Job 契约与状态机、内存 Store、事件总线；edit-image / remove-background / vectorize / ocr / export-psd 自动登记，新增只读 `GET /dsh-canvas/jobs`、`/jobs/get`、`POST /jobs/cancel`。
- **Client 构建管线**：`client.js` 切成分段源码（`src/client/**` + `build-manifest.json`），`npm run build` 拼接为 `lib/client.js`（首构建与原文件逐字节一致）；**删除 tldraw 时代死链**（`TLDR_BUNDLE` 等，无引用），`lib/client.js` 2,344,322 → 426,932 bytes（−81.8%），启动少做一次 1.9MB 字符串处理。
- **Command / History**：共享 Command 基类、CommandBus、HistoryManager（undo/redo 双栈）；构建期内联进 bundle，挂 `window.__dshCanvas`。
- **契约层**：CanvasObject（含 Excalidraw element 双向 adapter）、Asset（稳定 assetId、类型/来源推断）、Job、Feature；`project.json` schemaVersion 2（v1→v2 只加字段、幂等、旧插件可读）。
- **Feature Registry / Capability**：12 项内置 Feature 声明，按 `/health` 推导 capability 启用；新增只读 `GET /dsh-canvas/capabilities`、`/assets`、`/python-tools`（§28 统一 `{ok,data}` 形状）。
- **Python Tool Registry**：11 个脚本按 id 注册解析（物理目录重组待路由改经注册表后进行）。
- **文字重建新增 AI（Illustrator）导出**：识别确认后面板提供「生成 AI（Illustrator）」，与 PSD 的「草稿 + 原生脚本」同构——先出 SVG 草稿，再由 Illustrator ExtendScript 建文档、放置并内嵌底图、逐块创建**原生点文字**（字体按本机 PostScript 名解析），saveAs 为**原生 .ai**（PDF 兼容）并自动加入画布。脚本不可用（未装 AI / 非 macOS / 权限）时退回可编辑 SVG 草稿（内嵌背景 + `<text>`，字体映射家族名+字重；背景清理成功时文字组可见，未清理时隐藏避免与原图重叠）。
- **Adobe 桥接（Photoshop / Illustrator ⇄ 画布）取代并移除「编辑图层」**：原 v1.8 开发的 PSD/AI/SVG 图层级编辑（列层树→提取→引擎改→原位写回）与桥接的「取 Ps 图层 → 画布编辑 → →Ps 归位」往返高度重合，按用户决定整体移除（删除路由 document-layers/edit-layer/extract-layer、LayerEditDialog、psd_layers.py/svg_layers.py 及注册项）。桥接的等价能力与更多形态见上方 Adobe 桥接条目；旧项目里历史 `-图层编辑` 文件与 `画布备份/` 不受影响。
- **修复 .ai 生成后的“两个文件”与画布不同步**：根因一，Illustrator 2026 的 ExtendScript 没有 `CloseOptions`，脚本里的 `doc.close()` 两种写法都抛错——每次生成的**临时文档都留在 AI 里没关**，用户误把临时文件当正式文件编辑；根因二，脚本成功后跳过了“打开正式文件”步骤。修复：所有 Illustrator/Photoshop 脚本收尾统一用 AppleScript `close every document saving no` 清场（ExtendScript 关不掉的兜底），生成后**总是打开画布正式文件**（与交付到画布的是同一份），在 AI 里保存后画布按 mtime 轮询自动刷新预览。
- **聊天图片输出回退链重做**：附件/本地条目改为**逐级尝试**的候选链（主机按名找回 → 原路径/条目 sourcePath → 当前项目归档同名 → 附件 blob），本地文件优先即时显示；DSH 旧会话附件解析悬而不决时 6 秒超时降级；新增 `GET /dsh-canvas/resolve-image` 按文件名在项目/工作区（含兄弟项目的 DSH聊天生成图片/、assets/）找回原图，`-N` 副本名回落原名；彻底找不到才显示整洁的失败卡（不再渲染浏览器碎图）。
- **动态加载界面**：图片修改 / 去背景占位从静态 SVG 改为 iframe 内跟随位置与缩放的 DOM 覆盖层——转圈、流动斜纹、扫光进度条、引擎提示、已用时长；去背景显示真实百分比与阶段；小尺寸自动紧凑模式。
- **擦除合成痕迹修复**：有蒙版时不再"整图缩到 1024 再放大贴回"，改为按选区裁剪原生分辨率窗口（边距在预算内自适应）送模型、结果贴回原位；羽化环 14–48px 并在羽化环内做源图/生成图色调匹配，消除擦除区发虚与矩形补丁感。
- **修复**：`/dsh-canvas/system-appearance` 把布尔常量 `isMac`/`isWindows` 当函数调用导致永远 `known:false`（「画布背景跟随系统」主机探测在 1.7.0 从未生效）。
- **测试与工具**：`npm test`（unit 32 + migration 3）、`npm run test:integration`（git 基线 vs 工作树 API 对等）、`npm run check`（portability + 递归语法 + 构建漂移守卫）；`tests/smoke/` CDP 客户端（页面内 fetch 绕过 DSH 网关 403、DOM 真值快照）；`tests/fixtures/` 零个人数据样例项目；npm 打包白名单加入 `src/`。
- **生成脚本语法检查（新）**：`npm run check` 增加 `scripts/check-generated-jsx.mjs`——把 host 路由里用字符串拼出来的 Illustrator/Photoshop 脚本抽出来做独立 `node --check`，并检查 iframe 的 srcdoc 内联脚本（求值模板字面量后截取 `<script>`）。这类错误整文件 `node --check` 查不出来，本轮两个致命 bug（缩略图整段 JSX 解析失败、`/edit-layer` 提取必失败）都是这么漏掉的。

### 附：已移除的「图层编辑」功能（历史记录）

该功能（含上面十余轮修复：.ai 缩略图、原子写回消息、z 序自检、临时副本与清场、占位图自愈、诊断通道）已整体随功能移除，详细历史见 git 历史与 AGENT-HANDOFF §15；其中沉淀的通用设施仍在服务其它功能：生成的 JSX 语法检查（check-generated-jsx）、编辑占位图 30 秒自愈、image-edit-result 原子替换消息、dshScratch 标记。

## 1.7.0

- 素材库多维整理：可按修改时间、文件类型、图片尺寸、文件大小、文件名称排序（选择本地记忆），卡片与预览显示宽高/大小/时间。
- 素材库 Mac 式七色标记：卡片角标、多选批量标记、按颜色筛选；标记集中存放于插件数据目录，删除素材自动清理。
- 画布图片颜色标记与整理升级：选中图片可设七色标记（随 canvas.json 持久化、可撤销）；「整理图片」支持 类型/时间/尺寸/大小/名称 排序与按颜色/未标记范围筛选，文件类型按扩展名分块布局。
- 聊天图片输出全链路修复：去掉 9 张显示上限；本轮旧图引用按文件修改时间过滤；归档撞名（-2 后缀）与最终回复名字自动配对；最终文本引用改为合并而非整体替换；<output_path> 归档路径纳入提取；缩略图/大图/全部加入画布/文件夹定位统一三级回退（条目源文件→项目归档→附件解析），不再依赖画布项目绑定。
- 生成图归档层级：DSH聊天生成图片/<会话标题>/<日期>/<时段>（5 小时分段）；文件夹名与会话标题同步改名；未绑定项目时归档到聊天工作目录，始终有落盘路径。
- 画布 imagegen 未绑定项目不再报错阻断（此前会把 agent 逼向旁路技能）；归档失败写入 writeError 不中断生成。
- 文字识别/重建字体改用免费商用字体：阿里巴巴普惠体 3.0 全系列、思源黑体 SC 全系列、Inter/Montserrat/Poppins/Source Sans Pro；默认普惠体 55/85，导出数据层归一，PSD 光栅化按所选字体渲染。
- UI 与 DSH 风格统一：去除画布/素材库阴影；画布容器、顶栏、素材库、整理弹层改用 DSH 设计令牌；画布背景与选区工具栏跟随 DSH 主题，并支持「跟随系统外观」模式（主机进程读取真实系统外观，规避 Electron 媒体查询覆盖）。

## Release catalog correction (2026-09-07)

- Restored `v1.4.0-windows-preview.4` (custom 20260906) as the verified Windows baseline.
- Keep the verified full Windows ZIP and standalone canvas ZIP with their published SHA-256 values.
- Only Windows packages older than the r5 baseline are candidates for removal.

## 1.6.6

- 素材库顶部目录区默认折叠为单行，只保留当前目录、切换和展开入口；完整路径、最近访问及拖拽说明按需展开，释放更多素材浏览空间。
- 拖拽进入素材库时即使目录区处于折叠状态，也会自动显示落点提示。

## 1.6.5

- 修复素材库显式“多选”模式只能保留一项的问题；现在普通点击即可逐项勾选或取消，无需按住 Command、Ctrl 或 Shift。
- 修复高清画布图片快速拖入素材库时跨 iframe 数据尚未到达导致保存失败的问题；“加入素材库”按钮同时成为明确的拖拽入口。

## 1.6.4

- 素材库目录与画布项目彻底解耦，可通过系统原生文件夹选择器自定义任意独立目录。
- 当前素材库和最近访问的 8 个素材库目录保存在本机，切换项目或重启 DSH 后保持不变。
- 素材侧栏增加当前目录卡片与“最近访问”快速切换；首次升级自动沿用旧工作区的“画布素材库”目录。

## 1.6.3

- 素材库改为画布右侧侧拉栏，打开时画布仍可查看和操作；素材卡片改成双列瀑布流。
- 增加双向拖拽：素材可拖到画布落点，画布已选图片或本地图片可拖入当前素材库。
- 默认卡片右上角显示放大预览；进入“多选”后才显示勾选框和底部批量操作。
- 画布右键“添加到素材库中”和选中工具栏“加入素材库”统一保存到当前画布项目对应的素材库，并立即刷新侧栏。

## 1.6.2

- 重新设计素材库交互：卡片单击选择、Command/Ctrl/Shift 多选、双击加入画布，移除每张卡片重复的三组操作按钮。
- 增加文件名搜索、素材计数、刷新、跨平台打开素材目录，以及固定的批量操作栏。
- 支持把画布中选中的一张或多张图片批量存入素材库；支持素材批量加入画布、一次附加到聊天及确认后删除。
- 优化素材库明暗主题、窄窗口响应式布局、空状态、载入状态和错误反馈。

## 1.6.1

- **关键修复**：画布文件表丢失向量根治——onChange/hydrate 完成路径的 serialize 改用 api.getFiles()（Excalidraw 0.17 onChange 不传第三参数，原实现恒得空文件表）；父层合并增加"防清空守卫"：存活图片元素引用的 fileId 缺失时自动从已有文件表补齐，文件表只允许因元素删除而收缩。
- 图片还原失败不再静默，会经画布错误通道上报具体原因。
- 离线复现台（Chrome+CDP 协议回放）验证：切换/水合/增量全链路文件表稳定。

## 1.6.0

- **性能**：Excalidraw onChange 600ms 尾沿防抖 + changed 快照 files 增量协议（usedFileIds + 变化文件），大画布（25 图 / 54MB 场景）交互传输量从每帧全量降至约 0.1MB。
- **存储治本**：canvas.json 落盘剥离图片 base64——有 customData.dshSourcePath 的文件条目只存 dshPath 引用，运行时按需经 /dsh-canvas/image 还原；项目文件从 54.4MB 降至约 23KB。旧内嵌格式项目可正常加载，首次保存自动瘦身。**新格式项目需 1.6.0+ 插件打开，勿回退旧版。**
- **数据完整性**：
  - 场景令牌：load 换发新令牌，跨项目迟到的 changed 一律丢弃；
  - 水合守卫：场景渐进恢复期间抑制 onChange，杜绝"半场景快照"砍掉完整文件表（曾致 15 图项目丢 9 个文件表条目并误触图片回收）；
  - 备份与主存剥离逻辑一致，且服务端 access() + mimeOf() 双验证后剥离，保证备份可还原。
- **修复**：rename-project 项目改名后同步改写 canvas.json 及画布备份内的绝对路径引用（JSON 转义安全替换，兼容 Windows）。
- **数据恢复工具**：scripts/rebuild-canvas-files.js 可从元素 dshSourcePath 重建文件表；psd/pdf/ai 文档源自动经 sips 生成 jpeg 预览（文件表内文档源必须是栅格预览，不能是文档字节）。

## 1.5.9

## 1.5.9

- 修复 DSH 更新或 Profile 重建后 Codex 聊天模型消失：同步脚本会把 `dsh-codex` 同时注入 Web 与当前活动 Profile，并在健康检查中强制验证。
- npm 独立画布包纳入内置 `vendor/` 资源，确保无公网 CDN 时 Excalidraw 仍可加载。
- macOS 安装前备份、卸载流程覆盖 Web 及任意命名活动 Profile 的画布与 `dsh-codex` 副本，避免卸载后残留。

## 1.5.8

- 修复聊天生图成功但图片卡片消失：最终回复中的裸文件名不再覆盖工具结果里同名的持久化附件或绝对路径。
- 忽略 `*.png` 等通配路径，避免批量产物的真实图片被一个不可读的 glob 占位覆盖。
- 最终回复只写文件名时，会按当前画布项目的 `DSH聊天生成图片/` 目录解析，不再错误地到聊天工作目录根下查找。
- 历史会话附件 ID 失效时，自动回退到画布项目中的同名归档原图。
- DSH 重启或切换会话时，图片卡片会等待 `conversation` 附件服务就绪后再解析，避免新生成图片被启动时序误判为加载失败。

## 1.5.7

- 画布运行库改为随插件内置的 React 18.3.1、ReactDOM 18.3.1 和 Excalidraw 0.17.6，不再依赖 jsDelivr，避免 DSH/Electron 策略或国内网络使 iframe 永久停在“加载中”。
- 增加画布本地资源失败与初始化超时的可见错误提示，不再无限空白等待。

## 1.5.6

- 修复没有记录源路径的 PNG 重命名：同步回传实际 `assets/` 新路径，避免下一轮轮询重复物化并触发同名冲突。
- 重命名成功后先更新父页面快照再落盘，并保留短暂竞态保护，确保画布内容与项目文件夹一致。
- 补齐 Windows 文件名大小写比较和项目扫描的跨平台 `assets` 路径判断。

## 1.5.5

- 修复 PNG/SVG 改名时磁盘二次扫描造成的“同名文件”误报和画布源文件消失。
- 改名期间暂缓项目轮询删除，改名完成后同步更新画布中的源路径与项目快照。
- 画布文件标签隐藏扩展名，并随缩放同步字号、尺寸和标签宽度；补齐 Windows 路径匹配。
- 修复首次同步脚本在 macOS 自带 awk 下无法注入 profile 的问题。

## 1.5.4 npm packaging

- 新增 `dsh-canvas-workbench` npm 发布构建器；生成包带有 DSH `cordis.patch.yml` 自动挂载配置。
- npm 包与现有 `@local/canvas-workbench` 本地安装身份隔离，不影响 DMG/PKG/ZIP 和本机同步流程。
- 发布清单仅包含插件运行文件、说明和许可证，并排除凭据、日志、缓存和 Python 字节码。

## 1.5.4

- 基于 `origin/main` 重新发布跨平台画布插件与 macOS 完整安装包。
- 修复聊天结果中已失效本地图片路径导致的破图卡片，并增加本地图片状态检查。
- 为 DSH 2.0.4 的 Codex 图片请求补齐尺寸、像素和文件大小预算。
- 修复 Profile loader 重复注入问题，避免更新后出现重复插件入口。
- Windows r5 下载入口与校验说明同步到最新 Release 资产。

## 1.5.3

- 将最新 `canvas-workbench` 源码与聊天图片路由纳入跨平台仓库。
- 聊天生图与画布编辑统一使用画布引擎选择的 `dsh-codex` 或 API 路由；生成原图归档到当前画布项目中、与 `assets/` 同级，并仍需用户明确加入画布。
- SVG/AI/PDF 发送聊天前仅在附件边界转为 PNG，源文件和画布项目数据不变；移除重复的“打开画布”按钮。
- 移除独立 `home-explorer` 文件浏览器及其注入，保留画布自身的项目目录操作。
- 纳入 Mac 完整安装器工程、双架构运行时准备脚本、健康检查、回滚说明和可选 `dsh-codex` 兼容构建。
- 大型运行时/模型改为 GitHub Release 资产，不进入 Git 源码历史。

## 1.4.0-windows-preview.1

- 新增 Windows PowerShell 安装、卸载、健康检查和登录自动恢复任务。
- 新增跨平台系统适配层，支持 Windows 文件夹选择器、资源管理器打开和文件定位。
- 本地图片路由接受 Windows 盘符和 UNC 绝对路径。
- 客户端识别 Windows 盘符、反斜杠和 Windows 上级目录。
- Python 调用支持 `python.exe`、`python` 和 `py -3`，缺少 Python 时明确降级。
- PSD、AI 在 Windows 通过系统文件关联打开；原生 Photoshop 文字层自动化保留 macOS 路径。
- Windows 缺少 PSD/PDF/AI 转换器时显示占位预览，不阻断画布。
- 健康接口新增平台能力矩阵，并修复写死的旧版本号。
