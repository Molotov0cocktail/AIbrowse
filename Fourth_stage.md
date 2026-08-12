# Fourth_stage.md — Sources 信源库与 AI 自然语言管理

> 前置阶段：`Third_stage.md`  
> 核心目标：把传统浏览器“收藏夹”升级为可被 AI 理解、检索、自动维护的长期信息源系统。

## 1. 阶段定位

本阶段建立：

**Sources = URL + 分类 + 标签 + 优先级 + 用户自然语言备注 + AI 元数据 + 使用状态**

用户不应被迫逐项填写表单。

核心体验：

> “这个网站以后查大模型 benchmark 时优先看。”

AI 应理解为长期信源指令，并在安全规则允许时创建/更新 Source。

---

## 2. Entry Gate

要求：

- Browser Agent 已有稳定 `open/read/search` 工具；
- Tool Registry 与权限系统稳定；
- 当前项目已明确哪些本地数据需要持久化；
- 第一至三阶段无阻塞级安全问题。

---

## 3. 本阶段目标

### 3.1 SQLite 持久化层

引入 SQLite 及 migration 机制。

需要建立 Repository / Service 边界，禁止 UI 或 Agent 直接执行 SQL。

具体 schema 在本阶段详细设计中定稿。

概念实体至少包含：

- Source
- SourceGroup
- Tag
- SourceTag relation
- SourceUsage / health metadata（是否单独表由设计决定）

### 3.2 Source 基本字段

概念上需要表达：

- id
- name
- url / canonical domain
- group
- tags
- user_note
- ai_note
- priority
- enabled
- created_by
- created_at
- last_used_at
- last_success_at
- health/status

字段可根据实际需要调整。

### 3.3 用户自然语言备注

用户可添加：

- “关注 XX 行业时优先看这里。”
- “这个网站适合看 benchmark，但厂商声明仍要回官方核验。”
- “只用来查看日本中古市场价格。”
- “这是我的学校教务相关网站。”

备注属于长期 AI 指令的一部分，但：

- 不能覆盖系统安全规则；
- 不能自动提升 Tool 权限；
- 应明确标记来源是用户备注还是 AI 推断。

### 3.4 AI 自动添加/修改信源

支持自然语言意图，例如：

- “收藏这个网站。”
- “这个站以后查 AI 模型价格时优先。”
- “把这三个网站放进‘AI Benchmark’。”
- “以后不要再优先用这个站。”
- “把这个来源标成官方来源。”

Agent 使用受限 Source Tools，例如概念上：

- `source.search`
- `source.list`
- `source.get`
- `source.add`
- `source.update`
- `source.move`
- `source.tag`
- `source.disable`

删除应采用可撤销/软删除策略，或要求确认。

### 3.5 Source Retrieval

建立信源检索能力。

第一版优先：

- SQLite 索引 / FTS；
- name/domain/group/tag/user_note/ai_note 检索；
- 简单 priority / recency 排序。

**本阶段默认不引入向量数据库。**

只有实际证明 FTS 无法满足需求，才在后续设计中考虑 embedding。

### 3.6 Sources UI

至少支持：

- 分组浏览；
- 搜索；
- 查看备注和标签；
- 手工添加/编辑；
- 查看最近使用/健康状态；
- 从当前网页快速添加 Source。

AI 自动操作和手工操作应落入同一 SourceService。

---

## 4. Source Trust 与类型

可以在本阶段引入可扩展元数据，例如：

- official
- primary
- secondary
- community
- unknown

以及用途标签：

- news
- benchmark
- docs
- academic
- price
- forum
- blog

但不要把类型设计成无法扩展的大枚举。

AI 生成的 trust/type 只能作为元数据，不应被视为事实真理。

---

## 5. 非目标

本阶段不做：

- 完整 Research 报告流水线；
- 自动多源交叉核验；
- 图表系统；
- RSS 抓取；
- 网页定期刷新；
- Watch / Diff；
- 云同步；
- 多设备同步；
- 大规模 embedding/vector DB。

---

## 6. 数据安全与隐私

- Source URL、备注可能包含敏感信息，应视为用户数据；
- 不把整个 Sources 数据库默认发给模型；
- 只检索和发送当前任务相关的少量 Sources；
- 日志不得记录完整私人备注；
- 数据库 migration 必须可回滚或至少有明确恢复方案；
- 删除/禁用语义必须明确。

---

## 7. 关键体验验收

1. 当前网页中说：“以后查 AI benchmark 优先看这个站。”
2. AI 自动生成合理 name/group/tag/note，用户可立即撤销。
3. 新对话问：“我有哪些 AI benchmark 来源？”
4. Source Search 能找到之前的站点。
5. 用户说：“把它改到日本购物组，并备注只用于中古价格。”
6. 变更正确持久化。
7. Browser Agent 可以打开 Source Search 返回的网站。

---

## 8. 测试重点

- migration；
- canonical URL / duplicate detection；
- FTS；
- group/tag relation；
- AI 添加重复 Source 时合并/提示策略；
- 用户备注与 AI 备注来源分离；
- 删除/撤销；
- DB 异常；
- Source Tool 权限；
- 不把全部数据库泄漏进 prompt。

---

## 9. 验收标准

### Storage
- [ ] SQLite 与 migration 稳定
- [ ] Source CRUD 走 Service/Repository
- [ ] 重启后数据保留

### Sources
- [ ] 可分组、标签、备注、优先级
- [ ] 可手工管理
- [ ] 可自然语言让 AI 添加/修改
- [ ] 可搜索长期信源

### AI
- [ ] Agent 能优先检索相关 Sources
- [ ] Source 用户备注能影响检索/使用策略
- [ ] 用户备注不能突破安全政策

### Engineering
- [ ] migration / FTS / SourceService 有自动测试
- [ ] 全量验证通过
- [ ] 数据库失败有可诊断日志

---

## 10. Exit Gate

进入 Fifth Stage 前：

- Source 系统在真实使用中可稳定保存、搜索和修改；
- 重复 URL、canonicalization、删除语义已明确；
- Agent 使用 Sources 时不会一次把整个数据库塞给模型；
- 备注与权限边界明确；
- FTS 是否足够已由实际使用验证。

完成后停止，不直接实现 Research。
