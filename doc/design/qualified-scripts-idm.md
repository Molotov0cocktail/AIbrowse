# IDM 工具与指定用户脚本（2026-10-13）

## 产品裁决

用户取消沉浸式翻译及原版扩展接入，改为 IDM 工具和油猴脚本；沿用同一浏览会话，不新增独立插件区。
指定脚本为 GreasyFork 14178 AC-baidu 与 435208 GitHub 中文化。随后用户明确允许它们需要的设置存储、
跨网站请求和 AC-baidu 与网页 JavaScript 的交互，但只在普通浏览标签运行；研究/监控任务页继续排除。
GitHub 的本地词库汉化保留，附带讯飞简介翻译禁用，翻译交由 AI 共读。该裁决覆盖原受限脚本设计中仅对
这两个精确版本适用的能力限制；普通任意导入脚本仍走原有 DOM/样式子集，不按名称冒用高权限档。

普通标签与任务继续共享网站登录，脚本对普通网页 DOM/网站状态的改变可能影响 AI 共读及后续网站观察；
不将“任务页不注入”宣传为消除全部间接影响。本轮不改变 AI 工具数、赋予模型脚本/下载执行权限或安装
Chrome/Tampermonkey 本体，不引入独立登录、浏览器会话迁移或自动更新。

用户要求两个脚本随程序内置。曾授权网页下载自动接管及仅向本机 IDM 交接所需登录信息；真实确认窗口
验证未通过后，用户确认本机 IDM 仍报损坏，并明确改回手动填写 URL。当前产品仅保留受信 UI 的地址交接，
不采集或转交 Cookie、来源页、User-Agent，不包含 COM helper 或自动下载路径。旧调查与失败留在 Git/
任务历史；这一最新裁决替换自动接管方案，脚本内置与其它隔离边界继续有效。

## IDM

用户在“下载与脚本”粘贴 HTTP(S) 地址并点击“发送到 IDM”。受信 UI 经现有严格 IPC 调用主进程
IdmDownloadService，仅检测固定 Windows 默认安装目录，使用 shell=false 和固定参数 `/d URL`；
拒绝内嵌凭据、控制字符、非法 URL 与额外 IPC 字段。提交前后复核窗口文档/应用准入，并发或退出安全拒绝。
仅发送该地址，不传浏览器 Cookie、来源页或其它登录状态；需要浏览器登录信息的链接可能无法下载。

Session 的 will-download 无条件 preventDefault，网页、AI、研究或监控均不能启动 IDM 或写下载文件。
不存在自动下载手势许可、请求头采集、下载专用 CDP Cookie 读取、COM helper 或相关发行资源。
普通 popup 路由与 AI 弹窗抑制保持原契约；没有新增 AI 工具或网页可调用的外部程序接口。

