// Tree diffing and the three-way merge the pull-request API needs. Everything here reads real git
// trees out of the repository's object database; a pull's files are the difference between the
// merge base and the head, and a conflict is a path both sides changed differently.

import type { Repo, Store } from '../store.ts';
import { hashObject, readTreeIndex } from '../git/objects.ts';

export interface FileDiff {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
}

function sameBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

/** Added/deleted line counts from an LCS over the two texts; common edges are trimmed first. */
export function lineChangeCounts(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = before === undefined ? [] : before.toString('utf8').split('\n');
  const newLines = after === undefined ? [] : after.toString('utf8').split('\n');
  let start = 0;
  const shortest = Math.min(oldLines.length, newLines.length);
  while (start < shortest && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const a = oldLines.slice(start, endOld);
  const b = newLines.slice(start, endNew);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] as number) + 1 : Math.max(previous[j] as number, current[j - 1] as number);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  const lcs = previous[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/** The files a pull changes, from the merge base to `head`. */
export function diffTrees(repo: Repo, baseCommit: string, headCommit: string, mergeBase: string | null): FileDiff[] {
  const baseTree = repo.objects.get(baseCommit);
  const headTree = repo.objects.get(headCommit);
  if (baseTree === undefined || headTree === undefined) return [];
  const base = mergeBase === null ? new Map<string, string>() : readTreeIndex(repo.objects, treeOf(repo, mergeBase));
  const head = readTreeIndex(repo.objects, treeOf(repo, headCommit));
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === after) continue;
    let status: FileDiff['status'];
    if (before === undefined) status = 'added';
    else if (after === undefined) status = 'removed';
    else status = 'modified';
    const beforeBytes = before === undefined ? undefined : repo.objects.get(before)?.content;
    const afterBytes = after === undefined ? undefined : repo.objects.get(after)?.content;
    const counts = lineChangeCounts(beforeBytes, afterBytes);
    out.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: after ?? before ?? '',
    });
  }
  return out;
}

function treeOf(repo: Repo, commitSha: string): string {
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return '';
  const text = object.content.toString('utf8');
  const match = /^tree ([0-9a-f]{40})$/m.exec(text);
  return match === null ? '' : (match[1] as string);
}

export function blobShaOf(data: Buffer): string {
  return hashObject('blob', data);
}

export interface MergeResult {
  readonly ok: boolean;
  readonly files: Map<string, Buffer>;
  readonly conflicts: string[];
}

/** A three-way merge of `head` onto `base`, using `mergeBase` as the common ancestor. */
export function threeWayMerge(store: Store, repo: Repo, baseCommit: string, headCommit: string, mergeBase: string): MergeResult {
  const base = store.commitFiles(repo, baseCommit);
  const head = store.commitFiles(repo, headCommit);
  const ancestor = store.commitFiles(repo, mergeBase);
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...ancestor.keys()]);
  const files = new Map<string, Buffer>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const m = ancestor.get(path);
    if (sameBytes(h, b)) {
      if (b !== undefined) files.set(path, b);
      continue;
    }
    const headChanged = !sameBytes(h, m);
    const baseChanged = !sameBytes(b, m);
    if (headChanged && baseChanged) {
      conflicts.push(path);
      continue;
    }
    const chosen = headChanged ? h : b;
    if (chosen !== undefined) files.set(path, chosen);
  }
  return { ok: conflicts.length === 0, files, conflicts };
}

/** Whether a pull from `headRef` onto `baseRef` could merge without a conflict right now. */
export function isMergeable(store: Store, repo: Repo, headRef: string, baseRef: string): boolean | null {
  const head = store.resolveCommit(repo, headRef);
  const base = store.resolveCommit(repo, baseRef);
  if (head === null || base === null) return null;
  const mergeBase = store.mergeBase(repo, head, base);
  if (mergeBase === null) return false;
  return threeWayMerge(store, repo, base, head, mergeBase).ok;
}
