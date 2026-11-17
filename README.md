# github-core-clone-01 — a GitHub-compatible git forge

One Node process serves four surfaces from a single in-memory store, with no
dependencies, no git binary, no UI and no outside service:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, ls-refs, fetch with depth/shallow and thin-pack
  awareness) and receive-pack v0 (report-status, side-band-64k, delete-refs,
  fast-forward enforcement). The object store is written from scratch:
  loose SHA-1 objects, tree/commit/tag builders and parsers, and a packfile
  reader (plain, OFS_DELTA and REF_DELTA) and writer (plain objects, no
  deltas). Pushes only fast-forward; a mixed push applies the good refs and
  reports each ref's outcome.
- **REST v3** at `/api/v3` — repositories (CRUD, pagination with `Link`),
  branches, commits, git refs, contents (create/update/delete with SHA
  checks), labels, issues and comments, pull requests (create, list, files,
  squash merge with a three-way merge and conflict detection).
- **GraphQL** at `/api/graphql` — a small hand-written parser and executor
  for the documents the suite sends: viewer, repository (with issue and pull
  request connections, pagination cursors, ordering), node ids, the
  createIssue / closeIssue / createPullRequest / mergePullRequest / addComment
  mutations, batched operations, and `__type` introspection for Issue,
  PullRequest, Repository and the SearchType enum.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern 2026-07-28
  `server/discover` transport and the legacy initialize handshake, with six
  tools: create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request.

## Run

```sh
node main.ts
```

The server binds an ephemeral port on 127.0.0.1. Under the trial it registers
that port with `$MAKEFUN_ENV_URL` and exits when the suite polls `/done`;
without the environment it just keeps listening and prints its port.
Authentication is `Authorization: Bearer <token>`; when `MAKEFUN_SHOP_TOKEN`
is set the token must match it, otherwise any non-empty Bearer token names
the viewer (`adaiversen`). Node 22.18+ (type stripping) is required.

## Layout

- `main.ts` — lifecycle: bind, register, wait for `/done`.
- `app.ts` — HTTP server, routing, auth, request ids, body limits.
- `store.ts` — the in-memory store plus the git object model (hashing,
  trees, commits, tags, reachability, three-way merge, diff).
- `pack.ts` — pkt-line framing and packfile read/write.
- `gitproto.ts` — git smart HTTP handlers.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP JSON-RPC handlers and tools.
