# AIbrowse 内置资格脚本第三方声明

本目录保存 AIbrowse 普通浏览标签页使用的固定第三方脚本原件。两份 JSON 是原始源码、依赖和资源的 UTF-8 数据封装；运行前仍由 `src/main/userscripts-qualified/catalog.ts` 中逐项固定的来源 URL、字节数和 SHA-256 校验。AIbrowse 不自动更新这些文件，也不在研究或监控任务页执行它们。

## AC-baidu 27.20

- 包：`ac-baidu.json`，524104 字节，SHA-256 `651D6A84B75577A6A2F88F2BD33F4A1F6A95A6FFF59B345C0E5B7E8F5684BAB1`。
- 根脚本：Greasy Fork 14178，作者 AC / inDarkness，版权声明 `2015-2026, AC`，源码头及 Greasy Fork 页面标记 `GPL-3.0-only`。
- `require-0`：Less.js 4.2.2，Apache-2.0；完整文本见 `licenses/Apache-2.0.txt`。
- `require-1`：Vue 3.5.26，MIT；完整文本见 `licenses/Vue-MIT.txt`。
- 资源共 22 项：`baiduCommonStyle`、`baiduOnePageStyle`、`baiduTwoPageStyle`、`googleCommonStyle`、`googleOnePageStyle`、`googleTwoPageStyle`、`bingCommonStyle`、`bingOnePageStyle`、`bingTwoPageStyle`、`duckCommonStyle`、`duckOnePageStyle`、`duckTwoPageStyle`、`dogeCommonStyle`、`dogeOnePageStyle`、`dogeTwoPageStyle`、`haosouCommonStyle`、`haosouOnePageStyle`、`haosouTwoPageStyle`、`HuYanStyle`、`BgAutoFit`、`HuaHua-ACDrakMode`、`baiduLiteStyle`。前 21 项来自脚本元数据指定的 `ibaidu.tujidu.com/newcss/`，最后一项来自脚本元数据指定的 GitCode snippet；这些文件本身没有发现独立许可证头。本目录保留原字节，逐项来源、大小和摘要以 catalog 为准。
- 上游仓库同时提供 MIT `LICENSE` 与 GPLv3 `LICENSE.txt`；两份文本分别保存在 `licenses/AC-UPSTREAM-MIT.txt` 与 `licenses/GPL-3.0.txt`。上游 README 另有原文：“本脚本禁止使用并修改用于制作脚本集合之类的聚合性脚本”，来源：<https://github.com/langren1353/GM_script>。这里如实记录该附加声明，不将其改写为其他授权结论。
- AIbrowse 对已校验执行副本仅做一个兼容修正：将未定义的裸 `Reg_Get` 调用改为脚本已有的 `MyApi.Reg_Get`；存档原件不变。

## GitHub 中文化插件 1.9.2.4-2026-09-27

- 包：`github-zh.json`，2146875 字节，SHA-256 `730C357ACC83EFB18C761E25F61C2134149BF53E85EF5819BA9C2DB52360B937`。
- 根脚本：Greasy Fork 435208 / <https://github.com/maboloshi/github-chinese>，作者沙漠之子，版权声明 `2021, 沙漠之子`，许可证标记 `GPL-3.0`。
- `require-0` 词库：Greasy Fork 435207，同一上游仓库；文件声明 Copyright (C) 2016-2021 楼教主、Copyright (C) 2021-当前 沙漠之子，并采用 GPL version 3 or later。
- GPLv3 完整文本见 `licenses/GPL-3.0.txt`。
- AIbrowse 对已校验执行副本禁用 `transDesc` 入口，因此不调用讯飞听见；存档原件不变。

## 完整性清单

两包共含 27 项：AC-baidu 的 1 个根脚本、2 个 require、22 个 resource，以及 GitHub 中文化的 1 个根脚本、1 个 require。每项的固定 URL、UTF-8 字节数和 SHA-256 位于 `src/main/userscripts-qualified/catalog.ts`，它也是构建和运行时共同使用的唯一逐项机器清单。
