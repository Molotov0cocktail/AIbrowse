# E2 固定小恢复夹具与语义 oracle

实现契约见 `doc/stage7/tasks.md` 的“后续真实恢复的夹具与语义差量”。
此模块只生成全新合成根并在所有 writer 退出后读取固定数据。没有 Electron、UI、
Job、profile 接管、进程终止、安装或归档能力。来源、失败现场和机器输出保留在
`log/stage7-e2/restore-small-fixtures-001/`；不把纯工具检查称为真实场景 R/P 或 E2 PASS。

## 固定内容

每套三库加会话总计不超过 16MiB。使用当前生产 migrations，固定 prepared SQL，
以及 Research 既有单任务合成 helper；只调用一次 `insertDenseResearch` 后缩小结果表格，
不调用大容量 `prepareFixtures`，不读取真实 profile。DB 文件可能保留 helper 留下的空闲页，
这些页计入物理大小，不用逻辑大小冒充物理预算。

| 集合               | 固定内容                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A/B/H Sources      | 分别 `恢复夹具A/B/H`；一个 page Source，互异 UUID、URL、canonical key                                                                                                  |
| A/B/H Research     | 一个 completed task/result/candidate/capture/evidence；互异主键，非空确定性证据投影与结果表格                                                                          |
| A/B/H Watch        | 一个真实引用同代 Source 的 page rule，版本 1，真实 locator fingerprint                                                                                                 |
| A/B/H Conversation | 一个 index 条目、一个 session 文件、按 user→assistant 顺序的两条固定正文                                                                                               |
| H 历史             | 另一个 running Research；running scheduled Watch run；已消费 slot；active Digest schedule、running cycle、claimed Digest；pending notification；有效旧 Session consent |

UUID 由 `fixtureId` 的固定十六进制后缀构成：A/B/H 基数 10/20/30；Research candidate、
capture、tab、evidence、result 偏移分别为 1000/2000/3000/4000/100，H running task 偏移 50；
Watch observation 偏移 5000；会话及两条消息偏移 9000/9001/9002。
Watch 的 rule/watch-run/event/item/schedule/digest-run/digest/notification 使用各代基数加10000至10007的固定UUID，
并一致生成所有外键、facts中的引用与派生hash/byte_length。旧文本主键能通过持久化scanner但被UI输出UUID门拒绝，
旧源码与三代UI红态保留在 `restore-fixture-ui-repair-001`，当前夹具不再复用该范围旧PASS。
request key 为 `H-consumed-slot`、`H-digest-request`，通知去重键为 `windows|event|<event UUID>|1`。
cursor、journal high-water、cycle upper/next 均为 1；lower 为 0；revision/claim revision 为 1，
blocked budget 三列均 null；声明 byte_length 等于真实固定 artifact UTF-8 字节数。

H 的采集 rule 固定为用户 paused、desired_enabled=0，仍保留真实 running 历史 run、
已消费 slot 和旧 Session consent。这样防止新的合法定时采集污染读回。Digest schedule
仍为 active，cycle running、Digest claimed、通知 pending；不能把 rule paused 本身当作
不重放证明。恢复必须逐项改变旧危险状态，完整保留 cursor、slot、claim、预算、去重键。

## Oracle 与允许变化

`oracle.ts` 为所有业务表使用固定 SELECT，包含应为空的关联表；按完整列、完整有序行集合
做规范 JSON SHA-256 比较。`expected.ts` 是源码冻结的每表摘要，运行时绝不从待测 profile
学习预期。摘要同时约束全部主键、关联、正文和计数；没有 `COUNT>0` 判据。
生产 schema/三域业务/跨库 scanner、integrity 与 foreign-key 检查先通过。
FTS 内部派生页不按字节冻结；schema 与 Sources scanner 仍检查其结构。
会话文件集合严格闭合，index/session 原始 JSON 也参加固定摘要，额外字段或文件拒绝。

- `source`：所有业务字段必须精确等于该套冻结值；H 危险历史必须仍存在。
- `restored`：A/B 与 source 相同。H 仅允许下表变化，先断言变化合法，再映射回 source
  进行完整集合摘要比较。其它字段都不允许变，包括历史 claim、slot、cursor、attempts、预算。

| H 字段                                                  | 恢复后必须为                               |
| ------------------------------------------------------- | ------------------------------------------ |
| running Research status/phase/interrupted_at/updated_at | interrupted/null/本批时间/同一时间         |
| Watch run status/finished_at                            | interrupted/本批时间                       |
| Digest provider_state/result_code/finished_at           | uncertain/uncertain-after-restart/本批时间 |
| Digest schedule state/version/updated_at                | paused/2/本批时间                          |
| notification state/attempts/updated_at                  | failed/0/本批时间                          |
| rule target.sessionConsent/updated_at                   | null/合法规范化时间                        |

时间须是规范 ISO UTC，且不早于旧 claim 的 `2026-10-10T01:00:00.000Z`。除 rule.updated_at
由现 Repository 自己取钟外，上表各本批时间必须完全相同。普通冷启动若没有业务修改，应
再次通过同一 restored oracle；纯测试对二次生产 migrate 还断言完整业务快照完全相等。
没有给普通启动“任意时间字段可变”的豁免。未来保留期、主动阅读事件、编辑或新采集改变业务
时须先调整场景与正式合同，不能自动刷新预期摘要。

## 外部装配接口

- `createSmallFixture(absentRoot, 'A'|'B'|'H')`：只创建原先不存在的根；不覆盖既有文件。
  调用者完成独占新根准入及关闭所有 writer 的资格，创建后立即调用验证接口；失败保留现场。
- `verifySmallFixture(root, variant, mode, layout='profile')`：只读、带 16MiB 总预算；返回字节数
  及实际业务表摘要。`profile` 为 `<domain>/<domain>.db`；`work` 为平铺 `<domain>.db`，
  二者都使用 `conversations/`。不接受活跃 WAL/SHM/journal；不能用它扫描正在运行的产品。
- `readSmallSnapshot` 与 `verifySmallSnapshot`：供独立反例和受控离线投影核对。前者含生产
  scanner，后者只做纯语义 oracle；不能把后者独立当作外部文件准入。
- H 的 `.aibak` 由调用者使用生产 backup pipeline 生成，再用生产 restore pipeline/UI
  消费。必须标注“受控合成备份”；不能冒称健康产品 UI 生成。测试覆盖真实 Node SQLite
  backup→容器→restore 到 work→再次 migrate，不接管产品数据目录。

执行聚焦检查：

```powershell
npx vitest run tools/data-qualification/product-restore-fixtures/fixtures.test.ts --maxWorkers=1
```

测试保留每轮独立目录，含三套 source 全行快照/摘要、H restored 快照、全部失败现场。
甄别性检查包含将完整集合 oracle 替为弱非空判据的 mutation 红态；这不是生产缺陷红态。

## 旧证据的复用范围

`log/stage7-e2/independent-transfer-no-replay-review-001/review-001.md` 仅限原规范化纯模块
及合同：原 active 对照在 `DigestService.resumeActiveCycles` 中确实推进 completed；
规范化 paused 对照零 getNonterminal/零 Provider。其精确 manifest 与 pipeline hash
保留原件。这里复用该调用准入证据，不重授新 actual/PASS，不声称已验证完整 main 的健康
解锁、原生恢复、守护继任或真实冷启动。当前模型 actual 未回显，不可验证。
