import { closeSync, fstatSync, openSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fact, fileFact, parents, same, type Fact } from '../full-transfer/io';
import { JOURNAL_BYTES, need } from './contract';

export interface JournalProof {
  budgetBytes: number;
  maxObservedBytes: number;
  observations: number;
  journalObservations: number;
  finalAbsent: true;
  continuousPeakVerified: false;
}

/** Growth is expected; replacement, hard links and out-of-budget lengths are not. */
export function boundedIdentity(value: Fact, initial: Fact, maximum: number): number {
  need(
    value.dev === initial.dev &&
      value.ino === initial.ino &&
      value.nlink === '1' &&
      /^[0-9]{1,20}$/u.test(value.size),
  );
  const size = Number(value.size);
  need(Number.isSafeInteger(size) && size >= 0 && size <= maximum);
  return size;
}

/** Discrete observations only. SQLite may create/remove a journal between them. */
export function createJournalGuard(source: string, target: string, bytes: number) {
  need(resolve(dirname(source)) === resolve(dirname(target)) && source !== target);
  const directory = dirname(source),
    verifyParents = parents(directory);
  const original = fileFact(source),
    reserved = fileFact(target);
  const names = [basename(source), basename(target)];
  const journal = target + '-journal',
    journalName = basename(journal);
  let first: Fact | undefined,
    maxObservedBytes = 0,
    observations = 0,
    journalObservations = 0,
    failed = false,
    finished = false;
  need(Number(original.size) === bytes && reserved.size === '0');

  function inspect(final: boolean): void {
    need(!failed && !finished);
    try {
      verifyParents();
      need(same(original, fileFact(source)));
      boundedIdentity(fileFact(target), reserved, bytes);
      const entries = readdirSync(directory);
      need(entries.length <= 3 && names.every((name) => entries.includes(name)));
      need(entries.every((name) => names.includes(name) || (!final && name === journalName)));
      observations++;
      if (entries.includes(journalName)) {
        const pathBefore = fileFact(journal);
        first ??= pathBefore;
        maxObservedBytes = Math.max(
          maxObservedBytes,
          boundedIdentity(pathBefore, first, JOURNAL_BYTES),
        );
        // Do not retain the handle across callbacks: SQLite must retire its file.
        const fd = openSync(journal, 'r');
        try {
          const held = fstatSync(fd, { bigint: true });
          need(held.isFile());
          maxObservedBytes = Math.max(
            maxObservedBytes,
            boundedIdentity(fact(held), first, JOURNAL_BYTES),
          );
          maxObservedBytes = Math.max(
            maxObservedBytes,
            boundedIdentity(fileFact(journal), first, JOURNAL_BYTES),
          );
        } finally {
          closeSync(fd);
        }
        journalObservations++;
      }
      verifyParents();
      need(same(original, fileFact(source)));
      boundedIdentity(fileFact(target), reserved, bytes);
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  return {
    observe: () => inspect(false),
    finish(): JournalProof {
      inspect(true);
      finished = true;
      return {
        budgetBytes: JOURNAL_BYTES,
        maxObservedBytes,
        observations,
        journalObservations,
        finalAbsent: true,
        continuousPeakVerified: false,
      };
    },
  };
}
