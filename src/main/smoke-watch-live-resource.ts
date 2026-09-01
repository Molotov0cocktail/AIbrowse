// Sixth Stage D10: live resource probe over product-owned Watch resources.
// The probe owns each temporary resource, observes its actual registry state,
// and reports only after the bounded cleanup window has elapsed.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type DbHandle } from './sources/db/sqlite-driver';
import type { WatchLiveResourcePort } from './smoke-watch-live-runner';
import type { WatchTaskTabWorkspace } from './watch/watch-task-tab-workspace';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('resource probe aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('resource probe aborted'));
      },
      { once: true },
    );
  });
}

export interface ProductWatchRuntimeResourceProbe {
  isAvailable: () => boolean;
  shutdown: () => Promise<void>;
  residuals: () => {
    servers: number;
    timers: number;
    databases: number;
    taskTabs: number;
    children: number;
    tempDirs: number;
  };
}

export function createProductWatchResourcePort(
  workspace: WatchTaskTabWorkspace | null,
  runtime?: ProductWatchRuntimeResourceProbe,
): WatchLiveResourcePort {
  return {
    async probe(_scenario, signal) {
      if (runtime !== undefined) {
        if (!runtime.isAvailable()) {
          return {
            httpClass: 'Watch 生产运行时不可用',
            errorCode: 'product-defect',
            residuals: runtime.residuals(),
          };
        }
        const observedAt = Date.now();
        try {
          await runtime.shutdown();
          const samples = 3;
          const residuals: ReturnType<ProductWatchRuntimeResourceProbe['residuals']>[] = [];
          for (let index = 0; index < samples; index += 1) {
            if (index > 0) await wait(100, signal);
            residuals.push(runtime.residuals());
          }
          return {
            httpClass: 'Watch 生产运行时排水后有界观察完成',
            observedForMs: Date.now() - observedAt,
            samples,
            residuals: residuals.at(-1),
            residualTrend: residuals,
          };
        } catch {
          return {
            httpClass: 'Watch 生产运行时排水失败',
            errorCode: 'product-defect',
            residuals: runtime.residuals(),
          };
        }
      }
      const owned = {
        servers: new Set<Server>(),
        timers: new Set<ReturnType<typeof setTimeout>>(),
        databases: new Set<DbHandle>(),
        taskTabs: new Set<string>(),
        children: new Set<ChildProcess>(),
      };
      const root = mkdtempSync(join(tmpdir(), 'aibrowse-d10-live-resource-'));
      let leaseId: string | null = null;
      let activeTimer: ReturnType<typeof setTimeout> | null = null;
      let server: Server | null = null;
      let child: ChildProcess | null = null;
      try {
        server = createServer();
        server.on('error', () => undefined);
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error);
          server!.once('error', onError);
          server!.listen(0, '127.0.0.1', () => {
            server!.removeListener('error', onError);
            resolve();
          });
        });
        owned.servers.add(server);

        child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.on('error', () => undefined);
        owned.children.add(child);

        const database = openDb(join(root, 'resource.db'));
        owned.databases.add(database);
        activeTimer = setTimeout(() => undefined, 1_000);
        owned.timers.add(activeTimer);

        if (workspace !== null) {
          const acquired = await workspace.acquire('https://example.com/', signal);
          if (!acquired.ok) {
            throw new Error(`任务标签页创建失败：${acquired.errorCode}`);
          }
          leaseId = acquired.lease.tabId;
          owned.taskTabs.add(leaseId);
        }

        if (leaseId !== null && workspace !== null) {
          const released = await workspace.release(leaseId);
          if (!released.ok) return { httpClass: released.reason, errorCode: 'product-defect' };
          owned.taskTabs.delete(leaseId);
          leaseId = null;
        }
        clearTimeout(activeTimer);
        activeTimer = null;
        owned.timers.clear();
        closeDb(database);
        owned.databases.delete(database);
        await new Promise<void>((resolve, reject) => {
          if (server === null) {
            resolve();
            return;
          }
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        owned.servers.delete(server);
        if (child !== null) {
          const closed = new Promise<void>((resolve) => {
            if (child!.exitCode !== null || child!.signalCode !== null) resolve();
            else child!.once('close', () => resolve());
          });
          child.kill();
          await Promise.race([closed, wait(1_000, new AbortController().signal)]);
          if (child.exitCode !== null || child.signalCode !== null) owned.children.delete(child);
        }
        rmSync(root, { recursive: true, force: true });

        const observedAt = Date.now();
        const samples = 3;
        const residualTrend = [];
        for (let index = 0; index < samples; index += 1) {
          if (index > 0) await wait(100, signal);
          residualTrend.push({
            servers: owned.servers.size,
            timers: owned.timers.size,
            databases: owned.databases.size,
            taskTabs: owned.taskTabs.size + (workspace?.getOwnedCount() ?? 0),
            children: owned.children.size,
            tempDirs: existsSync(root) ? 1 : 0,
          });
        }
        const observedForMs = Date.now() - observedAt;
        return {
          httpClass: 'product-owned Watch 资源清理后有界观察完成',
          observedForMs,
          samples,
          residuals: residualTrend.at(-1),
          residualTrend,
        };
      } finally {
        if (leaseId !== null && workspace !== null) {
          try {
            await workspace.release(leaseId);
          } catch {
            // Residual ownership is deliberately reflected by the returned state.
          }
        }
        for (const database of owned.databases) closeDb(database);
        if (activeTimer !== null) clearTimeout(activeTimer);
        if (server !== null && server.listening) {
          try {
            server.close();
          } catch {
            // Residual server ownership remains observable until process exit.
          }
        }
        if (child !== null && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill();
          } catch {
            // Residual child ownership remains observable until process exit.
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
