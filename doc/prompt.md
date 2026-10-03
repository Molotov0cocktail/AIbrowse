# 当前接管入口：Stage7 E1–E6 实现与验收

先读 AGENTS.md、doc/tasks/progress.md 及 Git 实际状态，保护已有修改，接续真实后继。
用户 2026-10-04 明确授权从 E1 开始持续完成 E1–E6，实现、验证、必要独立审核与收尾均无需逐任务确认。
该授权取代历史“停在 E1 首个产品实现前”的边界；Stage7 完成后停止，不启动 Stage8 产品实现。

合同位于 doc/stage7/proposal.md、high-level-design.md、detailed-design.md、threat-model.md、tasks.md。
交付限定 Windows x64、未签名内部开发候选及手动升级，不公开发布、不创建公开 Release、不引入自动更新。
设计 PASS 不替代实现、实际打包、独立 Windows 或阶段验收；硬门缺证不能关闭 Stage7。

Stage6 已由新独立 D11 GO/PASS 关闭；适用证据按版本和影响面复用，不重启 012、classic ETW、周期 freeze。
用户取消强制拔电测试：电池 NOT RUN，续航/功耗未验证，不再请求电池窗口。
本任务新增 Build Tools/MSVC/SDK 已卸载并独立复核，原有组件保留；不重复卸载或默认重装。
开发可使用当前 Windows 账户；同机新 userData 不能冒充独立 Windows 验收。

工程选择自主推进。只有产品取舍、接受未解决用户风险、凭据、外部权限、物理操作或未授权不可逆动作才集中询问。
工具源码进入 tools/ 和 Git，原始证据、数据库、机器配置、凭据和产物不入库，保留失败。
必要审核 PASS 后完成文档、逻辑提交及正常双远程推送；Gitee 直连，GitHub 操作先确认代理并使用 http.proxy。
具体当前状态、证据和下一动作只看 progress，不把本文件当第二进度源。
