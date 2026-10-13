export interface UserScriptMetadata {
  name: string;
  namespace: string;
  version: string;
  description: string;
  matches: string[];
  excludes: string[];
  includes: string[];
  excludeGlobs: string[];
  grants: string[];
  runAt: 'document-idle';
}

export interface UserScriptSummary extends UserScriptMetadata {
  id: string;
  enabled: boolean;
  sourceBytes: number;
  installedAt: string;
}

export type UserScriptResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code:
        | 'invalid-input'
        | 'unsupported'
        | 'unavailable'
        | 'storage-error'
        | 'not-found'
        | 'limit-exceeded'
        | 'stale';
      message: string;
    };

export interface UserScriptToggle {
  id: string;
  enabled: boolean;
}

export interface UserScriptIdentifier {
  id: string;
}
