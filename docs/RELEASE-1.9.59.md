# canvas-workbench 1.9.59

2026-10-25。最终推荐使用1.9.59，包含 [1.9.58全部新增功能](RELEASE-1.9.58.md)。

Windows最终复核补充：原生AI的COM调用改用带5分钟超时的真实执行器；正常退出、未超时且返回成功标记，才算成功。超时或非零退出即使打印成功标记也会保留失败。174项自动测试、构建及兼容性静态检查通过。新增测试直接执行Windows导出分支，并明确拒绝无超时执行器。

Windows仍为代码和分支模拟验证，没有Windows Adobe实机。既有Mac双Adobe14层对齐、原生文字及形状可编辑、保存重开证据继续有效；本补丁不改变Mac导出几何。

包内包含src、scripts、客户端、Adobe桥接及API文档，共172文件；发布后核对官方latest、tarball SHA1及全新安装。

## 发布后确认

- npm 官方 latest=1.9.59，精确版本与下载tarball的SHA1均为 `bfc83acf5dbefb6a7944e688d71dba610e9d06c0`；SHA256 `0fd8b0c73cbc2ac9edb27daba4a1455d1f3c49d4c5afcb976242ef9db416114f`。
- 直接从官方registry全新安装1.9.59，再次完成宿主加载、正式聊天工具注册、真实后台PSD转换和尺寸读回，0次模型请求。
- GitHub main与v1.9.59已推送，代码提交2bf47e9；v1.9.58为3ad5698。
