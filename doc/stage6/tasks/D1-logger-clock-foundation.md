# D1 — 长期运行前置：日志资源硬化与可控 Clock 基座

## 目标

在任何周期 Watch 网络路径接线前，为现有 logger 增加确定性大小/数量/时间/单行上限，并建立 Watch
共享可注入 Clock/TimeZoneResolver 基座，关闭 Entry Gate 的长期运行阻塞项。

## 范围与非目标

- **做**：日志 8 KiB 单行、10 MiB 文件、10 文件/14天清理；受控文件名匹配；Clock/TimerHandle/
  TimeZoneResolver 接口及假时钟；interval/daily、DST gap/fold 基础计算纯函数。
- **不做**：WatchRule、Scheduler timer、网络、数据库、Feed、UI；不改变既有日志脱敏语义。

## 涉及模块和输入文档

- `src/main/logger.ts` 及测试；新增 `src/shared/watch/clock.ts`/测试。
- 输入：detailed-design §2/§4/§13；threat-model §3.6/§3.8、WRT-16/WRT-18。

## 预计修改文件

- 修改 `src/main/logger.ts` 与其测试。
- 新增 `src/shared/watch/clock.ts`、`clock.test.ts`。
- 若类型出口需要，只允许最小新增 `src/shared/types/watch.ts` 的 Clock 相关类型；D2 接管其余域契约。

## 实施步骤（红→绿）

1. 红：临时目录测试证明旧 logger 超过上限不滚动、旧文件不清理；Clock 模块不存在。
2. 绿：先实现严格文件名解析/保留纯函数，再接入 init/日期切换/写前滚动；实现 Clock 与 TimeZoneResolver。
3. 覆盖 UTF-8 行、surrogate、清理失败、重复 init/dispose、DST/回拨/非法 timezone。
4. 全量验证；扫描日志正文/Key/URL query 零回归。

## 验收标准与测试

- 精确边界 `==` 可写、`>` 滚动/截断；不得删除非受控文件或目录。
- 14天与10文件同时生效，排序确定；失败安全记录且无递归 logger。
- daily gap 取首个有效 instant、fold 取较早 instant，同 logical date 只一次。
- `npm test -- --maxWorkers=1`、typecheck、lint、format、build、diff-check 全绿。

## 完成定义

红→绿证据回填；仅范围内 diff；Reviewer PASS；progress 更新；一个逻辑候选提交，不 push。

## 依赖与停止条件

- 无前置任务；D2/D5 依赖本任务。
- 若必须更换 logger、引入时区依赖、删除未知日志或改变既有日志路径/脱敏合同，停止 REPLAN。
