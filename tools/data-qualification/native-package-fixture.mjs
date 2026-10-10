import { Buffer } from 'node:buffer';
import http from 'node:http';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const HOST = '127.0.0.1';
const MAX_LIFETIME_MS = 15 * 60 * 1000;
const MAX_COMMAND_BYTES = 8;
const pages = Object.freeze({
  A: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Watch Session A</title></head><body><main><h1>Watch Session 固定页面</h1><p id="watch-value">固定正文 A</p></main></body></html>',
  B: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Watch Session B</title></head><body><main><h1>Watch Session 固定页面</h1><p id="watch-value">固定正文 B</p></main></body></html>',
});

let state = 'A';
let closing = false;
let commandBytes = [];
let discardCommand = false;

function timestamp() {
  return new Date().toISOString();
}

function respond(response, status, contentType, body) {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': bytes.length,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/page') {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not Found\n');
    return;
  }
  respond(response, 200, 'text/html; charset=utf-8', pages[state]);
});

const lifetime = setTimeout(() => shutdown('timeout'), MAX_LIFETIME_MS);

function shutdown(reason) {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  process.stdin.pause();
  process.stdout.write(`关闭 ${timestamp()} reason=${reason}\n`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  const forceClose = setTimeout(() => server.closeAllConnections(), 1_000);
  forceClose.unref();
}

function acceptCommand() {
  if (discardCommand) {
    discardCommand = false;
    commandBytes = [];
    return;
  }
  if (commandBytes.at(-1) === 13) commandBytes.pop();
  const command = Buffer.from(commandBytes).toString('ascii');
  commandBytes = [];
  if (command === 'B') {
    if (state !== 'B') {
      state = 'B';
      process.stdout.write(`切换 B ${timestamp()}\n`);
    }
  } else if (command === 'STOP') {
    shutdown('stop');
  }
}

process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    if (byte === 10) {
      acceptCommand();
    } else if (!discardCommand && commandBytes.length < MAX_COMMAND_BYTES) {
      commandBytes.push(byte);
    } else {
      discardCommand = true;
      commandBytes = [];
    }
  }
});
process.stdin.on('end', () => shutdown('eof'));
process.stdin.on('error', () => shutdown('stdin-error'));
process.stdin.resume();

server.on('error', () => {
  if (!closing) {
    closing = true;
    clearTimeout(lifetime);
    process.stdin.pause();
    process.stdout.write(`关闭 ${timestamp()} reason=listen-error\n`);
    process.exitCode = 1;
  }
});

server.listen(0, HOST, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    shutdown('listen-error');
    return;
  }
  process.stdout.write(
    `启动 ${timestamp()} pid=${process.pid} url=http://${HOST}:${address.port}/page\n`,
  );
});
