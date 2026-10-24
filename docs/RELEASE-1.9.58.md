# canvas-workbench 1.9.58

2026-10-25。包括图片拆层、独立照片与形状、可编辑 PSD/AI/SVG、正式聊天画布工具和持久后台批处理，以及 Illustrator 文字对齐修复。

## 发布前检查

- 构建、静态兼容性检查及 173 项自动测试通过，0 失败、0 跳过。
- 打包包含172文件，约1.6MB；含宿主源码、Python脚本、客户端、Adobe桥接及后台API文档。无凭据、缓存、测试素材或本机私人路径。
- 隔离目录安装实际tarball，使用精确 DSH tools/llm 0.2.1-rc.2。宿主加载、正式 canvas_workbench 工具注册、实际后台普通PSD转换和尺寸读回通过，0模型请求。
- 一键面板与 Agent 批处理共用拆层服务和 hasBlockingLayerQuality 规则。可修复问题交给执行器重检；缺字体和无效几何仍待核对。正式工具→队列→结构预检→本地故障恢复→PSD矢量形状→结果画布有受控回归。

## Windows兼容性范围

- 执行实际 Windows AI 导出分支模拟：UTF-8 BOM ExtendScript、PowerShell UTF-16LE EncodedCommand、COM成功/失败归因、输出文件头检查。
- 规格文件与显式UTF-8结果文件验证中文、空格、单引号、UNC和扩展长路径。没有将含路径/文字的JSON拼进命令行。
- 现有Windows Python选择、更新器布局、桥接安装、Adobe COM传输、客户端恢复与交互回归保持通过。
- 本次没有Windows桌面、Photoshop或Illustrator实机；不能将模拟检查称为Windows实机验收。长路径传输通过不代表所有Adobe版本都能打开超过其自身限制的文件。

## Mac实机证据

14层用户图片：7原生文字、3原生圆角形状、3不透明矩形照片、1独立背景。Photoshop与Illustrator实际渲染的7段文字墨迹边界最大差1px；形状移动、保存重开仍可编辑且坐标正确。独立文字样例验证左/中/右对齐、多行和30度旋转基线。照片遮挡区域外保留原像素，遮挡内修补和替代字体仍可能与原图不同。

## 校验值

- tarball SHA1: `3aec4e39a6dc0921c369ce2b26fe82cfc1b553fc`
- 版本与公开registry状态以发布后验证为准。
