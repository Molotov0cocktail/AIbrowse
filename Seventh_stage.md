# Seventh_stage.md — 产品加固、Windows EXE 与发布闭环

> 前置阶段：`Sixth_stage.md`  
> 核心目标：把“功能完整的开发项目”变成“可以长期实际使用和发布的 Windows 桌面产品”。

## 1. 阶段定位

本阶段原则上不再增加大型产品能力。

重点是：

- 安全；
- 稳定；
- 性能；
- 安装/卸载；
- 数据迁移；
- 崩溃恢复；
- 更新；
- 发布验证。

---

## 2. Entry Gate

进入前：

- Browser / AI / Agent / Sources / Research / Watch 主路径已经完整；
- 核心数据 schema 相对稳定；
- 没有必须通过重写架构才能解决的 P0/P1 问题；
- 第一至六阶段主要验收通过。

---

## 3. 本阶段目标

### 3.1 Security Review

系统性检查：

- Electron security checklist；
- navigation / window.open；
- permission request；
- preload / IPC；
- remote content；
- credential storage；
- prompt injection；
- Tool permission；
- URL scheme；
- local file access；
- CSP；
- dependency vulnerabilities；
- update integrity。

形成可维护的项目 Security Model 文档。

### 3.2 数据与迁移

要求：

- SQLite migrations 可从真实旧版本升级；
- upgrade failure 有恢复方案；
- 用户可以导出/备份重要本地数据；
- uninstall 是否保留用户数据语义明确；
- API Key 与数据库备份边界明确；
- 敏感信息不进入普通导出。

### 3.3 崩溃恢复

至少考虑：

- browser process / renderer crash；
- WebContents crash；
- Agent 中断；
- Research 中断；
- Watch 调度异常；
- DB locked/corrupt；
- 非正常退出。

用户不应因一个网页崩溃丢失整个应用状态。

### 3.4 性能

建立可量化基线：

- 冷启动；
- 新建 Tab；
- 多 Tab 内存；
- PageSnapshot；
- AI 首 token；
- Research；
- 大型 Sources 库搜索；
- Watch 调度。

优化前先测量，不做无数据“性能重构”。

### 3.5 Windows 打包

生成真正可安装/运行的 Windows 产物。

要求：

- 干净 Windows 环境安装验证；
- 正确 App Name / icon / version；
- 安装路径；
- 卸载；
- 数据目录；
- 日志目录；
- 升级覆盖；
- 防止把开发文件/密钥打进包。

具体打包工具进入本阶段根据当前 electron-vite/Electron 生态确定。

### 3.6 Code Signing

若公开分发，应设计 Windows code signing。

如果暂时没有证书：

- 文档明确开发版/未签名版限制；
- 不伪造“已签名”状态；
- 未来接证书流程留好 CI 接口。

### 3.7 Auto Update

是否在本阶段实现自动更新，应依据实际发布渠道决定。

如果实现，必须：

- 校验更新来源；
- 有签名/完整性；
- 不允许网页控制更新 URL；
- 支持失败回滚或至少安全失败。

如果暂不实现，至少完成手工升级兼容性。

### 3.8 Release Pipeline

建议：

Git tag
→ CI
→ test/typecheck/lint/build
→ package
→ security checks
→ artifact
→ clean-machine install test
→ release notes
→ publish

GitHub/Gitee 双远程策略遵守项目既有规则。

---

## 4. 用户体验加固

检查：

- 首次启动；
- 无 API Key；
- 无网络；
- Provider 不可用；
- 网页打不开；
- captcha；
- DB 错误；
- Research 失败；
- Watch 失败；
- 更新失败。

错误信息应告诉用户：

- 发生什么；
- 哪些数据受影响；
- 可以做什么。

不要只显示 stack trace。

---

## 5. 可观测性

日志系统应成熟为：

- session id；
- component；
- operation；
- duration；
- error category；
- sanitized context。

同时：

- 默认不记录网页全文；
- 不记录 API Key；
- 不记录密码；
- 不无控制记录表单内容。

必要时支持用户主动导出诊断包，并允许预览其中内容。

---

## 6. 最终安全红队场景

至少覆盖：

- 恶意网页 Prompt Injection；
- 网页诱导 Agent 上传本地文件；
- 网页诱导 Agent 发送 API Key；
- 恶意 URL scheme；
- 下载可执行文件；
- popup / redirect；
- renderer compromise 假设；
- Source user_note 与 web content 冲突；
- Research 中恶意来源；
- Watch 页面结构被恶意修改。

---

## 7. 非目标

除修复用户体验缺口外，不在本阶段加入：

- 大型新 Agent 能力；
- 浏览器扩展市场；
- 云同步；
- 多人协作；
- 移动端；
- macOS/Linux 正式支持；
- 分布式爬虫。

这些应进入未来独立 Roadmap。

---

## 8. 最终验收

### Functional
- [ ] 第一至六阶段主路径全部通过回归
- [ ] 干净 Windows 环境可安装运行
- [ ] 升级/卸载语义明确

### Security
- [ ] Electron 安全审查通过
- [ ] Prompt Injection / Tool 权限红队通过
- [ ] 密钥和敏感数据无泄漏
- [ ] 安装包不包含开发残留/密钥

### Stability
- [ ] 多 Tab 长时间运行稳定
- [ ] renderer/webContents 崩溃有恢复
- [ ] DB migration 真实升级测试通过
- [ ] Watch/Research 异常不会拖垮主应用

### Performance
- [ ] 有性能基线
- [ ] 无明显不可接受回归

### Release
- [ ] version/tag/build 对齐
- [ ] Release artifact 可复现
- [ ] 独立机器安装验证
- [ ] Release notes 与已知限制明确

---

## 9. 阶段完成定义

完成 Seventh Stage 后，项目才从“开发原型”进入：

**可日常使用 / 可对外测试 / 可持续版本迭代**

之后的新功能不再继续按 First–Seventh Stage 线性推进，而应建立独立 Roadmap / milestone，例如：

- Profiles
- Advanced Search Providers
- XLSX / Report Export
- Local Models
- Cloud Sync
- Extension System
- Advanced Automation

每项都应重新走 proposal → design → tasks → verification 流程。
