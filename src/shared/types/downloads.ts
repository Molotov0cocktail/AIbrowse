/** User-only IDM handoff; success describes dispatch, never download completion. */
export interface IdmToolStatus {
  available: boolean;
}

export type IdmToolResult =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid-url' | 'unavailable' | 'busy' | 'failed' | 'closed';
      message: string;
    };
