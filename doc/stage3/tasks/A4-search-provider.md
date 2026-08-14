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

## 涉及文件

- 新增：`src/main/ai/search/search-provider.ts` + `.test.ts`（解析纯函数）、
  `src/main/ai/tools/search-tool.ts`。
- 修改：`src/main/index.ts`（SearchProvider 装配与 search.web 注册）、
  `src/main/smoke.ts`（搜索冒烟场景：受控搜索页夹具解析断言，可选联网变体）。

## 实施步骤

- [ ] 红：解析纯函数矩阵用例（正常/结构不符/空/畸形/截断）
- [ ] 实现 SearchProvider 接口 + Bing 实现（临时 Tab 生命周期 try/finally 保证关闭）
- [ ] 实现 parseBingSearchResults 纯函数（容忍设计）
- [ ] 实现 search-tool.ts + 注册装配
- [ ] 冒烟：受控页面搜索流程断言（Tab 创建/解析/关闭/结果结构）；无网络时跳过
      联网变体并记录（不作为失败）
- [ ] 全量回归 → 提交推送 → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 A4 行；
  红线 grep：diff 无新依赖、无万能工具、无 Key 形态。

## 完成定义

- 单测全绿；全量回归通过；冒烟退出码 0；搜索降级路径有断言（空结果非崩溃）；
  progress.md 标记 A4 ✅ 并推荐 A5。
