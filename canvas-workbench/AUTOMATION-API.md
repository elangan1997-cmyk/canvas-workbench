# 聊天操作画布与后台批处理

1.9.59，2026-10-25。正式聊天工具名为 `canvas_workbench`，通过 DSH 的 `defineTool` / `ctx.tools.register` 注册。无需让模型编写脚本或直接修改 canvas.json。该工具不是独立公网服务；HTTP 路由挂在现有 DSH 插件服务中。

## 在聊天中使用

- “把 `/绝对路径/商品图片` 中的图片批量抠图，完成后新建项目展示。”
- “把这个文件夹的图片拆成可编辑 PSD 和 AI，保留原图坐标，整批最多允许 8 次图像请求。”
- “先读取画布，把名为主图的那个对象向右移动 20，其余对象不动。”
- “只修改选中图片原图像素坐标 x=100、y=200、宽=300、高=400 的区域，区外保持原图。”
- “继续任务 `<job-id>`，只处理失败项。先告诉我哪些请求结果未知。”

图层分析随提交时的当前聊天模型；图像重建随当前画布图像引擎。任务冻结模型与引擎设置，运行途中切换聊天模型不会改变已提交任务。当前默认 dsh-codex 模型为 Image 2.5；没有另建图像 API key。

## 操作与边界

| operation | 行为 | 是否调用图像生成 |
| --- | --- | --- |
| remove_background | 本地 BiRefNet 抠图，输出透明 PNG | 否 |
| flat_psd | 把原图封装为普通单图层 PSD，文件名标明“普通转换” | 否 |
| layered_export | 当前聊天模型识别实际元素数；本地 OCR、字体与基线校准；提取独立素材和背景；导出 PSD / 原生 AI / SVG | 原图无法提取时，受整批显式额度限制 |
| edit_image | 编辑整图或指定原图像素选区，局部编辑的区外像素由原图恢复 | 是，必须显式允许且给出上限 |

AI 需要本机 Illustrator，文件含原生文字及嵌入图像；不会把所有照片自动变成矢量。普通 PSD 转换不拆层、不产生可编辑文字。普通多行文字先拆行校准；字体无法可靠匹配、旋转字或排版重叠时自动保留原字形区域并记录差异，不再要求用户接受质量近似项。原字形区域是图像层，不能冒充可编辑文字。无效坐标、损坏素材、未知请求及额度限制仍由执行器保护。

拆层前景返回先区分透明画布与实际内容，去除透明留白后等比缩小或放大，完整放入原图识别区域并居中；保留可见软边，避免横纵拉伸或裁掉主体。独立 PNG 的尺寸与实际可见边界一致，PSD/AI 共用该坐标；缓存续跑不会再次移动。一般比例差异会完成素材并记录 placementQualityIssues 供核对，不再仅因返回画布或内容比例稍有差异直接失败；可见内容比例相差超过约2.23倍时仍拦截，防止混入其他内容。背景仍要求整图比例与完整不透明，不能用前景留白方式补齐。原始返回保留；已有 raw 可在本地模式继续处理。尺寸适配不等于精准恢复：识别框与原图不准或模型内容有变化时仍须复核。

关闭拆层窗口会保留当前任务现场；再次打开同一张图直接回到原进度。整页刷新或重新打开应用后，面板按图片内容哈希匹配当前聊天工作区和旧画布中的磁盘任务，恢复累计额度及导出格式；不会自动重新分析或发起生成。历史任务列表显示失败/待提取/已完成状态，可手动切换与刷新。浏览器只保存轻量任务定位器，素材仍在所属工作区。超过最近列表的任务也可通过定位器恢复；同名不同图不会自动混用。

## 一键拆层与结构约束

面板默认“一键拆层并导出PSD”，格式可选AI/SVG；“仅分析”保留清单调整入口。HTTP分析时传autoRun:true、autoExportFormat:"psd"（或ai/svg）、openAfterExport:true；同一个后台执行器会完成分析、校准、结构预检、提取与导出，不需要每层手点继续。已保存任务用run继续，只重做失效素材；export仅生成文件，不重复提取或购买图像请求。

