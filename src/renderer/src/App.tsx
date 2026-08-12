import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/types/app';

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    // 渲染进程就绪即通知主进程（冒烟自检模式依赖此信号）
    window.aibrowse.notifyRendererReady();
    window.aibrowse
      .getAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>AIbrowse</h1>
        <p className="subtitle">AI 信息浏览器 —— 第一阶段项目基线</p>
      </header>
      <main className="app-main">
        <section className="card">
          <h2>当前状态</h2>
          <ul>
            <li>✅ 项目基线已建立（脚手架 / 测试 / lint / 类型检查 / 冒烟自检）</li>
            <li>⏳ 浏览器核心（BrowserController / TabManager / WebContentsView）开发中</li>
            <li>⏳ PageSnapshot 结构化网页读取开发中</li>
          </ul>
        </section>
        <section className="card">
          <h2>运行环境</h2>
          {info ? (
            <ul className="env-list">
              <li>应用版本：{info.appVersion}</li>
              <li>Electron：{info.electron}</li>
              <li>Chromium：{info.chrome}</li>
              <li>Node.js：{info.node}</li>
              <li>平台：{info.platform}</li>
            </ul>
          ) : (
            <p>读取中……</p>
          )}
        </section>
      </main>
      <footer className="app-footer">主进程日志见项目根目录 log/ 文件夹</footer>
    </div>
  );
}
