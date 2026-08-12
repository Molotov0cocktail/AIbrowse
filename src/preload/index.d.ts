import type { AibrowseBridge } from '../shared/types/app';

declare global {
  interface Window {
    aibrowse: AibrowseBridge;
  }
}

export {};
