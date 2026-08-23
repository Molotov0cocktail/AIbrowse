# Sixth_stage.md — RSS、网页 Diff、Watch 与持续信息更新

> 前置阶段：`Fifth_stage.md`  
> 核心目标：让 Sources 从“被查询的静态收藏”升级为“持续更新的信息网络”。

## 1. 阶段定位

本阶段加入：

- RSS / Atom；
- 网页 Snapshot / Diff；
- Source Watch；
- 条件触发；
- 更新摘要；
- 通知 / Digest。

原则：

> 优先使用网站提供的稳定更新机制；浏览器定期读取是 fallback，不是唯一手段。

---

## 2. Entry Gate

要求：

- Sources 数据结构稳定；
- Research 已能可靠读取和归纳来源；
- Evidence 可记录获取时间；
- 浏览器读取失败有明确错误分类；
- 本地持久化、日志和隐私方案稳定。

---

## 3. 本阶段目标

### 3.1 Feed Discovery

对 Source 支持：

- 手工 RSS/Atom URL；
- 页面 feed autodiscovery；
- feed validation；
- feed health。

如果网站有可用 RSS，优先使用 RSS。

### 3.2 Source Watch

用户可以：

- “关注这个页面。”
- “这个站有重要更新时告诉我。”
- “关注这个产品页价格。”
- “这个教授发新论文时提醒我。”

WatchRule 概念至少包含：

- source
- enabled
- schedule/interval
- extraction target
- condition（可选）
- last checked
- last changed
- health

具体 schema 进入本阶段再定稿。

### 3.3 Snapshot / Diff

对无 RSS 的页面：

Fetch/Browser Read
→ Normalized Snapshot
→ Compare Previous
→ Structural / Text Diff
→ Deterministic Condition / Event
→ AI Explanation（可选，不参与相等性、触发或 Evidence 判定）
→ Event

要求：

- 不保存无上限完整历史 HTML；
- 正文/表格等应先规范化；
- 导航、广告、时间戳等高噪声区域应尽量过滤；
- Diff 算法先确定性，AI 用于解释变化，不用于决定“两个字符串是否相等”。

### 3.4 条件监控

允许用户表达：

- “Qwen 进入前三时提醒我。”
- “价格低于 500 时提醒我。”
- “出现新的 release 时提醒我。”
- “这个页面新增招生通知时提醒我。”

条件应尽可能转成结构化规则。

第六阶段 v1 只接受闭合白名单内的确定性结构化规则；无法可靠结构化时必须明确提示
“当前不支持”，不得静默创建 AI-evaluated rule。AI-evaluated rule 延后重新评估，不能影响
v1 的相等性、触发、Evidence 或通知事实。

### 3.5 Digest

支持把多个变化整合为：

- 今日更新；
- 本周更新；
- 某分组更新摘要。

Digest 应区分：

- 重要变化；
- 普通变化；
- 读取失败；
- 无变化。

### 3.6 调度与资源控制

必须设计：

- 最小刷新间隔；
- 并发上限；
- 失败退避；
- 网络离线；
- 应用关闭时行为；
- Windows 后台能力边界；
- 电池/资源消耗。

不要把桌面应用变成高频爬虫。

---

## 4. 站点友好性与访问策略

Watch 必须考虑：

- 官方 API / RSS 优先；
- 合理请求频率；
- robots / ToS 风险提示（具体策略进入详细设计）；
- 登录网站的 session；
- captcha / challenge 时停止自动化；
- 不主动研究绕过反爬。

第六阶段 v1 的公开页面使用隔离的 Node 核心 HTTP + 经资格门批准的流式 HTML parser，
不携带 Chromium Cookie、不执行 JavaScript、不加载页面子资源。需要登录或 JavaScript 渲染的
页面只能由用户逐规则明确切换到 Chromium Session 模式，不允许自动回退或静默复用登录状态。

Source health 应记录：

- rss
- browser
- login_required
- captcha
- parse_changed
- unavailable

---

## 5. 通知

第一版至少可提供应用内通知。

Windows 系统通知可作为本阶段目标之一，但实现前需验证打包身份和 Electron 行为。

通知必须：

- 去重；
- 可静音；
- 可按 Source/Group 关闭；
- 不因无意义的小 Diff 频繁骚扰用户。

---

## 6. 非目标

本阶段不做：

- 云端 24/7 crawler；
- 秒级监控；
- 绕验证码；
- 绕反爬；
- 大规模商业爬取；
- 分布式调度；
- 用户不知情的数据收集。

---

## 7. 关键体验验收

1. 添加带 RSS 的新闻/博客来源，可发现并订阅。
2. RSS 更新后出现在 Source 更新视图。
3. 无 RSS 页面可以正常 Snapshot/Diff。
4. “价格低于 X”类结构化规则可触发。
5. 页面结构变化导致提取失败时显示 Source Health，而不是生成错误结论。
6. 多 Source 生成每日 Digest。
7. 重复内容不会连续通知。

---

## 8. 测试重点

- feed parser；
- duplicate entries；
- scheduler；
- retry/backoff；
- snapshot normalization；
- diff noise；
- WatchRule；
- time zone；
- app restart；
- notification dedupe；
- Source disabled；
- captcha/login failure；
- 页面结构变化。

时间相关逻辑应尽可能使用可控 clock 进行测试。

---

## 9. 验收标准

### RSS
- [ ] 可发现/添加/读取 RSS 或 Atom
- [ ] feed 去重和 health 正常

### Watch
- [ ] 无 RSS 页面可定期检查
- [ ] Diff 可识别实际变化
- [ ] 失败不会制造假变化

### Rules
- [ ] 支持至少一类结构化条件
- [ ] 规则触发有 Evidence

### Digest
- [ ] 可按分组生成更新摘要
- [ ] 区分 changed / unchanged / failed

### Resource
- [ ] 有并发和频率限制
- [ ] 有退避
- [ ] 不进行高频无控制访问

### Engineering
- [ ] scheduler/diff/feed 全量测试通过
- [ ] 重启和真实网络环境冒烟通过

---

## 10. Exit Gate

进入 Seventh Stage 前：

- Watch 不会因页面噪声制造大量误报；
- 失败和真正变化能区分；
- 调度不会产生明显资源问题；
- RSS 和浏览器 fallback 边界稳定；
- 数据保留策略已经明确。

完成后停止，进入产品化阶段。
