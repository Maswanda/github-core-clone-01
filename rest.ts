// rest.ts — REST v3: repositories, branches, commits, contents, labels,
// issues, pull requests. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON with a string `message`; unknown routes
// are 404 JSON; malformed JSON is 400. Auth is Bearer <token> (any token names
// the scenario viewer); a repo under another login is 404, never 403.

import {
  buildCommit,
  buildTreeFromMap,
  diffTrees,
  findMergeBase,
  flattenTree,
  globalId,
  isObjectId,
  nowIso,
  nowMs,
  parseCommit,
  putObject,
  repoKey,
  resolveCommit,
  resolveTree,
  threeWayMerge,
  VIEWER,
  walkCommits,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { findGitRepo } from './gitproto.ts';

export interface RestRequest {
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
}

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBodyObject(req: RestRequest): Record<string, unknown> | RestResult {
  if (!isRecord(req.body)) return err(400, 'Request body must be a JSON object');
  return req.body;
}

function requireString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------------------------
// pagination + Link header
// ---------------------------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(Math.max(perPageRaw, 1), 100) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  return { pageItems: items.slice(start, start + page.perPage), totalPages };
}

function linkHeader(req: RestRequest, page: Page, totalPages: number): string {
  const build = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(p));
    params.set('per_page', String(page.perPage));
    return `<${req.origin}${req.path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page.page < totalPages) links.push(`${build(page.page + 1)}; rel="next"`);
  if (page.page > 1) links.push(`${build(page.page - 1)}; rel="prev"`);
  links.push(`${build(1)}; rel="first"`);
  links.push(`${build(totalPages)}; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('User', VIEWER.id), type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    created_at: new Date(repo.createdMs).toISOString(),
    updated_at: new Date(repo.createdMs).toISOString(),
    pushed_at: new Date(repo.createdMs).toISOString(),
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) as Label)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: new Date(issue.createdMs).toISOString(),
    updated_at: new Date(issue.updatedMs).toISOString(),
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    locked: false,
  };
}

function pullJson(repo: Repo, pull: Pull, origin: string, mergeable?: boolean): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo, origin),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo, origin),
    },
    merged: pull.merged,
    mergeable: mergeable ?? computeMergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: new Date(pull.createdMs).toISOString(),
    updated_at: new Date(pull.createdMs).toISOString(),
    closed_at: pull.mergedAt,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number], origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: new Date(comment.createdMs).toISOString(),
    updated_at: new Date(comment.createdMs).toISOString(),
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function branchJson(repo: Repo, branch: string, tip: string): Record<string, unknown> {
  return { name: branch, commit: { sha: tip, url: '' }, protected: false };
}

