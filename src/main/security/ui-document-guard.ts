import { randomUUID } from 'node:crypto';

export interface UiDocumentIdentity {
  owner: object;
  frame: object;
  url: string;
}

export function isTrustedUiDocument(url: string, entry: string): boolean {
  try {
    const actual = new URL(url);
    const expected = new URL(entry);
    actual.hash = '';
    expected.hash = '';
    return actual.href === expected.href;
  } catch {
    return false;
  }
}

/** Main owns document identity; no renderer-provided authorization is accepted. */
export class UiDocumentGuard {
  private current: (UiDocumentIdentity & { token: string }) | null = null;
  private navigating = false;

  constructor(private readonly entry: string) {}

  invalidate(): void {
    this.current = null;
    this.navigating = false;
  }

  beginNavigation(): void {
    this.navigating = true;
  }

  rejectNavigation(identity: UiDocumentIdentity): void {
    if (this.sameDocument(identity)) this.navigating = false;
  }

  commit(identity: UiDocumentIdentity): void {
    this.navigating = false;
    this.current = isTrustedUiDocument(identity.url, this.entry)
      ? { ...identity, token: randomUUID() }
      : null;
  }

  token(identity: UiDocumentIdentity): string | null {
    return this.matches(identity) ? this.current!.token : null;
  }

  accepts(identity: UiDocumentIdentity, token: unknown): boolean {
    return this.matches(identity) && token === this.current!.token;
  }

  private matches(identity: UiDocumentIdentity): boolean {
    return !this.navigating && this.sameDocument(identity);
  }

  private sameDocument(identity: UiDocumentIdentity): boolean {
    return (
      this.current !== null &&
      identity.owner === this.current.owner &&
      identity.frame === this.current.frame &&
      isTrustedUiDocument(identity.url, this.entry)
    );
  }
}
