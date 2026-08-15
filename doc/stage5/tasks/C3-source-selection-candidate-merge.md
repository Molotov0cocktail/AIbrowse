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
- 既有文件零改动。

## 依赖

C1（SourceCandidate 类型）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——合并矩阵（同 canonicalKey 双路径合并
   /不同 scope 不合并/origin 与 page 键空间独立/Sources 与 Search 字段
   合并规则）；provenance 继承（search 命中 trust/priority/lastUsedAt/
   note 恒 null——无 trust 断言）；排序全序（档位 1–5 不可跨档/priority
   不反转档位/lastUsedAt null 末位/canonicalKey+id 收尾确定性/同输入同
   输出）；选定 ≤8；候选 24 溢出裁剪确定性；note 不进 sortKey（仅展示
   字段断言）。
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

## 风险与停止条件

- 排序档位与 Fifth_stage.md §3.2 优先级建议冲突 → 停止并校准本文
  （需求边界不被削弱：档位 1/2 对应「与任务高度匹配的收藏 + 用户备注优先」，
  档位 3 对应官方/primary，档位 4 搜索补充，档位 5 社区——映射需逐条
  对照记录）；
- 需修改 normalizeSourceUrl 或 SearchResult 形状 → 停止并报告。

## 提交边界

单一逻辑提交；不夹带装配胶水。