function parseIdentity(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (!match) return { name: raw, email: '', date: nowIso() };
  const timestamp = Number.parseInt(match[3] as string, 10) * 1000;
  return { name: match[1] as string, email: match[2] as string, date: new Date(timestamp).toISOString() };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object ? parseCommit(object.data) : null;
  const message = commit ? commit.message.replace(/\n+$/, '') : '';
  const author = commit ? parseIdentity(commit.author) : { name: '', email: '', date: nowIso() };
  const committer = commit ? parseIdentity(commit.committer) : { name: '', email: '', date: nowIso() };
  return {
    sha: oid,
    commit: {
      message,
      author,
      committer,
      tree: { sha: commit?.tree ?? '' },
    },
    parents: (commit?.parents ?? []).map((sha) => ({ sha })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

/** Is this pull mergeable right now (no three-way conflict against the base tip)? */
function computeMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.merged) return false;
  const baseTip = resolveCommit(repo, `refs/heads/${pull.baseRef}`);
  const headTip = resolveCommit(repo, `refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return false;
  const base = findMergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
  const oursTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const theirsTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  return threeWayMerge(repo, baseTree, oursTree, theirsTree).conflicts.length === 0;
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleRest(store: Store, req: RestRequest): RestResult {
  const segments = req.segments;
  const method = req.method;

  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          current_user_url: `${req.origin}/api/v3/user`,
          repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
          user_url: `${req.origin}/api/v3/users/{user}`,
        },
      };
    }
    return err(404, 'Not Found');
  }

  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true, github_enterprise_version: '1.0.0' } };
  }

  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return { status: 200, body: { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email, type: 'User' } };
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const all = [...store.repos.values()]
          .filter((repo) => repo.owner === VIEWER.login)
          .sort((a, b) => a.seq - b.seq);
        const page = pageOf(req.query);
        const { pageItems, totalPages } = paginate(all, page);
        return { status: 200, body: pageItems.map((repo) => repoJson(repo, req.origin)), headers: { Link: linkHeader(req, page, totalPages) } };
      }
      if (method === 'POST') {
        const body = requireBodyObject(req);
        if (!isRecord(body)) return body as RestResult;
        const name = requireString(body, 'name');
        if (name === null || name.length === 0 || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
          return err(422, 'Invalid repository name');
        }
        if (store.repos.has(repoKey(VIEWER.login, name))) return err(422, 'Repository already exists');
        const description = typeof body.description === 'string' ? body.description : '';
        const isPrivate = body.private === true;
        const repo: Repo = {
          id: store.nextRepoId,
          name,
          owner: VIEWER.login,
          description,
          private: isPrivate,
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
        return { status: 201, body: repoJson(repo, req.origin) };
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = findGitRepo(store, owner, name);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(repo, req.origin) };
      if (method === 'PATCH') {
        const body = requireBodyObject(req);
        if (!isRecord(body)) return body as RestResult;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
        return { status: 200, body: repoJson(repo, req.origin) };
      }
      if (method === 'DELETE') {
        store.repos.delete(repoKey(owner, name));
        return { status: 204 };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const names = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length));
        names.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a.localeCompare(b)));
        return { status: 200, body: names.map((branch) => branchJson(repo, branch, repo.refs.get(`refs/heads/${branch}`) as string)) };
      }
      if (rest.length === 2) {
        const branch = rest[1] as string;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        return { status: 200, body: branchJson(repo, branch, tip) };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (rest.length !== 1 || method !== 'GET') return err(404, 'Not Found');
      const shaParam = req.query.get('sha') ?? repo.defaultBranch;
      const tip = resolveCommit(repo, shaParam);
      if (tip === null) return err(404, 'Not Found');
      return { status: 200, body: walkCommits(repo, tip).map((oid) => commitJson(repo, oid)) };
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = requireBodyObject(req);
        if (!isRecord(body)) return body as RestResult;
        const ref = requireString(body, 'ref');
        const sha = requireString(body, 'sha');
        if (ref === null || !ref.startsWith('refs/')) return err(422, 'Invalid ref');
        if (sha === null || !isObjectId(sha) || !repo.objects.has(sha)) return err(422, 'Invalid SHA');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, object: { sha }, node_id: globalId('GitRef', repo.id, ref) } };
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).join('/');
        const oid = repo.refs.get(ref);
        if (!oid) return err(404, 'Not Found');
        return { status: 200, body: { ref, object: { sha: oid }, node_id: globalId('GitRef', repo.id, ref) } };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      return handleContents(store, repo, req, rest.slice(1).join('/'));
    }

    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return { status: 200, body: [...repo.labels.values()].map(labelJson) };
      }
      if (method === 'POST' && rest.length === 1) {
        const body = requireBodyObject(req);
        if (!isRecord(body)) return body as RestResult;
        const name = requireString(body, 'name');
        if (name === null || name.length === 0) return err(422, 'Label name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const color = requireString(body, 'color') ?? 'ededed';
        const label: Label = { name, color };
        repo.labels.set(name, label);
        return { status: 201, body: labelJson(label) };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      return handleIssues(store, repo, req, rest.slice(1));
    }

    if (rest[0] === 'pulls') {
      return handlePulls(store, repo, req, rest.slice(1));
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function commitOnBranch(repo: Repo, branch: string, message: string, mutate: (flat: Map<string, { mode: string; oid: string }>) => void): string {
  const existing = repo.refs.get(`refs/heads/${branch}`);
  const baseTip = existing ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const baseTree = baseTip === undefined ? null : parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const flat = baseTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, baseTree);
  mutate(flat);
  const newTree = buildTreeFromMap(repo, flat);
  const parents = baseTip === undefined ? [] : [baseTip];
  const commit = putObject(repo, 'commit', buildCommit({ tree: newTree, parents, message, authorName: VIEWER.name, authorEmail: VIEWER.email }));
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

function handleContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResult {
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  if (req.method === 'GET') {
    const resolved = resolveTree(repo, ref);
    if (resolved === null) return err(404, 'Not Found');
    const flat = flattenTree(repo, resolved.treeOid);
    const direct = flat.get(path);
    if (path === '') {
      return { status: 200, body: directoryListing(repo, flat, '') };
    }
    if (direct !== undefined) {
      const data = repo.objects.get(direct.oid)?.data ?? Buffer.alloc(0);
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop(),
          path,
          sha: direct.oid,
          content: data.toString('base64'),
          url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: `${req.origin}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
          download_url: null,
        },
      };
    }
    const prefix = `${path}/`;
    if ([...flat.keys()].some((key) => key.startsWith(prefix))) {
      return { status: 200, body: directoryListing(repo, flat, path) };
    }
    return err(404, 'Not Found');
  }

  if (req.method === 'PUT') {
    const body = requireBodyObject(req);
    if (!isRecord(body)) return body as RestResult;
    const content = requireString(body, 'content');
    if (content === null) return err(400, 'content is required');
    const cleaned = content.replace(/\s/g, '');
    const decoded = Buffer.from(cleaned, 'base64');
    if (decoded.toString('base64') !== cleaned) return err(400, 'content is not valid base64');
    const message = requireString(body, 'message') ?? `Update ${path}`;
    const branch = requireString(body, 'branch') ?? repo.defaultBranch;
    const expectedSha = requireString(body, 'sha');
    const baseTip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let existingSha: string | undefined;
    if (baseTip !== undefined) {
      const baseTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
      existingSha = flattenTree(repo, baseTree).get(path)?.oid;
    }
    if (existingSha !== undefined) {
      if (expectedSha === null || expectedSha !== existingSha) return err(409, 'sha does not match the current file');
    }
    const blobOid = putObject(repo, 'blob', decoded);
    const commitOid = commitOnBranch(repo, branch, message, (flat) => {
      flat.set(path, { mode: '100644', oid: blobOid });
    });
    return {
      status: existingSha === undefined ? 201 : 200,
      body: {
        content: {
          name: path.split('/').pop(),
          path,
          sha: blobOid,
          size: decoded.length,
          type: 'file',
          encoding: 'base64',
          content: decoded.toString('base64'),
          url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        },
        commit: { sha: commitOid, message },
      },
    };
  }

  if (req.method === 'DELETE') {
    const body = requireBodyObject(req);
    if (!isRecord(body)) return body as RestResult;
    const message = requireString(body, 'message') ?? `Delete ${path}`;
    const branch = requireString(body, 'branch') ?? repo.defaultBranch;
    const expectedSha = requireString(body, 'sha');
    const baseTip = repo.refs.get(`refs/heads/${branch}`);
    if (baseTip === undefined) return err(404, 'Not Found');
    const baseTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const existing = flattenTree(repo, baseTree).get(path);
    if (existing === undefined) return err(404, 'Not Found');
    if (expectedSha !== null && expectedSha !== existing.oid) return err(409, 'sha does not match the current file');
    const commitOid = commitOnBranch(repo, branch, message, (flat) => {
      flat.delete(path);
    });
    return { status: 200, body: { content: null, commit: { sha: commitOid, message } } };
  }

  return err(404, 'Not Found');
}

