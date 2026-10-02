'use strict';

// The observer must detect this intentional pre-authentication module and read.
// The native launcher creates this public synthetic file outside user-data.
const fs = require('node:fs');
const process = require('node:process');
const path = require('node:path');
const { app } = require('electron');
const credential = path.join(path.dirname(process.env.TEMP), 'appdata', 'credentials.synthetic');
if (fs.readFileSync(credential, 'utf8') !== 'STARTUP_CHECK_SYNTHETIC_ONLY\n') {
  throw new Error('启动观察器正控合成内容错误');
}
app.whenReady().then(() => app.quit());
