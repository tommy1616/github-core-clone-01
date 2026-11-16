# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tommy1616/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tommy1616/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge that runs as one Node 22 process using only the standard
library. It serves git smart HTTP, the REST v3 API, the GraphQL v4 API and a Model Context Protocol
endpoint from one in-memory store: no npm packages, no git binary, no child processes and no native
addons.

## What it serves

- `/<owner>/<repo>.git/...`: protocol v2 upload-pack (ls-refs, fetch, shallow clones) with a v0
  fallback, plus v0 receive-pack with fast-forward checks and side-band report status.
- `/api/v3/...`: repositories, branches, commits, contents, labels, issues, comments and pull
  requests, including tree-based pull files and squash merges.
- `/api/graphql`: the documents `gh` and `github-mcp-server` send, with introspection, Relay node
  ids, cursor pagination and the issue/pull-request mutations.
- `/mcp`: JSON-RPC 2.0 over Streamable HTTP, with `server/discover`, the legacy initialize
  handshake and thirteen tools that act on the same store as REST.

## Layout

- `main.ts`: bind an ephemeral port, register it with the env, wait for `/done`, exit cleanly.
- `app.ts`: re-exports `createApp()` from `src/app.ts` for the conformance runner.
- `src/app.ts`: the HTTP server, request ids and JSON error boundary.
- `src/store.ts`: users, repositories, refs, git objects, labels, issues, comments and pulls.
- `src/git/`: pkt-line framing, packfile read/write with deltas, and smart-HTTP handlers.
- `src/rest/`: the REST v3 route table and resource modules.
- `src/graphql/`: lexer/parser, schema and introspection, execution and resolvers.
- `src/mcp/`: the tool catalogue and the Streamable-HTTP JSON-RPC transport.
- `src/http.ts`: JSON replies, bounded body reads and the shared error type.
- `src/merge.ts`: the squash-merge path shared by REST, GraphQL and MCP.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=... node main.ts
```

The env in `MAKEFUN_ENV_URL` records the port this process registers; the suite then drives the
forge on that port. A trial runs `node /bot/main.ts` with no install step and no network beyond the
env.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
