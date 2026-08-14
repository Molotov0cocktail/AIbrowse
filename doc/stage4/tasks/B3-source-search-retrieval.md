# B3 — 多语言 Source Search + 有界 Retrieval + 分享模式

> 第四阶段任务文档。契约源 `doc/stage4/detailed-design.md`（§8 有界 Retrieval/
> 分享模式/多语言检索 + §5 FTS 表）。

## 目标

落地 Source Search 与有界 Retrieval：FTS5/trigram 主路径（B1 实测冻结可用时）、
参数化精确匹配/LIKE 安全降级路径（完整交付实现）、确定性排序器、返回 allowlist、
分享模式过滤（full/metadata/blocked）、诊断性 rebuild 入口（内部，UI 归 B7）。

## 前置依赖

- B2（Repository/SourceService/schema v1，含 sources_fts 表）。

## 契约裁决（2026-08-15 实施前硬停点，六项冲突用户裁决，决议 #58–#63）

实现前逐项核验发现的设计缺口与裁决结论（详细设计 §15 决议 #58–#63 已同步）：

1. **读取视角**（决议 #58）：search/list/get 增加**必填** `audience: 'user' |
'agent'`（无缺省）——agent 视角 blocked 完全不可见（search 不命中/list 不
   列出/get 视同不存在）、user 视角 blocked 可见可管理；B4/B5 主进程适配器硬
   编码，模型参数与 renderer 原始 payload 均不能自行选择；
2. **搜索条目类型**（决议 #59）：新增 `SourceSearchItem` + `SourceSearchNote`
   摘录类型（note 只在该类型出现）；`SourceListItem` 永不含 note；
   `SourceSearchResult.results` 改为 `SourceSearchItem[]`；
3. **短查询语义**（决议 #60）：1 字符仅精确；2 字符精确+前缀+参数化字面子串
   LIKE（中文 2 字符子串经降级路径诚实交付，**不声称 trigram 原生支持两字
   符**）；≥3 字符 FTS trigram（仅 ≥3 字符 token 参与短语包裹）；URL 查询确定
   性判定集合 = normalizeSourceUrl 可解析或 http(s):// 前缀；
4. **排序全序**（决议 #61）：档位严格不可跨档（priority 不得反转档位）；
   priority/recency 仅同档内；lastUsedAt=null 恒排最末；scope + canonicalKey
   - id 收尾（origin/page 同键也全序）；
5. **FTS 不可用范围**（决议 #62）：仅指建库成功后 MATCH/构造失败 → 参数化降级；
   不承诺无 FTS5 构建可完成迁移（schema v1 冻结不改写）；
6. **B-04 分段**（决议 #63）：B-04 记录为 B3/B4 分段完成——B3 只做数据库/
   Service 子集（多语言/上限/分享模式/note 清洗/rebuild）；SOURCE_TOOL_CONTENT_
   MAX=4000、ToolResult 序列化、UNTRUSTED_TOOL_RESULT 接线与审计为 B4 待完成。

另核验属实并在本任务修复：`stripControlChars` 未覆盖 U+061C、U+2066–U+2069
（bidi 隔离控制符）——补齐 + 读取侧防御性清洗 + 敌手测试（不得只依赖写入时
清洗；旧数据/损坏数据同样覆盖）。

## 范围

- source-search-query.ts 纯函数：查询归一化（trim/NFC/控制字符剔除/码点计
  数）、分流判定（1 字符精确 / 2 字符精确+前缀+子串 / ≥3 字符 FTS / URL 查
  询，决议 #60）、FTS 查询串构造（短语包裹 + 双引号转义，只作数据，短 token
  过滤）、LIKE 模式构造（转义 \ % _）、确定性档位计算（决议 #61 全序）、note
  摘录构造（≤200 码点截断 + 控制/bidi 剔除）；
- source-search-index.ts（Repository 层）：候选集查询（四条编译期常量 SQL +
  参数绑定 + 有界候选 200）、FTS 可用性判定、FTS 不可用降级（决议 #62）、
  诊断性 rebuild 与主表/FTS 一致性校验（失败不破坏现有索引）；
- SourceService.search 完整实现（默认/硬上限 10、audience 过滤与分享模式、
  allowlist、agent+full 命中附有界 note + provenance）；
- SourceService.list 分页实现（每页 ≤20、agent 视角 blocked 不列出、无 note）；
- SourceService.get 按 audience（agent：blocked 视同不存在、metadata 无 note
  字节；user：恒完整视图）；
- 多语言实测断言：中文（≥3 FTS 主路径 + 2 字符降级路径）、日文假名/汉字、
  英文词与子串、混合查询；大小写语义如实登记（FTS/= 区分大小写、LIKE ASCII
  不区分大小写）；
- B-04 B3 子集冒烟（默认矩阵，dev+production 双场景真实 node:sqlite）。

## 非目标

- Source Tools/权限/审计接线与 ToolResult 预算/UNTRUSTED_TOOL_RESULT 块
  （B4，决议 #63）；UI（B5）；向量数据库（永久非目标）；检索结果之外的任何
  导出通道；改写 B2 的 FTS 写同步（B3 只补查询/rebuild/一致性测试）。

## 涉及模块

`src/main/sources/domain/source-search-query.ts`、`src/main/sources/repository/
source-search-index.ts`、`src/main/sources/source-service.ts`（search/list/get
完整实现 + audience）、`src/shared/types/sources.ts`（SourceReadAudience/
SourceSearchItem/SourceSearchNote + 接口签名）、`src/main/sources/domain/
source-change-set.ts`（stripControlChars bidi 补齐，仅此一处）；单测
source-search-query.test.ts/source-search-index.test.ts + service/change-set
测试扩展；冒烟 B-04（B3 子集，smoke.ts/index.ts 最小接线）。

## 红态测试（先红后绿）

- FTS 查询构造：引号/通配符/操作符（AND OR NOT NEAR * ^ 数字）/SQL 片段输入 →
  输出不含原始语法、短语包裹转义正确、只作数据；短 token 过滤与空 token；
- 归一化与分流判定矩阵：trim/NFC/码点计数/1–2–3 字符边界/URL 判定集合/空与
  纯空白/500 边界；
- 排序器：全序（同输入同输出）、档位不可跨档、priority 上下界、lastUsedAt
  null 末位、origin/page 同 canonicalKey 收尾、各域优先级；
- 分享模式 × audience 完整矩阵：blocked 完全不命中/不列出/get 视同不存在
  （agent）vs 可见可管理（user）；metadata 命中零 note 字节（含 note 不参与
  命中）；full 命中 note 有界 + provenance 字段分离；
- note 摘录：200/201 码点边界、C0/换行/零宽/U+061C/U+202A–U+202E/
  U+2066–U+2069 剔除、双空 → null；
- 索引一致性：add/update/disable/restore/undo/rollback 后 FTS 与主表一致
  （B2 路径回归，不重写）；rebuild 行数与内容一致、rebuild 失败不破坏现有
  索引；FTS 可用性判定与降级（决议 #62）；
- 注入串在 FTS 与 LIKE 两条路径均只作数据（SRT-04 断言先行）；
- 多语言命中矩阵（中文/日文/英文/子串/混合）——trigram 语义下如实断言；
- disposed/句柄关闭/数据库不可用安全返回 source-unavailable 不伪装成功。

## 实现步骤

1. shared 类型 + source-search-query 纯函数（红→绿）；
2. stripControlChars bidi 补齐 + 敌手测试（红→绿）；
3. source-search-index 候选查询/FTS 判定/降级/rebuild（红→绿）；
4. SourceService.search/list/get 完整实现（audience/分享模式/allowlist/note
   规则，红→绿）；
5. 多语言实测矩阵（真实 node:sqlite，dev+生产）；
6. 冒烟 B-04 B3 子集（默认矩阵；注入串只作数据断言先行；块隔离回归属 B4）；
7. 全量验证 + 文档同步。

## 红→绿证据（2026-08-15 已回填，B3 完成）

- **红态（先写测试，旧结构下真实失败）**：全量 test 4 files failed / 16 failed /
  955 passed——2 个新测试文件「Cannot find module」（source-search-query/
  source-search-index）+ 8 个 service B3 行为断言在 B2 实现下**真实失败**
  （audience 被忽略：`{ok:true,query:'q',results:[]}` 而非 invalid-change；
  agent 视角 blocked 搜索命中泄漏；`note` undefined；中文 2 字符 '测试' 在
  B2 LIKE 前缀语义下不命中；档位排序在 B2 created_at 排序下失败（note 命中
  条目不在结果集 indexOf=-1）；agent list total 4 而非 3）+ bidi 敌手 8 例
  （`expected 'xyzy' received 'xy⁦z⁩؜⁧y'` 等真实形态失败——U+061C/U+2066–
  U+2069 未被剔除）；typecheck 红（audience 必填契约 + 新类型缺失）。既有
  947 用例零删除零削弱（audience 为机械校准 + 语义保留 + 隐私断言新增）。
- **绿态**：全量 test **1007/1007**（新增 60：source-search-query 23 /
  source-search-index 13 / source-service B3 14 / source-change-set bidi 10——
  9 敌手 case + 1 幂等），typecheck/lint/format:check/build 全绿。
- **实现期修正（如实登记）**：实现侧真实缺陷 2 处——① 一致性校验原设计为
  COUNT 比对，实测 SQLite 3.53.1 FTS5 外部内容表语义下 COUNT(_)/全表扫描
  **读取内容侧**（索引滞留行在查询期被 FTS5 自动忽略、计数不可见）——改为
  逐行 MATCH 回查探针检出「内容有行、索引缺行」方向（搜索漏命中），滞留方向
  如实登记由 rebuild 清除；② 档位测试夹具默认 tag 与查询词相撞、'ENCHMARK'
  为 'Benchmark' 大小写不敏感子串、'OR'/'--'/'_'/'^' 为短 token 被过滤、
  '基准' 实为 2 字符——均按契约修正测试，无实现迁就（FTS 分流语义以码点计数
  为准）。**新增实测事实**：trigram 短语对 '.com' 等符号子串正常命中；
  origin/page 同 canonicalKey 在决议 #50 语义下实际不可达（page 键恒带 '/'）——
  全序收尾的 scope 三元组由纯函数单测覆盖 + 服务层以同源键族实测确定性排序。
- **冒烟**：默认完整 dev 矩阵退出码 0（B-01 + 8.9 B-04 B3 子集：中/日/英命中 +
  短查询降级 + 分享模式矩阵 + 硬上限 10 + URL 查询 + 注入串 + rebuild 一致性，
  真实 Electron 内置 node:sqlite/FTS5/trigram）；默认完整生产矩阵退出码 0
  （同矩阵，out/ 产物运行）；**B-02 生产双进程** set/check 退出码 0（共用同一
  预先核验位于系统 TEMP 下的独立 userData；check 增「重启后经 B3 检索命中
  s1」证据，B-02 原有断言零改动）。SOURCE_TOOL_CONTENT_MAX=4000/ToolResult
  序列化/UNTRUSTED_TOOL_RESULT 块接线/审计明确标注 B4 待完成（决议 #63），
  本任务不宣称 B-04 全过；工具注册表保持既有 13 个。

## 验收标准

- detailed-design §8（决议 #58–#63 校准后）全部落地并有单测 + 冒烟证据；
- 多语言矩阵通过（FTS 可用时）；1–2 字符短查询降级路径为完整交付且如实登记
  （不声称 trigram 原生支持两字符）；
- SRT-04（注入）与 SRT-08（泄漏）相关断言先行可用（B8 汇总裁决）；
- 检索本地完成（无整库外发通道，grep 断言）；
- B-04 B3 子集 dev+production 双场景退出码 0；SOURCE_TOOL_CONTENT_MAX/ToolResult
  序列化/UNTRUSTED_TOOL_RESULT 接线/审计明确标注 B4 待完成（决议 #63），不宣称
  B-04 全过；工具注册表保持既有 13 个。

## 全量验证

`npm test` · `npm run typecheck` · `npm run lint` · `npm run format:check` ·
`npm run build` · dev+生产双场景冒烟（默认矩阵含 B-04 B3 子集）+ B-02 双进程
（共用同一预先核验的系统 TEMP userData）· diff 终检 · 敏感信息扫描。

## 提交要求

一个或少量逻辑 commit；提交信息 `<type>: <中文描述>`；不提交临时数据/日志。

## 完成定义

验收标准全绿 + progress 任务表 B3 ✅ + 双远程推送；契约偏差先校准文档与测试。

## 风险与停止条件

- trigram 实测表现（中文 1 字符/日文单字）不满足检索目标 → 不停止，降级路径
  兜底并如实登记限制（宁缺勿错）；
- 排序/allowlist 与 §8 契约冲突 → 回设计流程校准（决议记录），不得私自放宽
  （如提高硬上限 10、默认返回 note）；
- FTS 与主表一致性断言失败（B2 同步路径回归）→ 先定位 B2 同步缺陷，不重写
  B2 已冻结路径，修复前不提交。
