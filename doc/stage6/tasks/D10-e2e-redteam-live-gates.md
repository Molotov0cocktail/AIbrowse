# D10 — Watch 端到端、红队、跨进程、真实条件与打包通知资格矩阵

## 目标

建立第六阶段完整机器验证闭环：Feed/Page→Baseline→Diff→Condition→Event/Evidence→Digest→Notification/UI，
WRT-01～WRT-19 独立红队，隐私字节扫描，跨进程恢复，少量真实网络/Provider 和 Windows 打包通知资格。

## 范围与非目标

- **做**：`AIBROWSE_WATCH_SMOKE=set|check`；dev+production 受控场景；19项红队；Entry/Exit体验映射；
  实际公开 RSS/Atom/robots/redirect；真实 Provider 有条件台账；Windows identity 有条件观察；长时资源探针。
- **不做**：以真实公网替代确定性 oracle；以 FakeProvider 冒充真实；绕 robots/captcha；为通过矩阵放宽契约；
  无界高频或大量真实请求。

## 涉及模块和输入文档

- `src/main/smoke-watch-*.ts`、`smoke.ts/index.ts` 最小门控接线、仓库外 live harness 扩展（不提交）。
- 输入：detailed §15；threat-model §6/§7；Sixth §7–§10；D1–D9 验收记录。

## 预计修改文件

- 新增 Watch smoke manifest/redteam/scan/live/gate/runner 模块与测试；smoke/index 只追加门控入口。
- 受控夹具进临时目录或源码小常量；不得提交真实用户数据、凭据、日志、截图、数据库或机器路径。

## 实施步骤（红→绿）

1. 红：manifest 列出 WRT-01～19/§7/§9 场景，旧结构逐项“未实现”失败；隐私允许面/禁止面先冻结。
2. 绿：逐项独立夹具/断言；端到端 cohesive 场景；跨进程 set/check；恢复/清理/资源矩阵。
3. 无 Key/非法门控/互斥路径证明请求0、进程/临时目录零残留。
4. 真实 Provider 按长期授权且凭据可用时运行最小 Digest 场景；记录次数/用途/结果分类；不可用写凭据不可用。
5. 真实公开网络限量，记录 URL 类别/HTTP 结果，不持久化正文；Windows identity 条件不足记 NOT RUN。
6. 全量、所有历史冒烟门控、隐私/Key/垃圾文件/依赖/工具/SQL红线扫描。

## 验收标准与测试

- WRT-01～19 每项有独立机器结果，结构性证明/真实观察/诚实限制分栏。
- Sixth §7 七项体验、§9 全项、§10 五项均映射到当前 HEAD 证据或明确未满足，不能选择性跳过。
- Watch 跨进程恢复、退出停止、一次 catch-up、Source hard-delete、Evidence 双侧、Digest 降级可重复。
- dev+production、全量 test/type/lint/format/build/diff、历史 Session/Sources/Research 门控零回归。

## 完成定义

证据回填本任务/threat-model；独立安全 Reviewer PASS；逻辑提交；仍不判 Stage Exit Gate（归 D11）。

## 依赖与停止条件

- 依赖 D1–D9；D11 依赖本任务。
- 红队发现产品缺陷即 REPAIR/REPLAN；真实站点变化不得放宽确定性断言；Key/打包身份/网络不可用如实 NOT RUN。
