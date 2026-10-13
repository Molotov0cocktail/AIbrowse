# 标签分组与用户脚本（2026-10-13）

## 需求与交付边界

用户要求修复外观选项不可读、增加标签页分组和插件，并明确“两者都需要，先完成油猴脚本支持”。
随后用户选择“保持研究/监控隔离：先交付脚本，Chrome 扩展另做隔离方案”。本轮交付范围因此止于
外观、标签分组和用户脚本；Chrome 扩展不在本轮安装或执行，后续隔离设计单独推进。
这是第七阶段关闭后的独立功能增量，不启动未授权的其它路线图功能。实施与证据索引见
`doc/tasks/legacy-repair.md`、`doc/tasks/progress.md`。

外观仍为跟随系统、浅色、深色三种，保持既有偏好与 Windows 标题栏同步。用始终可见的原生单选控件
替代依赖平台弹出菜单配色的 select；文字、边界、选中与键盘焦点均由应用主题确定。

标签分组支持创建、名称与颜色修改、加入和移出标签、折叠展开、取消分组。取消分组不关闭任何网页。
分组与现有标签相同，保存在本次应用运行的主进程内存；UI 重载保留，应用退出后释放。
现有浏览器不恢复跨重启标签，本次不隐式增加历史网址自动重开或新增持久浏览记录。

插件先交付内置用户脚本管理，后续再按 Electron 的实际 API 验证 Chrome 扩展能力；不以“安装成功”声称
Tampermonkey 本体或全部 GM API 已兼容。Chrome 扩展兼容集合必须以实际探针和正式权限边界确定。

## 标签分组设计

主进程 BrowserControllerImpl 协调独立 TabGroupState，分组操作仅提供给受信 UI，
BrowserController 的 AI 工具接口与 17 工具集合不增加能力。组数量最多 32、名称 trim 后 1–40 字符，
颜色使用闭合枚举；成员必须属于当前存在的用户 Tab，Research/Watch 任务 Tab 不得加入。

TabsState 推送增加 groups/userTabIds，新的 UI 专用完整初始状态读取与既有推送共用事实源；
旧 tabs.list 继续保持 TabInfo[] 语义。界面先订阅再读取，后来的推送不能被旧读取覆盖。
所有操作使用现有当前主 UI 文档校验、准入与严格 payload 白名单；无任意路径、SQL 或执行通道。

组内标签在渲染上连续显示；折叠只隐藏非活动组成员，不改变主进程激活页、不关闭 WebContentsView。
活动页始终可见，键盘导航只按显示标签计算顺序。用户关闭成员或任务销毁后移除失效关联，空组自动移除。
分组元数据不得改变任务 Tab 所有权、AI 导航/快照、历史与书签记录、最后标签补空白页及正常退出语义。

## 用户脚本的安全不变量

脚本是用户主动安装的第三方网页程序，不能当作可信应用代码。管理入口只能经受信 UI 与主进程文件选择；
网页和模型不能安装、修改、启停脚本，AI 没有脚本执行工具。导入时展示脚本名称、匹配网站与权限，
用户确认后才保存；默认不自动从网络下载依赖或更新脚本。

执行限定普通用户 Tab 的 HTTP/HTTPS 主文档；应用 UI、file/data/chrome-extension 等内部协议、
Research/Watch task-owned Tab 均排除。远程 Tab 仍无应用 preload，Node 集成关闭，contextIsolation、
sandbox、webSecurity 保持开启。脚本不获得 Electron、文件系统、数据库、API Key 或宿主 HTTP 代理。
网页自身已有的 DOM 与标准网络能力不因为安装脚本而扩大为主进程能力。

