# C3 — Source Selection：Sources + Search 候选合并、provenance 与确定性排序

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §4；安全契约
> `doc/stage5/threat-model.md` §3.3（FT-07，provenance 诚实）。

## 目标

落地 SourceSelector 纯函数：Sources 检索 + Web Search 候选**合并**
（同 URL 合并身份 + 保留双发现路径）、provenance 继承（search 命中恒无
trust 断言）、确定性排序（档位不可跨档）与选定裁剪（≤8）——纯核心零
Electron 依赖，可单测。

## 范围与非目标

- **做**：`mergeCandidates`/`buildCandidateSortKey`/`selectCandidates`
  纯函数（normalizeSourceUrl 身份键复用 B2 模块）；Sources 命中字段映射
  （trust/priority/lastUsedAt/note）；Search 结果映射（title/url，snippet
  恒空不参与排序——proposal §8.2）；档位全序（§4.2）；group 过滤路径
  （场景 1「只看 AI Benchmark 分组」：list(groupId) 输入）；
  `MAX_SOURCE_CANDIDATES=24` 溢出裁剪。
- **不做**：实际调用 SourceService/SearchProvider 的装配胶水（C5 接入；
  本任务以纯输入输出测试）；读取/验证（C4）；模型选择意图交互（C5）；
  修改 sources 或 search 既有模块。

## 涉及模块和输入文档

- 新增 `src/main/research/source-selector.ts` + 测试。
- 输入：detailed-design §4；threat-model §3.3；B2 `normalizeSourceUrl`
  （src/main/sources/domain/source-canonical.ts，只读复用）；A4
  SearchResult 形状（search-provider.ts:43，本会话核对）。

## 预计修改文件

- 新增：`src/main/research/source-selector.ts`、
  `source-selector.test.ts`。
- 既有产品代码零改动；契约文档同步（决议 #120–#123）：
  `doc/stage5/detailed-design.md`（§4 重写 + §15 决议 + §13.1 测试表）、
  `doc/stage5/high-level-design.md`（§4.2 三档）、
  `doc/stage5/threat-model.md`（FRT-07 档位表述）、
  `doc/stage5/proposal.md`（§3 场景 2 映射校准）、
  `doc/tasks/progress.md`。

## 依赖

C1（SourceCandidate 类型）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——合并矩阵（同 canonicalKey 双路径合并
   /不同 scope 不合并/origin 与 page 键空间独立/Sources 与 Search 字段
   合并规则/discoveredVia 规范顺序）；provenance 继承（search 命中
   trust/priority/lastUsedAt/note 恒 null——无 trust 断言；畸形 trust
   整体降级 null）；排序全序（三档 1<2<3 不可跨档/priority 不反转档位/
   group-list 才按 priority 降序 + lastUsedAt 降序 null 末位/sortKey
   编码与真实 node:sqlite ORDER BY sort_key 一致/同输入同输出）；note
   映射（作者标签/清洗/截断不拆 surrogate/无空标签/不进 sortKey）；
   candidateId 输入契约（非法与重复 fail-closed）；选定 ≤8；候选 24 溢出
   裁剪确定性。
2. **绿**：实现纯函数；逐用例转绿。
3. 全量回归 + 零既有改动确认。

## 验收标准

- §4.1/§4.2 全部规则单测覆盖（含敌手矩阵：恶意 URL 形态/超长标题/畸形
  trust 输入安全处理不抛异常）；
- 排序键确定性（同输入同输出）；收藏/优先级不得自动等同可信（档位语义
  断言 + 注释说明）；
- 纯函数零副作用零 Electron import。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0。

## 完成定义

红→绿证据回填 + 全量验证全绿 + diff 终检 + progress.md 更新 + 一个逻辑
提交（feat: C3 …）+ 双远程推送。

## 红→绿证据（2026-08-16，C3 闭环）

- **红态**：`source-selector.ts` 不存在，`source-selector.test.ts`
  （A–I 组 + SQLite probe 共 80 用例）import 失败——`Cannot find module
'./source-selector'`（1 file failed / 0 tests）。
- **绿态**：实现纯函数后逐用例转绿，最终聚焦 **80/80**、全量 test
  **1598/1598**（1518 + 80，64+1 文件）+ typecheck/lint/format:check/
  build/diff-check 全绿 + dev/生产冒烟（含 B8 红队矩阵 SRT-01～SRT-12
  与 AI 共读矩阵）退出码 0。