可用状态只表示固定路径存在，成功返回只表示请求已经发出，不证明 IDM 健康、弹窗出现或下载完成。
下载确认与进度由本机 IDM 管理；用户确认的第三方程序损坏不由浏览器静默修复。
官方接口来源：[IDM 命令行](https://www.internetdownloadmanager.com/support/command_line.html)。

## 两脚本资格与内置资源

资格目录 `src/main/userscripts-qualified/catalog.ts` 固定脚本标识、版本、根源码和有序 require/resource
的来源、字节数及 SHA256。AC 27.20 为根源码+2 require+22 resource；GitHub
1.9.2.4-2026-09-27 为根源码+词库 require。27 份完整资产作为固定 JSON 数据资源随程序提供，连同来源、
版本、原始许可和归属说明进入 Git 及内部发行包；不修改原稿存档字节，不去在线下载缺失资源。
这是资源供应方式的替换，既有隔离世界执行、逐资产摘要验证和能力范围不扩大。

新 profile 默认启用这两个用户已请求的功能，既有 enabled/values 保留。用户只需在“下载与脚本”使用
开关，不再挑本地包或联网安装；脚本菜单仍提供原本的配置入口。资源只接受固定 app 内路径，仍校验
闭合格式 `format=1/id/version/assets`、精确目录键、版本、逐项字节数和 SHA256；整体≤16MiB，不接受
路径、URL、权限或用户设置注入。缺失/篡改安全禁用，不能以远程重新下载掩盖损坏。
更新需随应用重新核验资源目录，无运行时自动更新；先前手动安装和超时证据保留在任务历史。

脚本安装包和 enabled/values 状态分离，原子写入成功后才变更内存事实；损坏原件保留并禁用，不能覆写
成“修复成功”。只读/满盘/并发删除或退出都安全失败。脚本数据不进入模型、会话、业务数据库、日志或
业务数据备份。每脚本值总量≤256KiB，深度≤12、节点≤10000、键≤128、字符串≤64KiB，
拒绝原型污染键、循环、访问器、非有限数与不受支持值。

## 运行与能力边界

普通用户 Tab 使用专用 sandbox preload；任务 Tab 无此 preload，全部远程页仍无应用 UI preload。
nodeIntegration=false、contextIsolation/sandbox/webSecurity=true 不变。专用 preload 只把最小 API
暴露到两个独立脚本 world（20001起），不向网页主世界暴露 Electron、IPC、Node、路径或通用宿主能力。
这替换“任何远程 Tab 均无 preload”的旧工程手段，保留“网页无应用 bridge/通用系统权限”的产品边界。

主进程仅为 onUserTabCreated 登记的主 frame 建立资格；prepare 从实际 frame URL 选择固定包，不接受
网页指定 scriptId/source/world。每个文档/脚本使用不可复用 token；所有调用复核 sender、主 frame、文档
绑定、脚本已安装启用与应用准入。全导航、崩溃、销毁、停用、删除撤销 token、菜单及在途请求；同文档
同源 SPA 导航保留绑定。任务 Tab、iframe、其它脚本和旧 token 都不能借用能力。

document-start 从 preload 中调用原生 webFrame 隔离执行，document-end 等 DOMContentLoaded；
requires 与根源码共享该脚本私有作用域。首次原生合成探针以首个 inline script 为 oracle；根元素在
preload 时可能尚不存在，不能把 documentElement 缺失混同于执行太晚。实际失败与诊断保留在任务证据。

GM_getValue/listValues 使用本脚本快照；GM_setValue 同步主进程持久化确认后返回，GM.setValue 返回
相同持久化结果的 Promise，避免脚本紧接 reload 丢写。变更仅广播给同一脚本活文档，remote 按文档确定。
每文档每分钟最多60次写入、10次通知，最多24菜单、4在途请求。菜单由受信 UI 展示并选择，回调只进入
原活文档；AC 打开设置页仅在该显式菜单操作后一秒、一次性许可内，限定三个精确 HTTPS 官方设置主机
及 `/pages/custom/` 路径。无自动页面弹窗或任意外部程序通道。

AC 的 unsafeWindow 为兼容所需的有限外观，不是通用主世界 Window：isACBaiduInit 标志、
AC_GM_Interface.get/save/change 和 webInterface.update。设置页必须为精确 HTTPS
`ac-baidu.90dao.com`、`ac-baidu.tujidu.com` 或 `ibaidu.tujidu.com`，
路径 `/pages/custom/`，不得使用 host.includes。
页面只可调用有界 AC 配置键/JSON，不可指定脚本、通道、路径、函数代码或任意网络 URL。
DuckDuckGo 页面只额外提供原稿所需 kn/kav=1 的固定 DDG.settings.set 动作，不开放任意对象方法。

## 网络与禁用翻译

安装与 AC 请求使用有界主进程公共 HTTP(S) 客户端：仅 GET/HEAD、端口80/443，逐跳 DNS 与全部候选
地址检查并固定 lookup，拒私网/回环/link-local、凭据、HTTPS降级；重定向≤5，单请求总时限10秒、
响应≤4MiB、总并发≤4。只接受有界 Accept/Referer，不发 Cookie/Authorization；无 POST 或任意上传。
跨域能力属于这两个资格档，本次只有 AC 拥有运行请求权限；不是模型/网页通用网络代理。

GitHub 运行请求全部拒绝，iflyrec 也由网络层拒绝；附带简介翻译入口在资格适配中关闭，界面说明此
例外，不能报告完整 Tampermonkey 兼容。响应移除 Set-Cookie/认证和远端 tm-finalurl* 头，
AC 所需最终 URL 由已经逐跳校验的事实提供。正文仅有界返回到脚本，不写日志或业务存储。

适配仅作用于已按目录 SHA256 校验的固定版本的内存执行副本，不改变下载存档字节。GitHub 固定版本
的 `transDesc` 函数入口直接返回，仓库/Gist 简介均不出现第三方翻译按钮；AC 27.20 的最终 URL
回退路径将原稿中未定义的裸 `Reg_Get` 改为已有导出 `MyApi.Reg_Get`，保留原来的提取逻辑。
两处均要求固定文本恰好出现一次，否则停止执行，不对任意导入脚本套用改写。发行包仅新增精确命名的
`out/release/preload/qualified-userscripts.js` 必需文件，未放开 preload 目录通配许可。

## 验收

覆盖实际两脚本根与依赖身份、合成首脚本时序、原版受控页面效果、设置写后刷新/重启、菜单及配置桥、
GitHub 外部翻译禁用、任务页/子 frame/伪造身份/迟到 token/跨脚本存储/公网请求反例。
IDM 验证真实子进程参数机制与替身，不以替身证明 IDM 下载完成；未执行真实 IDM 时如实说明。
关键权限、同步持久化、导航并发需新独立审核；通过适用类型/lint/test/build/原生运行后再更新内部候选。
两轮无新增证据时重定路线，不能删除权限断言或减弱原功能验收来宣称通过。