首版兼容受限油猴脚本格式：最多 50 项、单脚本 UTF-8 不超过 256 KiB、源码总量不超过 8 MiB；
包含 Base64 编码的序列化配置文件最多 12 MiB，编码不增加允许的源码量。
支持 HTTP/HTTPS 的 match/exclude-match 与有界 include/exclude 通配规则；run-at 仅省略或 document-idle。
grant 仅 none、GM_addStyle/GM.addStyle、GM_info/GM.info。require/resource/connect、跨域请求、GM 存储、
unsafeWindow、请求页面主 world 的元数据/执行模式及其它执行时机明确拒绝，不静默降级。
普通描述性元数据不引入能力。隔离 world 共享 DOM，不能阻止用户脚本通过受页面 CSP 约束的 DOM
方式间接影响网页主 world；它不是网页内部行为的完全安全沙箱。
每脚本独立 world，编号避开既有 0/999/1001；同文档只执行一次，同 URL 刷新必须重新验证文档身份。
零参数导入通过主进程文件选择与原生权限确认，路径和源代码不返回 renderer；其余管理请求使用 UUID 和布尔白名单。

独立世界只隔离 JavaScript 全局，不隔离 DOM；脚本仍可读取/更改匹配页面，启用前清楚说明。
即使 grant none 也使用隔离世界，不承诺与 Tampermonkey 的页面变量访问行为等价。
不向任务页注入不等于隔绝会话状态：用户脚本仍可通过普通网页能力影响同源 Cookie/Storage，
之后的共享登录浏览或采集可能观察这些变化；不提供额外宿主访问能力。
禁用/删除阻止后续加载执行；已执行的 DOM 改动或监听器需要刷新页面清除，界面明确提示。

脚本源只存于专属有界本地配置，不进入 prompt、日志、会话或业务数据库；存储失败不得假装安装成功。
损坏配置保留原件并安全禁用，不覆写修复。脚本管理配置不混入现有业务备份范围。
非发行 SMOKE_MODE 使用既有隔离的 SMOKE_AI_DATA_DIR 下的脚本目录，不能加载真实已安装脚本；
普通运行和发行构建继续使用正式用户数据根，受控真实运行使用明确的独立 profile/session。

平台核查来源：Electron [扩展兼容范围](https://www.electronjs.org/docs/latest/api/extensions)、
[扩展 API](https://www.electronjs.org/docs/latest/api/extensions-api)、
[WebContents 执行接口](https://www.electronjs.org/docs/latest/api/web-contents)、
Chrome [userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)、
Tampermonkey [脚本文档](https://www.tampermonkey.net/documentation.php)。
Electron 仅支持 Chrome API 子集，不能据此保证 Tampermonkey 的 userScripts/MV3 依赖可用。
会话级扩展还会覆盖相同 Session 的任务 Tab；全 Chrome 扩展方案需单独解决此边界后再交付。

## 验证与换路

外观覆盖两主题与跟随系统、键盘和选中状态，真实 Electron 检查文字对比度与几何。
分组覆盖生命周期、任务 Tab 拒绝、未知/越界/额外字段、初始读取推送竞态和键盘按钮冒泡；
运行验证 UI 创建/编辑/折叠/移出/取消及 UI 重载保持。
用户脚本覆盖匹配反例、权限拒绝、存储故障与恶意结构、导航竞态、普通用户页实际 DOM 效果，
以及内部页面/任务页不执行；必须由新独立 Reviewer 核验安全、持久化与真实运行证据。

每种未知平台能力先做最小合成探针；连续两轮无新增证据时停止原路线并重新制定方案。
有新增证据的后续诊断须说明具体假设、有限预算与 oracle，保留全部旧失败；不靠无诊断重复挑选绿态。
这保持同一产品验收标准，允许以实际平台事件修正失效工程假设；平台不承诺的能力不作为验收事实。
单运行最多 180 秒，不触真实 profile，Provider 零调用；真实外网不是合成脚本管理验收的必要条件。
全量 typecheck/lint/format/test/build 在集成后执行一次，失败按受影响范围修复，保留原件。
Windows x64 内部候选经审核和包身份检查后更新 output，保留旧包；不公开发布、不引入自动更新。
