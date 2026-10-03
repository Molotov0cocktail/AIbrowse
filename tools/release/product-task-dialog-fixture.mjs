import process from 'node:process';
import { writeFileSync } from 'node:fs';
import electron from 'electron';

const { app, BrowserWindow, dialog } = electron;

const signal = process.env.AIBROWSE_TASK_DIALOG_SIGNAL;
const userData = process.env.AIBROWSE_TASK_DIALOG_USER_DATA;
const mode = process.env.AIBROWSE_TASK_DIALOG_MODE;
if (!signal || !userData || !['Cancel', 'Confirm', 'Duplicate'].includes(mode)) {
  throw new Error('TaskDialog fixture environment is incomplete');
}

app.setPath('userData', userData);

app.whenReady().then(async () => {
  const owner = new BrowserWindow({
    width: 1,
    height: 1,
    x: -32000,
    y: -32000,
    show: false,
    title: 'AIbrowse TaskDialog owner fixture',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await owner.loadURL('data:text/html,<title>AIbrowse TaskDialog owner fixture</title>');
  owner.showInactive();
  const handle = owner.getNativeWindowHandle();
  writeFileSync(
    signal,
    JSON.stringify({
      owner: handle.readBigUInt64LE().toString(),
      processId: process.pid,
      electronVersion: process.versions.electron,
      mode,
    }),
    { encoding: 'utf8', flag: 'wx' },
  );
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: '确认 API Key 的发送目标',
    message: '验证语义动作模式',
    detail: '原目标：尚未绑定\n新目标：http://127.0.0.1:1/v1\n只有确认后才会提交配置。',
    buttons: mode === 'Duplicate' ? ['重复', '重复'] : ['取消', '确认发送目标'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  writeFileSync(`${signal}.result.json`, JSON.stringify({ response: result.response }), {
    encoding: 'utf8',
    flag: 'wx',
  });
  app.quit();
});
