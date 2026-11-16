// The MCP tool catalogue and its handlers. The tools act on the same Store the REST and GraphQL
// surfaces read, and their objects are rendered by the same REST serializers.

import type { RequestContext } from '../http.ts';
import type { Repo } from '../store.ts';
import { hashObject } from '../git/objects.ts';
import { performMerge } from '../merge.ts';
import { serializeComment, serializeIssue, serializePull, serializeRepo } from '../rest/serialize.ts';

type JsonSchema = Record<string, unknown>;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, JsonSchema>;
    readonly required: string[];
  };
}

function property(type: string, description: string): JsonSchema {
  return { type, description };
}

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository in the token owner account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: property('string', 'Repository name.'),
        description: property('string', 'Repository description.'),
        private: property('boolean', 'Whether the repository is private.'),
        owner: property('string', 'Owner login (the token owner is used).'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        title: property('string', 'Issue title.'),
        body: property('string', 'Issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        state: property('string', 'open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        number: property('number', 'Issue number.'),
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        number: property('number', 'Issue number.'),
        body: property('string', 'Comment body.'),
      },
      required: ['owner', 'repo', 'number', 'body'],
    },
  },
  {
    name: 'update_issue',
    description: 'Update an issue title, body or state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        number: property('number', 'Issue number.'),
        title: property('string', 'New title.'),
        body: property('string', 'New body.'),
        state: property('string', 'open or closed.'),
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        title: property('string', 'Pull request title.'),
        body: property('string', 'Pull request body.'),
        head: property('string', 'Head branch name.'),
        base: property('string', 'Base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Read one pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        pull_number: property('number', 'Pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        state: property('string', 'open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        pull_number: property('number', 'Pull request number.'),
        merge_method: property('string', 'merge, squash or rebase.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read one file from a repository at an optional ref.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: property('string', 'Repository owner login.'),
        repo: property('string', 'Repository name.'),
        path: property('string', 'File path inside the repository.'),
        ref: property('string', 'Branch, tag or commit id.'),
      },
      required: ['owner', 'repo', 'path'],
    },
  },
]);

