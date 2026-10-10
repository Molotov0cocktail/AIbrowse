import { describe, expect, it, vi } from 'vitest';
import { parseDiagnosticExportPayload } from './diagnostics';

describe('parseDiagnosticExportPayload', () => {
  it('只接受两个可枚举own data字段', () => {
    expect(parseDiagnosticExportPayload({ sequence: 1, digest: 'a'.repeat(64) })).toEqual({
      sequence: 1,
      digest: 'a'.repeat(64),
    });
    expect(
      parseDiagnosticExportPayload({ sequence: 1, digest: 'a'.repeat(64), path: 'C:/secret' }),
    ).toBeNull();
  });

  it('拒绝getter且不执行访问器', () => {
    const getter = vi.fn(() => 1);
    const value = { digest: 'a'.repeat(64) } as Record<string, unknown>;
    Object.defineProperty(value, 'sequence', { enumerable: true, get: getter });
    expect(parseDiagnosticExportPayload(value)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('Proxy反射陷阱抛出时fail-closed', () => {
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile-proxy');
        },
      },
    );
    expect(parseDiagnosticExportPayload(value)).toBeNull();
  });
});
