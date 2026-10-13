export type QualifiedScriptId = 'ac-baidu' | 'github-zh';

export type ScriptValue =
  null | boolean | number | string | ScriptValue[] | { [key: string]: ScriptValue };

export interface QualifiedScriptStatus {
  id: QualifiedScriptId;
  name: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  issue: string | null;
}

export type QualifiedScriptResult =
  { ok: true; cancelled?: boolean } | { ok: false; message: string };

/** Main-owned package; only a qualified user-tab preload receives these bytes. */
export interface QualifiedPreparedScript {
  id: QualifiedScriptId;
  token: string;
  worldId: number;
  source: string;
  requires: string[];
  resources: Record<string, string>;
  values: Record<string, ScriptValue>;
  name: string;
  version: string;
  runAt: 'document-start' | 'document-end';
}

export interface QualifiedMenuCommand {
  token: string;
  commandId: string;
  label: string;
}