function directoryListing(repo: Repo, flat: Map<string, { mode: string; oid: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const segment = rest.split('/')[0] as string;
    if (rest.includes('/')) {
      if (!children.has(segment)) children.set(segment, { type: 'dir', oid: '', size: 0 });
    } else {
      const data = repo.objects.get(entry.oid)?.data;
      children.set(segment, { type: 'file', oid: entry.oid, size: data?.length ?? 0 });
    }
  }
  return [...children.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, child]) => ({
      type: child.type,
      name,
      path: prefix + name,
      sha: child.oid,
      size: child.size,
      url: '',
    }));
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = requireBodyObject(req);
      if (!isRecord(body)) return body as RestResult;
      const title = requireString(body, 'title');
      if (title === null || title.length === 0) return err(422, 'title is required');
      const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
      }
      const issue: Issue = {
        id: store.nextEntityId,
        number: repo.nextNumber,
        title,
        body: requireString(body, 'body') ?? '',
        state: 'open',
        labels: labelNames,
        createdMs: nowMs(),
        seq: store.seq,
        updatedMs: nowMs(),
        closedAt: null,
        comments: [],
        globalId: '',
      };
      store.seq += 1;
      store.nextEntityId += 1;
      repo.nextNumber += 1;
      issue.globalId = globalId('Issue', repo.id, issue.number);
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(repo, issue, req.origin) };
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      const byCreated = (a: Issue, b: Issue): number => (a.createdMs - b.createdMs) || (a.number - b.number);
      const byUpdated = (a: Issue, b: Issue): number => (a.updatedMs - b.updatedMs) || (a.number - b.number);
      const byComments = (a: Issue, b: Issue): number => (a.comments.length - b.comments.length) || (a.number - b.number);
      const compare = sort === 'updated' ? byUpdated : sort === 'comments' ? byComments : byCreated;
      list.sort((a, b) => (direction === 'asc' ? compare(a, b) : -compare(a, b)));
      const page = pageOf(req.query);
      const { pageItems, totalPages } = paginate(list, page);
      return { status: 200, body: pageItems.map((issue) => issueJson(repo, issue, req.origin)), headers: { Link: linkHeader(req, page, totalPages) } };
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (req.method === 'GET') return { status: 200, body: issueJson(repo, issue, req.origin) };
    if (req.method === 'PATCH') {
      const body = requireBodyObject(req);
      if (!isRecord(body)) return body as RestResult;
      if (typeof body.title === 'string' && body.title.length > 0) issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labelNames = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
        for (const name of labelNames) {
          if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
        }
        issue.labels = labelNames;
      }
      if (body.state === 'closed') {
        issue.state = 'closed';
        issue.closedAt = nowIso();
      } else if (body.state === 'open') {
        issue.state = 'open';
        issue.closedAt = null;
      }
      issue.updatedMs = nowMs();
      return { status: 200, body: issueJson(repo, issue, req.origin) };
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (req.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment, req.origin)) };
    }
    if (req.method === 'POST') {
      const body = requireBodyObject(req);
      if (!isRecord(body)) return body as RestResult;
      const commentBody = requireString(body, 'body');
      if (commentBody === null) return err(422, 'body is required');
      const commentId = store.nextEntityId;
      store.nextEntityId += 1;
      const comment: Issue['comments'][number] = {
        id: commentId,
        body: commentBody,
        createdMs: nowMs(),
        globalId: globalId('IssueComment', repo.id, issue.number, commentId),
      };
      issue.comments.push(comment);
      issue.updatedMs = nowMs();
      return { status: 201, body: commentJson(repo, issue, comment, req.origin) };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function handlePulls(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = requireBodyObject(req);
      if (!isRecord(body)) return body as RestResult;
      const title = requireString(body, 'title');
      if (title === null || title.length === 0) return err(422, 'title is required');
      const headRaw = requireString(body, 'head');
      const baseRaw = requireString(body, 'base');
      if (headRaw === null || baseRaw === null) return err(422, 'head and base are required');
      const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (headTip === undefined) return err(422, `Head branch '${headRef}' does not exist`);
      if (baseTip === undefined) return err(422, `Base branch '${baseRef}' does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          return err(422, 'A pull request already exists for this branch');
        }
      }
      const pull: Pull = {
        id: store.nextEntityId,
        number: repo.nextNumber,
        title,
        body: requireString(body, 'body') ?? '',
        state: 'open',
        headRef,
        baseRef,
        headSha: headTip,
        baseSha: baseTip,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdMs: nowMs(),
        seq: store.seq,
        globalId: '',
      };
      store.seq += 1;
      store.nextEntityId += 1;
      repo.nextNumber += 1;
      pull.globalId = globalId('PullRequest', repo.id, pull.number);
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullJson(repo, pull, req.origin) };
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.createdMs - a.createdMs || b.number - a.number);
      const page = pageOf(req.query);
      const { pageItems, totalPages } = paginate(list, page);
      return { status: 200, body: pageItems.map((pull) => pullJson(repo, pull, req.origin)), headers: { Link: linkHeader(req, page, totalPages) } };
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (req.method === 'GET') return { status: 200, body: pullJson(repo, pull, req.origin) };
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (req.method !== 'GET') return err(404, 'Not Found');
    const baseTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
    const files = diffTrees(repo, baseTree, headTree).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    }));
    return { status: 200, body: files };
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (req.method !== 'PUT') return err(404, 'Not Found');
    if (pull.merged) return err(405, 'Pull request has already been merged');
    if (pull.state !== 'open') return err(405, 'Pull request is not open');
    const baseTip = resolveCommit(repo, `refs/heads/${pull.baseRef}`);
    const headTip = resolveCommit(repo, `refs/heads/${pull.headRef}`);
    if (baseTip === null || headTip === null) return err(405, 'Head or base branch is missing');
    const mergeBase = findMergeBase(repo, baseTip, headTip);
    if (mergeBase === null) return err(405, 'No merge base between head and base');
    const baseTree = parseCommit(repo.objects.get(mergeBase)?.data ?? Buffer.alloc(0)).tree;
    const oursTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const theirsTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const { merged, conflicts } = threeWayMerge(repo, baseTree, oursTree, theirsTree);
    if (merged === null || conflicts.length > 0) return err(405, 'Merge conflict');
    const mergedTree = buildTreeFromMap(repo, merged);
    const mergeCommit = putObject(
      repo,
      'commit',
      buildCommit({
        tree: mergedTree,
        parents: [baseTip],
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
        authorName: VIEWER.name,
        authorEmail: VIEWER.email,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeCommit;
    return { status: 200, body: { sha: mergeCommit, merged: true, message: 'Pull request successfully merged' } };
  }

  return err(404, 'Not Found');
}
