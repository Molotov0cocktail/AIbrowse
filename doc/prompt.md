# 当前接管入口：Stage6收口与Stage7设计停止点

先读AGENTS.md、doc/tasks/progress.md及Git实际状态，接续真实后继。原H3b-R指令已完成：
H3b/H4与新独立D11均通过，Stage6已GO/PASS；原指令与失败证据保留于Git和受控log。
不重启012、classic ETW、周期freeze或已完成长窗，不因旧提示中的SHA回退工程状态。

用户2026-10-03明确取消强制拔电测试：电池NOT RUN，续航/放电功率/电池模式资源未验证。
不再次安排拔电，不把接电结果称为电池PASS/N/A，不改写旧FAIL/BLOCKED及unknown。

当前用户授权的最终范围为：Stage6收尾、正常双远程同步、按清单移除新增Build Tools/MSVC/SDK，
以及Stage7入口/风险/必要设计/任务准备，**停在Stage7第一个产品实现任务E1启动前**。
具体已完成与待办只看progress，不把本文件当第二状态源。

Stage7合同位于doc/stage7/proposal.md、high-level-design.md、detailed-design.md、threat-model.md、tasks.md。
本轮不改产品源码、不安装打包器、不制作发行包或公开发布。若后续用户明确授权实现，才接续E1，
记录当时精确baseline与现有修改，按红态→修复→实际目录包→独立安全审核执行。

清理新增构建环境使用官方安装器、核对安装前39项及保护文件快照，不删原有组件，不自动重启。
UAC/物理操作未完成时如实保留清理义务；不用绕过系统确认的方法，也不能只删缓存声称卸载完成。

工程选择自主推进，只有真实产品取舍、外部权限/凭据或物理操作才集中询问。保护未知工作，
工具源码进Git，原始证据不入库，保留所有失败；审核通过后正常双远程推送，GitHub先确认代理，不强推。
