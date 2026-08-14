# B3 — 多语言 Source Search + 有界 Retrieval + 分享模式

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§8 有界 Retrieval/
> 分享模式/多语言检索 + §5 FTS 表）。

## 目标

落地 Source Search 与有界 Retrieval：FTS5/trigram 主路径（B1 实测冻结可用时）、
参数化精确匹配/LIKE 安全降级路径（完整交付实现）、确定性排序器、返回 allowlist、
分享模式过滤（full/metadata/blocked）、诊断性 rebuild 入口（内部，UI 归 B7）。

## 前置依赖

- B2（Repository/SourceService/schema v1，含 sources_fts 表）。

## 范围

- source-search-query.ts 纯函数：FTS 查询串构造（短语包裹 + 转义，只作数据）、
  降级判定（1–2 字符短查询/特殊 URL 片段/FTS 不可用/构造失败）、确定性排序器
  （精确 > 前缀 > tag/group > name/domain > note；priority 有限加分 ±1 档；
  recency 次级 tie-break；canonical_key 全序收尾）；
- source-search-index.ts：FTS 与主表**同事务**同步（add/update/disable/restore/
  undo/rollback 全路径一致性）、rebuild（行数一致校验）；
- SourceService.search 完整实现（默认/硬上限 10、分享模式过滤、allowlist、note
  仅 full 命中少量返回 + ≤200 截断 + provenance + 控制字符剔除）；
- SourceService.list 分页实现（每页 ≤20、blocked 不列出、无 note）；
- 多语言实测断言：中文 2+ 字符子串、日文假名/汉字、英文词与子串、混合查询。

## 非目标

- Source Tools/权限/审计接线（B4）；UI（B5）；向量数据库（永久非目标）；检索
  结果之外的任何导出通道。

## 涉及模块

`src/main/sources/domain/source-search-query.ts`、`src/main/sources/repository/
source-search-index.ts`、`src/main/sources/source-service.ts`（search/list 完整
实现）；单测 source-search-query.test.ts 等；冒烟 B-04（有界检索 + 分享模式 +
注入 note 块隔离）。

## 红态测试（先红后绿）

- FTS 查询构造：引号/通配符/操作符（AND OR NOT NEAR * ^ 数字）/SQL 片段输入 →
  输出不含原始语法、短语包裹转义正确、只作数据；
- 降级判定矩阵：1–2 字符/特殊串/各类边界；
- 排序器：全序（同输入同输出）、各域优先级、priority 有限加分边界、tie-break
  确定性；
- 分享模式：blocked 完全不命中/不列出/get 视同不存在；metadata 命中无 note
  字节；full 命中 note 有界 + provenance 标注；
- 索引一致性：add/update/disable/restore/undo/rollback 后 FTS 与主表一致；
  rebuild 行数一致；
- 多语言命中矩阵（中文/日文/英文/子串）——B1 实测 trigram 不可用则本矩阵以
  降级路径实现并如实登记。

## 实现步骤

1. source-search-query 纯函数（红→绿）；
2. source-search-index 同步与 rebuild（红→绿）；
3. SourceService.search/list 完整实现（分享模式/allowlist/note 规则，红→绿）；
4. 多语言实测矩阵（真实 node:sqlite，dev+生产）；
5. 冒烟 B-04（含敌对 note 夹具：注入文案只作数据、块隔离回归）；
6. 全量验证 + 文档同步。

## 验收标准

- detailed-design §8 全部落地并有单测 + 冒烟证据；
- 多语言矩阵通过（FTS 可用时）；FTS 不可用时降级路径为完整交付且如实登记；
- SRT-04（注入）与 SRT-08（泄漏）相关断言先行可用（B8 汇总裁决）；
- 检索本地完成（无整库外发通道，grep 断言）。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟 · diff 终检 · 敏感信息扫描。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

验收标准全绿 + progress 任务表 B3 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- trigram 实测表现（中文 1 字符/日文单字）不满足检索目标 → 不停止，降级路径
  兜底并如实登记限制（宁缺勿错）；
- 排序/allowlist 与 §8 契约冲突 → 回设计流程校准（决议记录），不得私自放宽
  （如提高硬上限 10、默认返回 note）。
