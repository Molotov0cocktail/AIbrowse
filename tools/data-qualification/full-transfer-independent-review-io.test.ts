import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fault = vi.hoisted(() => ({ closed: 0, afterClose: () => {} }));
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync(fd: number) {
      actual.closeSync(fd);
      fault.closed++;
      fault.afterClose();
    },
  };
});
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyBound, readSmall, writeReceipt } from './full-transfer/io';
import { createTrace } from './full-transfer/trace';
import { createTransferProtocol } from '../../src/main/storage/transfer-protocol';
import { observeThenForward } from './full-transfer/observations';
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'full-transfer-review-'));
  roots.push(root);
  mkdirSync(join(root, 'original'));
  mkdirSync(join(root, 'output'));
  const source = join(root, 'original/member');
  const target = join(root, 'output/member');
  const bytes = Buffer.from('controlled-small-member');
  writeFileSync(source, bytes);
  return { root, source, target, bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}
afterEach(() => {
  fault.closed = 0;
  fault.afterClose = () => {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('完整Transfer最后真实关闭与文件事实的独立反例', () => {
  it('输入最后close才跨截止时，完整写入和flush不能授权成功', () => {
    const f = fixture();
    let time = 0;
    fault.afterClose = () => {
      if (fault.closed === 2) time = 10;
    };
    expect(() =>
      copyBound(f.source, f.target, f.bytes.length, f.sha, () => {
        if (time >= 10) throw new Error('期限');
      }),
    ).toThrow('期限');
    expect(fault.closed).toBe(2);
    expect(readFileSync(f.source)).toEqual(f.bytes);
    expect(readFileSync(f.target)).toEqual(f.bytes);
  });

  it('输出fd关闭后路径被换为同字节独立文件，最后metadata复核拒绝', () => {
    const f = fixture();
    fault.afterClose = () => {
      if (fault.closed === 2) {
        renameSync(f.target, f.target + '.original');
        writeFileSync(f.target, f.bytes);
      }
    };
    expect(() => copyBound(f.source, f.target, f.bytes.length, f.sha, () => {})).toThrow();
    expect(readFileSync(f.target + '.original')).toEqual(f.bytes);
    expect(readFileSync(f.source)).toEqual(f.bytes);
  });

  it('小证明读完后祖先替换，即便原成员inode保留也拒绝', () => {
    const f = fixture();
    writeFileSync(f.source, '{"fixed":true}');
    fault.afterClose = () => {
      if (fault.closed === 1) {
        renameSync(join(f.root, 'original'), join(f.root, 'old-parent'));
        mkdirSync(join(f.root, 'original'));
        renameSync(join(f.root, 'old-parent/member'), f.source);
      }
    };
    expect(() => readSmall(f.source, () => {})).toThrow();
    expect(readFileSync(f.source, 'utf8')).toBe('{"fixed":true}');
  });

  it('成功回执最后close才超时仍拒绝；原失败现场保留', () => {
    const f = fixture();
    let time = 0;
    fault.afterClose = () => {
      time = 10;
    };
    expect(() =>
      writeReceipt(f.target, { completed: true }, () => {
        if (time >= 10) throw new Error('期限');
      }),
    ).toThrow('期限');
    expect(readFileSync(f.target, 'utf8')).toBe('{"completed":true}');
  });

  it('无效协议消息的正文不进入durable trace，原消息仍只转发一次', () => {
    const f = fixture();
    const trace = createTrace(f.target, () => {});
    const job = {
      operationId: '00000000-0000-4000-8000-000000000001',
      snapshotId: '00000000-0000-4000-8000-000000000002',
      action: 'backup' as const,
    };
    const protocol = createTransferProtocol(job);
    const raw = JSON.stringify({
      type: 'ready',
      operationId: job.operationId,
      content: 'private-path-and-body',
    });
    const failed = vi.fn(),
      forward = vi.fn();
    observeThenForward(raw, (value) => trace.append(protocol.receive(value)), failed, forward);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledExactlyOnceWith(raw);
    const result = trace.close();
    expect(result.bytes).toBe(0);
    expect(readFileSync(f.target, 'utf8')).toBe('');
  });

  it('trace最后关闭过期不能以先前flush或内存摘要授权成功', () => {
    const f = fixture();
    let time = 0;
    const trace = createTrace(f.target, () => {
      if (time >= 10) throw new Error('期限');
    });
    trace.append({ stage: 'controlled' });
    fault.afterClose = () => {
      time = 10;
    };
    expect(() => trace.close()).toThrow('期限');
    expect(readFileSync(f.target, 'utf8')).toBe('{"stage":"controlled"}\n');
    expect(fault.closed).toBe(1);
  });
});
