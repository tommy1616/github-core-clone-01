// The one squash-merge path REST and GraphQL share: a three-way merge over real trees, one commit
// on the base branch, and the pull request updated to closed/merged.

import { buildCommit, buildTreeFromContents, putObject } from './git/objects.ts';
import type { Pull, Repo, Store } from './store.ts';
import { threeWayMerge } from './rest/diff.ts';

export type MergeOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: 'closed' | 'missing-ref' | 'no-merge-base' | 'conflict'; readonly conflicts?: string[] };

export function performMerge(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'closed' };
  const headSha = store.resolveCommit(repo, pull.headRef);
  const baseSha = store.resolveCommit(repo, pull.baseRef);
  if (headSha === null || baseSha === null) return { ok: false, reason: 'missing-ref' };
  const mergeBase = store.mergeBase(repo, headSha, baseSha);
  if (mergeBase === null) return { ok: false, reason: 'no-merge-base' };
  const merged = threeWayMerge(store, repo, baseSha, headSha, mergeBase);
  if (!merged.ok) return { ok: false, reason: 'conflict', conflicts: merged.conflicts };
  const tree = buildTreeFromContents(repo.objects, merged.files);
  const viewer = store.viewer;
  const commitSha = putObject(
    repo.objects,
    'commit',
    buildCommit({
      tree,
      parents: [baseSha],
      message: `${pull.title} (#${pull.number})`,
      author: { name: viewer.name, email: viewer.email },
    }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  const now = Date.now();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = now;
  repo.updatedAt = now;
  repo.pushedAt = now;
  return { ok: true, sha: commitSha };
}