export interface McpToolCallResult {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

class ToolError extends Error {}

function textResult(value: unknown): McpToolCallResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function errorResult(message: string): McpToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolError(`Missing required argument: ${name}`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function requiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new ToolError(`Missing required argument: ${name}`);
}

function repoOf(ctx: RequestContext, args: Record<string, unknown>): Repo {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const repo = ctx.store.requireRepo(owner, name);
  if (repo === undefined) throw new ToolError(`Repository ${owner}/${name} was not found`);
  return repo;
}

function issueOf(repo: Repo, args: Record<string, unknown>) {
  const number = requiredNumber(args, 'number');
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new ToolError(`Issue #${number} was not found`);
  return issue;
}

function pullOf(repo: Repo, args: Record<string, unknown>) {
  const number = requiredNumber(args, 'pull_number');
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new ToolError(`Pull request #${number} was not found`);
  return pull;
}

/** Run one tool; an unknown name is the caller's JSON-RPC -32602 and is handled in index.ts. */
export function callTool(ctx: RequestContext, name: string, args: Record<string, unknown>): McpToolCallResult | null {
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = requiredString(args, 'name');
        if (ctx.store.findRepo(ctx.store.viewer.login, repoName) !== undefined) {
          throw new ToolError(`Repository ${repoName} already exists`);
        }
        const repo = ctx.store.createRepo(repoName, {
          description: optionalString(args, 'description') ?? null,
          private: args.private === true,
        });
        return textResult(serializeRepo(ctx.origin, repo));
      }
      case 'get_repo': {
        const repo = repoOf(ctx, args);
        return textResult(serializeRepo(ctx.origin, repo));
      }
      case 'create_issue': {
        const repo = repoOf(ctx, args);
        const issue = ctx.store.createIssue(repo, {
          title: requiredString(args, 'title'),
          body: optionalString(args, 'body') ?? '',
          labels: [],
        });
        return textResult(serializeIssue(ctx.origin, repo, issue));
      }
      case 'list_issues': {
        const repo = repoOf(ctx, args);
        const state = optionalString(args, 'state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => b.number - a.number);
        return textResult(issues.map((issue) => serializeIssue(ctx.origin, repo, issue)));
      }
      case 'get_issue': {
        const repo = repoOf(ctx, args);
        return textResult(serializeIssue(ctx.origin, repo, issueOf(repo, args)));
      }
      case 'add_issue_comment': {
        const repo = repoOf(ctx, args);
        const issue = issueOf(repo, args);
        const comment = ctx.store.createComment(repo, issue, requiredString(args, 'body'));
        return textResult(serializeComment(ctx.origin, repo, issue, comment));
      }
      case 'update_issue': {
        const repo = repoOf(ctx, args);
        const issue = issueOf(repo, args);
        const title = optionalString(args, 'title');
        if (title !== undefined) issue.title = title;
        const body = optionalString(args, 'body');
        if (body !== undefined) issue.body = body;
        const state = optionalString(args, 'state');
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? Date.now() : null;
        }
        issue.updatedAt = Date.now();
        issue.version += 1;
        repo.updatedAt = issue.updatedAt;
        return textResult(serializeIssue(ctx.origin, repo, issue));
      }
      case 'create_pull_request': {
        const repo = repoOf(ctx, args);
        const headRef = requiredString(args, 'head');
        const baseRef = requiredString(args, 'base');
        const headSha = ctx.store.resolveCommit(repo, headRef);
        const baseSha = ctx.store.resolveCommit(repo, baseRef);
        if (headSha === null) throw new ToolError(`Head branch ${headRef} was not found`);
        if (baseSha === null) throw new ToolError(`Base branch ${baseRef} was not found`);
        const pull = ctx.store.createPull(repo, {
          title: requiredString(args, 'title'),
          body: optionalString(args, 'body') ?? '',
          headRef,
          baseRef,
          headSha,
          baseSha,
        });
        return textResult(serializePull(ctx.origin, ctx.store, repo, pull));
      }
      case 'get_pull_request': {
        const repo = repoOf(ctx, args);
        return textResult(serializePull(ctx.origin, ctx.store, repo, pullOf(repo, args)));
      }
      case 'list_pull_requests': {
        const repo = repoOf(ctx, args);
        const state = optionalString(args, 'state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.number - a.number);
        return textResult(pulls.map((pull) => serializePull(ctx.origin, ctx.store, repo, pull)));
      }
      case 'merge_pull_request': {
        const repo = repoOf(ctx, args);
        const pull = pullOf(repo, args);
        const outcome = performMerge(ctx.store, repo, pull);
        if (!outcome.ok) throw new ToolError(outcome.reason === 'conflict' ? 'Pull request is not mergeable' : 'Pull request cannot be merged');
        return textResult(serializePull(ctx.origin, ctx.store, repo, pull));
      }
      case 'list_branches': {
        const repo = repoOf(ctx, args);
        const branches = ctx.store.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha },
        }));
        return textResult(branches);
      }
      case 'get_file_contents': {
        const repo = repoOf(ctx, args);
        const path = requiredString(args, 'path');
        const ref = optionalString(args, 'ref') ?? repo.defaultBranch;
        const commit = ctx.store.resolveCommit(repo, ref);
        if (commit === null) throw new ToolError(`Ref ${ref} was not found`);
        const files = ctx.store.commitFiles(repo, commit);
        const content = files.get(path);
        if (content === undefined) throw new ToolError(`File ${path} was not found`);
        return textResult({
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          sha: hashObject('blob', content),
          size: content.length,
          encoding: 'base64',
          content: content.toString('base64'),
        });
      }
      default:
        return null;
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** Used by the transport for the missing-arguments path without invoking a tool. */
export function isKnownTool(name: string): boolean {
  return MCP_TOOLS.some((tool) => tool.name === name);
}