图层类型包含background、text、image、shape；image.extractionMode区分photo与cutout，modeLocked/geometryLocked保留用户选择。模型先输出visualKind（product/photo-panel/screenshot/graphic）及classificationReason；照片面板必须给出framingEvidence。连续台面上的商品、盛器和自然接触阴影归为透明产品层（shadowMode:preserve），不会仅因来自实拍就保留整块台面；真正有边界的矩形照片保留原场景、不调用抠图。本地直边探测不覆盖明确的商品决策。文本标签下封闭浅色胶囊生成独立roundedRect形状，PSD为矢量填充蒙版，AI/SVG为原生路径。局部隐藏内容修补近似会保留警告。结构预检新增的shape会计入实际清单。

生成背景采用一张连续的完整底图，不再混回带字原图区域，避免渐变、台面上的擦除接缝；可核实的纯色原图仍走source-flat。旧背景plateVersion会用已返回raw本地重建，不购买重复图片。高置信度OCR与模型文字存在少量差异时，交回所选聊天视觉模型对照原图决策；复查失败则自动保留原字形，OCR不会静默改写文案。重新校准保留既有素材签名和raw记录，文字补正无需重生商品或背景。

程序只对明确的本地临时错误有限恢复，损坏派生图从raw重建；不会因未知结果自动重发生成请求。图层独立失败，其他成功结果先保存。导出检查点防止发布成功后的缓存/预览失败造成同文件重复发布；签名包含实际合成像素及导出器修订。完成后自动交付，视觉近似记录为说明；真正无法生成的输入、文件或额度错误才暂停。

AI使用最终文字基线与明确的左/中/右分支，保存后重新打开检查字体、段落对齐、基线及边界。显式本机回归可运行 tests/integration/verify-ai-text-alignment.mjs，覆盖左/中/右、多行、30度旋转，不调用图像模型。2026-10-25：166项测试通过，真实14层用户图双Adobe检查、照片外遮挡区域像素检查通过；AI/PSD文字墨迹边界最大差1px。见 https://github.com/elangan1997-cmyk/canvas-workbench/blob/main/docs/LAYER-HARNESS-2026-10-25.md。

## 聊天工具契约

action：`capabilities`、`inspect`、`plan`、`submit`、`status`、`list`、`cancel`、`resume`、`open`、`review`、`arrange`。

1. `plan` 检查文件清单，不创建项目、不调用模型。
2. `submit` 立即返回任务 ID，后台串行执行；关闭面板、结束聊天轮次不会停止任务。
3. `status` 读取明细，可用 `wait_ms:10000` 降低轮询频率；`list` 默认返回摘要。
4. `review` 配合 `job_id`、可选 `item_id` 读取完整图层/字体候选/质量问题，并打开对应插件核对面板。`open_canvas:false` 仅读取。修正后在后台任务中继续，会复用该子任务素材和既有导出。
5. `arrange` 必须使用刚刚 `inspect` 返回的 `revision` 和对象 ID。仅支持位置、尺寸、旋转和透明度；旧版本或过期场景会拒绝调整。活跃画布先通过 iframe 执行，确认落盘后才返回成功；读取不会退回旧的缓存版本。

文件输入使用 `folder` 或 `paths`。都省略时使用当前画布选中图片；`element_ids` 可精确指定图片对象；`selected_only:false` 使用当前画布全部图片。默认不递归，默认最多 100 张、最高 500 张，单图 32MB / 2000 万像素。超出数量明确报错，不静默截断。跳过隐藏文件、AppleDouble 和符号链接。输入为栅格图片；PSD/AI 的二次处理应提供其源图片。

```json
{
  "action": "submit",
  "operation": "layered_export",
  "folder": "/绝对路径/输入图片",
  "output_parent": "/绝对路径/结果",
  "project_name": "商品拆层",
  "formats": ["psd", "ai"],
  "editable_text": true,
  "font_policy": "substitute",
  "allow_generation": true,
  "max_image_requests": 8,
  "request_id": "商品拆层-20261024-001",
  "open_canvas": true
}
```

`request_id` 是幂等编号：同会话、同编号、同参数重复提交返回原任务；同编号变更参数报错。未提供编号时，相同任务 30 秒内也去重。模型收到响应错误应先查 `list` / `status`，不能盲目重发。

