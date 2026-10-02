/// <reference lib="dom" />

import { buildInteractionSource, type InteractionScriptParams } from './interaction-script';
import { SNAPSHOT_SCRIPT_SOURCE } from './snapshot-script';

// This world is separate from both the page (0) and Electron's preload world (999).
// Electron 43.4.0 marks isolated injection as kInjectedJavascript, which disables
// BFCache for the document. Requalify that native boundary when upgrading Electron
// or changing this injection channel; see doc/stage3/detailed-design.md §5.2.
export const PAGE_READER_WORLD_ID = 1001;

interface DocumentBinding {
  document: Document;
  token: string;
}

function collectInDocument(collect: () => unknown): unknown {
  const isolated = globalThis as typeof globalThis & {
    __aibrowseDocumentBinding?: DocumentBinding;
  };
  let binding = isolated.__aibrowseDocumentBinding;
  if (binding === undefined || binding.document !== document) {
    // Generate in the actual executing document. A delayed old snapshot must never
    // install its old authorization token into a replacement document.
    const random = crypto.getRandomValues(new Uint32Array(4));
    binding = {
      document,
      token: Array.from(random, (word) => word.toString(16).padStart(8, '0')).join(''),
    };
    isolated.__aibrowseDocumentBinding = binding;
  }
  return { token: binding.token, snapshot: collect() };
}

function interactInDocument(token: string, interact: () => unknown): unknown {
  const binding = (
    globalThis as typeof globalThis & { __aibrowseDocumentBinding?: DocumentBinding }
  ).__aibrowseDocumentBinding;
  // The check and the fixed synchronous DOM action run in one isolated-world task.
  // An interaction must never initialize, copy, or repair a missing binding.
  if (binding === undefined || binding.document !== document || binding.token !== token) {
    return {
      ok: false,
      code: 'stale-element',
      reason: '元素所属的快照已过期（页面已导航或刷新），请重新读取页面',
    };
  }
  return interact();
}

export const BOUND_SNAPSHOT_SCRIPT_SOURCE = `(${collectInDocument.toString()})(() => { return ${SNAPSHOT_SCRIPT_SOURCE} })`;

export function buildBoundInteractionSource(
  params: InteractionScriptParams,
  token: string,
): string {
  return `(${interactInDocument.toString()})(${JSON.stringify(token)}, () => { return ${buildInteractionSource(params)}; })`;
}
