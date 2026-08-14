# A4 SearchProvider 与 search.web 工具（可验证闭环）

- **目标**：SearchProvider 接口 + v1 Bing 搜索页实现（临时可见 Tab → ready →
  实时快照 → 确定性解析 → 关闭 Tab）；统一结果结构（title/url/snippet/source）；
  search.web 工具注册（L0，query 校验 ≤ 500）。
- **输入文档**：doc/stage3/detailed-design.md §6/§4.2（search.web 行）；
  doc/stage3/proposal.md Q3/Q11。
- **范围**：search-provider.ts（接口 + Bing 实现 + 解析纯函数
  parseBingSearchResults）；结果过滤（非 http/https 丢弃、引擎自身链接丢弃）；
  降级语义（解析失败/结构变化 → 空结果 + warnings + search-failed，不抛异常）；
  search-tool.ts executor（经注入 SearchProvider）；单测覆盖解析矩阵
  （正常快照/结构不符/空 links/畸形 URL/超长截断）。
- **非目标**：**严禁搜索 API/新依赖/新 Key**（v1 页面实现）；不持久化搜索结果；
  不改 shared/url 的 SEARCH_ENGINE_URL 常量语义（SearchProvider 引用它）；
  无 UI 改动（A6）；Agent Loop 不在此任务（A5）。

## 涉及文件（实施后校准）

- 新增：`src/main/ai/search/search-provider.ts` + `.test.ts`（解析纯函数 + 生命周期
  所有权矩阵）、`src/main/ai/tools/search-tool.ts` + `.test.ts`（工具常量/executor/
  ToolExecutor 管线）。
- 修改：`src/main/index.ts`（SearchProvider 生产装配与 search.web 注册）、
  `src/main/smoke.ts`（8.1 校准注册表 13 工具 + 8.3 受控搜索页生命周期场景 +
  可选公网探针）、`src/main/ai/tools/tool-types.ts`（ToolExecutionContext.
  searchProvider 注入点，设计 §4.1 落点）、`src/main/ai/audit-log.ts` + `.test.ts`
  （search.web query 全量审计——决议 #32⑤，T-03 外发审查可追溯）。

## 实施步骤

- [x] 红：解析纯函数矩阵用例（正常/结构不符/空/畸形/截断）+ 生命周期所有权矩阵
      （红态证据：2 files failed 模块不存在；实现后 42/42，夹具断言 3 处修正为
      测试自身缺陷——空结构解析层保持沉默、活动 Tab 已关闭模拟需持续过滤、
      审计摘要截断断言按「值级 ≤200」语义校准后随决议 #32 改为全量断言）
- [x] 实现 SearchProvider 接口 + Bing 实现（临时 Tab 生命周期 try/finally 保证关闭；
      精确 tabId 所有权/恢复语义/并发隔离——8 条规则落地，见 search-provider.ts 头注释）
- [x] 实现 parseBingSearchResults 纯函数（容忍设计；Bing 自身域+非结果标签过滤；
      ck/a 包装链接确定性还原；snippet 恒空串 + warning）
- [x] 实现 search-tool.ts + 注册装配（L0；ctx.searchProvider 优先于注册注入）
- [x] 冒烟：受控页面搜索流程断言（Tab 创建/解析/关闭/结果结构/活动 Tab 恢复/
      合法空结果 vs 结构无法识别/审计恰好一条）；公网 Bing 探针成功
      （10 条真实结果，938ms，AIbrowse 完整生产链路）
- [x] 全量回归 → 提交推送 → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）：test 576/576（533 基线 + 43 新增：
  search-provider 28 / search-tool 14 / audit-log 1——search.web query 全量审计）、
  typecheck / lint / format:check / build 全绿；Electron 冒烟 dev + 生产双场景
  退出码 0（含 8.3 搜索生命周期场景）。
- 红线 grep：diff 无新依赖、无万能工具、无 Key 形态、新代码零 Electron import、
  UI/preload/IPC/SYSTEM_PROMPT/package 零改动。
- 决议 #32 契约校准已同步：detailed-design §6.2/§10.1/§15、high-level-design、
  本文件、progress.md。

## 完成定义

- 单测全绿；全量回归通过；冒烟退出码 0；搜索降级路径有断言（空结果非崩溃）；
  progress.md 标记 A4 ✅ 并推荐 A5。

## 计划内限制登记

- **snippet 恒空串**（决议 #32③）：v1 扁平快照无法为每条结果提供可靠关联证据，
  不得把相邻但无依据的文本错误配给结果（宁缺勿错）；未来供应商实现可自带摘要。
- **Bing 非结果标签精确匹配过滤**：与标签完全同名的合法结果标题会被一并过滤
  （宁简勿误配）。
- **结构识别依赖内容性证据**：空内容快照 → search-failed；有内容无有机结果 →
  合法空结果（页面结构变化与确实无结果无法进一步区分，warnings 如实说明）。
- **公网 Bing 探针实测形态（2026-08-14）**：当前主要返回直接目标 URL（10 条
  b_algo），ck/a 包装规则为确定性兜底（两形态均覆盖单测与冒烟夹具）。
