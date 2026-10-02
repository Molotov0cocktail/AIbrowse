# Watch 非暂停资源验收工具

产品与验收契约见 `doc/stage6/detailed-design.md` §15.6/§15.7；本工具不改变固定负载或资源阈值。
原始 JSONL、构建产物、机器配置和合成数据库放在受控的 ignored 目录，源码及反例纳入 Git。

## 运行

1. `pwsh -NoProfile -File tools/watch-qualification/build.ps1 -Tests` 构建 Windows 采集器并运行真实子进程和文件占用反例。
2. `npm run build:qualification:load-diagnostic` 生成短验产物；正式窗口用 `npm run build:qualification`。
   normal 与各资格构建输出到不同目录，不能用普通入口替代资格入口。
3. `run.ps1` 接受 `-WorkParent`、`-ArtifactRoot`、`-Mode short|formal`、`-EnvironmentApproved`。
   两个目录须预先存在；工作父目录须在仓库和用户 profile 外，证据目录可位于仓库 `log/`。
   开关只表示操作者已完成环境与关键改动审核；脚本还会执行只读预检，不能把开关当隔离证明。
4. 独立复算：`node tools/watch-qualification/report.ts <observations.jsonl> <telemetry.jsonl> <新报告.json>`。
   输出文件必须不存在，防止覆盖旧报告。原始证据始终保留。

采集器直接创建 suspended Electron，加入专属 Job 后启动；产品不等待外部采样。CPU使用Job累计量，
内存与句柄逐成员保留身份并前后复核，可能阻塞的查询在独立worker中有界执行。每项记录独立QPC区间；
worker失败记录invalid，不补零。main遥测原件的QPC为固定16位十六进制，外部记录为十进制字符串，报告器分别解析。

短验覆盖固定负载中的四个Session初始化任务，只证明测量可行性。正式资源窗口仍需361点、drain61点；
CPU、内存、main、释放结果分别报告，已证越界不会被其它指标的缺证掩盖。电池、关闭后DB业务事实、隐私和
Windows稳定性未覆盖时，总门保持缺证。工具不会自动删除运行根；后续必须先按身份复核数据库与本轮所有权。

## 验证

`npm test -- --maxWorkers=1 tools/watch-qualification` 运行报告器与安全预检反例。
工具TypeScript纳入项目typecheck/lint/format。native反例覆盖退出子进程CPU、Job残余、禁止breakaway、
伪writer、普通读/写/DELETE共享句柄、真实SQLite连接以及temp条目。测试过程不读取真实凭据。