- 实施中途修复的测试夹具缺陷（非实现缺陷）：fixture 默认 sourceId 非
  UUID 形状（sourceId 契约校验按 §4.3 丢弃条目——预期行为被夹具触发）、
  预算组生成的 candidateId 长度 12 位 hex 超形状、sortKey 断言未考虑
  candidateId 收尾差异——均为测试自身修正。
- 真实 node:sqlite probe（本文件专属测试设施）：三档混合 8 候选经
  `ResearchRepository.insertCandidate` 写入真实 research.db 后，
  `listCandidatesByTask()` 顺序与内存 binary 排序（sortKey ASC +
  candidate_id ASC）逐元素一致。
- 既有产品代码零改动（src/main/sources、src/main/ai、src/shared、
  src/renderer、src/preload、research db/domain/repository/store/
  service/workspace、package.json/lockfile 零 diff）；工具注册表保持 17
  （8+4+4+1）。

## 风险与停止条件

- ~~排序档位与 Fifth_stage.md §3.2 优先级建议冲突~~ **已关闭（决议
  #120）**：三档发现路径排序为裁决结果——Fifth_stage §3.2 是选择策略
  建议，C3 在不修改冻结 Sources 契约的前提下，通过 source-search 上游
  排序、group 限定、Search 补充及 C5 有界调整实现；需求边界不被削弱
  （tier 1 对应「与任务高度匹配的收藏 + 用户备注优先」，tier 2 对应
  「只看某个分组」，tier 3 对应搜索补充；官方/primary/community 的进一步
  选择与构成控制由 C5 有界计划调整和 C6 sourceTypes/交叉核验承担）；
- 需修改 normalizeSourceUrl 或 SearchResult 形状 → 停止并报告。

## 实施前复核项（2026-08-16 已裁决 → 决议 #120–#123，detailed-design §15）

> 2026-08-16 C3 闭环实施前对以下四项做契约裁决（先改详细设计与本文、再写
> 红测、最后实现——§15 流程）：

1. **§4.2 五档条件互相覆盖 → 决议 #120 三档发现路径排序**：旧五档废止
   （档位 3/5 对合法 merge 输出不可达），改为互斥、可达的发现路径档位——
   tier 1 source-search（保留 SourceService 输入顺序）/tier 2 group-list
   （priority 降序、lastUsedAt 降序、scope/canonicalKey/id 收尾）/
   tier 3 web-search（保留 Provider 顺序，trust/priority/lastUsedAt/note
   恒 null）；同身份合并采用 Sources 档位与字段 + 双 discoveredVia；
   trust 仅 provenance 元数据不改变基础排序；档位可达性测试已列入红→绿。
2. **note 映射规则 → 决议 #121**：group-list/search-only 候选 note=null；
   source-search 按「用户备注：…」/「AI 备注：…」作者标签 + 换行连接 +
   NFC/trim/控制·bidi 清洗 + 标签·换行·正文共同计入
   MAX_CANDIDATE_NOTE_CHARS + 截断不拆 surrogate pair + 第二段预算不足
   不得留下无正文标签；note 不进 sortKey、不进入模型上下文。
3. **candidate_id 生成契约 → 决议 #122 输入契约**：C3 纯函数不生成 id；
   C5 调用方预分配 candidateId（小写 RFC 4122 UUID 形状、全局唯一）；
   非法/重复 ID → 整次 merge fail-closed；同身份合并采用 Sources 条目
   candidateId；不同 task 每次生成新 UUID 避免全局主键冲突。
4. **sortKey 字典序与降序矛盾 → 决议 #123 编码**：
   `TT|RRRRR|P|I|S|canonicalKey|candidateId`——tier 两位/输入 rank 5 位
   补零（group-list 固定 99999）/priority 补码（6−p，null=9）/ISO 时间
   规范化 UTC 后数字反转（null=`~`×24）/scope 0|1/canonicalKey ASCII/
   小写 UUID；原始二元 `<` 比较与 SQLite BINARY 排序一致；真实
   node:sqlite 测试证明内存排序 === listCandidatesByTask() 顺序。

## 提交边界

两个逻辑提交（裁决文档先行、实现随后）；不夹带装配胶水。
