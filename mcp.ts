// mcp.ts — Model Context Protocol: JSON-RPC 2.0 over Streamable HTTP.
//
// The suite's client speaks the modern 2026-07-28 transport first
// (server/discover, no handshake) and falls back to the legacy handshake
// (initialize + notifications/initialized, revisions 2025-11-25 down to
// 2024-11-05). Six tools are offered, each with a non-empty description and an
// object inputSchema; the tools list is a module constant, so two tools/list
// calls answer byte-identically. Tools read and write the same store as REST
// and GraphQL. Unknown tools answer -32602, missing arguments answer
// isError:true, a non-JSON body answers HTTP 400 with -32700.

import { globalId, nowMs, repoKey, VIEWER, type Repo, type Store } from './store.ts';
import { createIssueRecord, createPullRecord, mergePullRecord } from './graphql.ts';

export interface McpResult {
  status: number;
  body: Buffer;
  contentType: string;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list is built once: two tools/list calls answer byte-identically. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// views (the JSON a tool returns as text and as structured content)
// ---------------------------------------------------------------------------------------------

function repoView(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: new Date(repo.createdMs).toISOString(),
    has_issues: true,
  };
}

function issueView(repo: Repo, issue: Repo['issues'] extends Map<number, infer V> ? V : never, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: new Date(issue.createdMs).toISOString(),
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Repo['pulls'] extends Map<number, infer V> ? V : never, origin: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { ok: true; data: unknown } | { ok: false; message: string };

function findRepo(store: Store, owner: unknown, repoName: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner.toLowerCase() !== VIEWER.login) return null;
  return store.repos.get(repoKey(owner, repoName)) ?? null;
}

function createRepoTool(store: Store, args: Record<string, unknown>, origin: string): ToolOutcome {
  const name = args.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, message: 'Invalid repository name' };
  }
  if (store.repos.has(repoKey(VIEWER.login, name))) return { ok: false, message: 'Repository already exists' };
  const repo: Repo = {
    id: store.nextRepoId,
    name,
    owner: VIEWER.login,
    description: typeof args.description === 'string' ? args.description : '',
    private: args.private === true,
    defaultBranch: 'main',
    createdMs: nowMs(),
    seq: store.seq,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
  };
  store.nextRepoId += 1;
  store.seq += 1;
  store.repos.set(repoKey(VIEWER.login, name), repo);
  return { ok: true, data: repoView(repo, origin) };
}

function callTool(store: Store, name: string, args: Record<string, unknown>, origin: string): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, message: `Unknown tool: ${name}` };
  const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) return { ok: false, message: `Missing required argument(s): ${missing.join(', ')}` };

  if (name === 'create_repo') return createRepoTool(store, args, origin);

  const repo = findRepo(store, args.owner, args.repo);
  if (!repo) return { ok: false, message: 'Repository not found' };

  if (name === 'get_repo') return { ok: true, data: repoView(repo, origin) };

  if (name === 'create_issue') {
    const title = args.title as string;
    const issue = createIssueRecord(store, repo, title, typeof args.body === 'string' ? args.body : '');
    return { ok: true, data: issueView(repo, issue, origin) };
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => b.createdMs - a.createdMs || b.number - a.number);
    return { ok: true, data: { issues: list.map((issue) => issueView(repo, issue, origin)) } };
  }

  if (name === 'create_pull_request') {
    const created = createPullRecord(
      store,
      repo,
      args.title as string,
      args.head as string,
      args.base as string,
      typeof args.body === 'string' ? args.body : '',
    );
    if (typeof created === 'string') return { ok: false, message: created };
    return { ok: true, data: pullView(repo, created, origin) };
  }

  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(number);
    if (!pull) return { ok: false, message: 'Pull request not found' };
    const result = mergePullRecord(repo, pull);
    if (!result.ok) return { ok: false, message: result.reason };
    return {
      ok: true,
      data: { merged: true, sha: result.sha, number: pull.number, state: 'closed', message: 'Pull request successfully merged' },
    };
  }

  return { ok: false, message: `Unknown tool: ${name}` };
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------------------------

function jsonResult(status: number, payload: unknown): McpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8') };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return jsonResult(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, result });
}

export function handleMcp(store: Store, rawBody: Buffer, origin: string): McpResult {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const record = request as Record<string, unknown>;
  const id = record.id;
  const method = record.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL.',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const params = (record.params as Record<string, unknown> | undefined) ?? {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = (record.params as Record<string, unknown> | undefined) ?? {};
    const toolName = params.name;
    if (typeof toolName !== 'string') return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return rpcError(id, -32602, 'Invalid params: arguments must be an object');
    }
    const outcome = callTool(store, toolName, args, origin);
    if (!outcome.ok) {
      if (outcome.message.startsWith('Unknown tool:')) return rpcError(id, -32602, outcome.message);
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.message }],
        isError: true,
      });
    }
    const text = JSON.stringify(outcome.data);
    return rpcResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.data,
      isError: false,
    });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
