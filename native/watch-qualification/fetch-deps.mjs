import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../log/h3b-native-current/deps');
mkdirSync(root, { recursive: true });
const artifacts = [
  [
    'node-v43.4.0-headers.tar.gz',
    '2f0c70eb184872330642e69ef362392930638d143e079f47532034522d6bb9ce',
  ],
  ['win-x64/node.lib', '713122182d8593f5d54ae30e7539ac7854a18cdef1cdb6cc093b1ac7eac73218'],
];
for (const [name, expected] of artifacts) {
  const target = resolve(root, name.replace('/', '-'));
  if (!existsSync(target)) {
    const response = await globalThis.fetch(
      `https://artifacts.electronjs.org/headers/dist/v43.4.0/${name}`,
      {
        signal: globalThis.AbortSignal.timeout(120000),
      },
    );
    if (!response.ok) throw new Error(`资格构建依赖下载失败：${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error('资格构建依赖摘要不匹配');
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  if (createHash('sha256').update(readFileSync(target)).digest('hex') !== expected)
    throw new Error('资格构建依赖摘要不匹配');
}
globalThis.console.log('Electron 43.4.0 x64 头文件与导入库摘要已验证');