额度为**整批累计**，包含失败或未知请求，默认 0；显式 `allow_generation:true` 也必须设置正上限。恢复任务会读取所有子任务重新核算，不能通过重启或继续重置额度。未知结果默认不重发；核对后显式 `retry_unknown:true` 才允许重试。普通取消不删除结果。应用退出后未完成任务标为可恢复，不能承诺应用关闭期间仍在执行。

## 项目、状态与恢复

2026-10-24 保存规则补充：画布内新建拆层任务默认跟随**当前聊天工作目录**，过程文件位于该工作区的 `outputs/图片拆层/<任务编号>/`，最终文件位于 `assets/`。面板会显示本任务工作区。自动打开过的测试/结果画布不会改变后续新拆层的保存根目录。任务创建后固定归属，切换工作区不会搬移正在运行或历史任务；旧任务仍可在清单中恢复。成功发布到 assets 后，过程目录不再保留第二份完整 PSD/AI/SVG，逐层素材仍保留用于续跑。HTTP 新建拆层时使用 `storageScope:"workspace"` 及 `sessionId`，以宿主当前会话工作目录为准；后续读写用返回的 `storageProject` 作为 `project`。

默认独立新建项目并保存 `canvas.json`、`project.json`、`assets/`、`outputs/`；源图副本、哈希、模型原始分析、校准报告和中间素材保存在 `outputs/批处理过程` / `outputs/图片拆层`。原始输入不覆盖。后台逐文件隔离错误，成功文件立即落盘；一个文件失败不阻断剩余文件。

任务清单在 `~/.dsh/canvas-workbench/automation-jobs/`，包含状态、结果、累计请求数及选定模型，不写密钥。状态可能为 `queued`、`running`、`cancelling`、`completed`、`partial`、`needs_review`、`failed`、`cancelled`、`interrupted`。部分格式导出失败后继续只重试缺失格式，不重复买素材或重建已成功 PSD。

结果展示采用持久事件与客户端确认：尚未展示的完成结果在 UI 恢复后继续展示。主动指定已有输出项目时，会保留其元数据；正在编辑的项目拒绝作为后台写入目标，避免覆盖未保存修改。

## 本地 HTTP API

前缀 `/dsh-canvas/automation/`。POST：`plan`、`submit`、`cancel`、`resume`、`open`、`review`、`canvas`（调整）。GET：`job?id=...`、`jobs?sessionId=...`、`canvas?sessionId=...`（读取）。成功响应 `{ok:true,value:...}`；错误 `{ok:false,error:...}`。HTTP 字段为 camelCase，对应聊天工具的 snake_case。

`events` / `ack`、`context`、`canvas-result` 为插件 UI 协议，不应由模型伪造完成回执。调用者应使用正式工具或操作路由。

## 验收

自动门禁：`npm run build`、`npm run check`、`npm test`。新增队列、失败隔离、恢复、额度、未知请求、幂等、场景版本、局部像素锁定、文字定位、背景清理和导出恢复回归。

显式 Adobe 实机检查（只操作导出文件的副本）：

```text
node tests/integration/verify-layered-adobe.mjs <task.json> <独立证据目录> ai
node tests/integration/verify-layered-adobe.mjs <task.json> <独立证据目录> psd
```

2026-10-24 Mac 实测：当前 DeepSeek Flash 调用正式工具完成文件夹 2 张普通转换、幂等提交、含 2 段原生文字的 PSD+AI；Photoshop 与 Illustrator 都通过改中文、改价、移动、保存重开；关闭画布后本地抠图完成并自动打开新项目。本轮未发起新生图。复杂奶茶菜单的两段低分文字进入复核，不能等同于全自动精确恢复。Windows 本轮只有静态兼容和模拟传输检查，没有新增 Adobe 实机证据。

2026-10-25 本机后续修复：画布与Agent后台共享自动质量处理，去掉强制核对及字体接受勾选；180项回归通过。原矿球图实测7层（5原生文字、产品含阴影、背景），DS分析及文字差异复查，Image2.5共2次生成；背景接缝修正与补字复用原始素材，未新增生图。PS/AI实际编辑、移动、保存重开通过，两者文字边界最大差2px。当前改动已本机部署，npm公开版仍为1.9.59；Windows无新增Adobe实机验收。

1.9.59 补充：Windows AI 导出使用真正具备5分钟超时的进程执行器，超时/异常退出不能报告成功；174项回归通过。
