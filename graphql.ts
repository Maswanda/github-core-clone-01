// graphql.ts — a small GraphQL executor for the shapes the suite (and the
// github-mcp-server documents it mirrors) actually sends.
//
// It is not a full spec implementation: it parses one document (query or
// mutation, with variables, aliases, inline arguments, fragments and batched
// arrays), validates fields against a fixed schema, and resolves against the
// same in-memory store as REST and MCP. Unknown fields are errors with the
// field's name in the message (HTTP 200, `errors` array); an unknown
// repository resolves to null without errors, exactly as GitHub behaves.

import {
  buildCommit,
  buildTreeFromMap,
  diffTrees,
  findMergeBase,
  globalId,
  nowIso,
  nowMs,
  parseCommit,
  parseGlobalId,
  putObject,
  resolveCommit,
  threeWayMerge,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer + parser
// ---------------------------------------------------------------------------------------------

interface Token {
  type: 'punct' | 'name' | 'string' | 'int' | 'float' | 'variable';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=@&|'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ type: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum' | 'null'; value: string | number | boolean | null }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldSelection {
  kind: 'field';
  name: string;
  alias?: string;
  arguments: Record<string, ValueNode>;
  selections: Selection[];
}

export interface InlineFragment {
  kind: 'inline';
  typeCondition?: string;
  selections: Selection[];
}

export interface FragmentSpread {
  kind: 'spread';
  name: string;
}

export type Selection = FieldSelection | InlineFragment | FragmentSpread;

export interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions: Record<string, ValueNode | undefined>;
  selections: Selection[];
}

export interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Record<string, FragmentDefinition>;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error('unexpected end of document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Document {
    const document: Document = { operations: [], fragments: {} };
    while (this.peek()) {
      const token = this.peek() as Token;
      if (token.type === 'punct' && token.value === '{') {
        document.operations.push({ operation: 'query', variableDefinitions: {}, selections: this.parseSelectionSet() });
      } else if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        document.operations.push(this.parseOperation());
      } else if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        document.fragments[name] = { name, typeCondition, selections };
      } else {
        throw new Error(`unexpected token ${token.value} at the top of the document`);
      }
    }
    return document;
  }

  private parseOperation(): Operation {
    const keyword = this.next();
    const operation = (keyword.value === 'mutation' ? 'mutation' : 'query') as 'query' | 'mutation';
    let name: string | undefined;
    const next = this.peek();
    if (next && next.type === 'name') name = this.next().value;
    const variableDefinitions: Record<string, ValueNode | undefined> = {};
    const open = this.peek();
    if (open && open.type === 'punct' && open.value === '(') {
      this.next();
      while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === ')')) {
        const varToken = this.next();
        if (varToken.type !== 'variable') throw new Error(`expected a variable, got ${varToken.value}`);
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        const eq = this.peek();
        if (eq && eq.type === 'punct' && eq.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions[varToken.value] = defaultValue;
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selections };
  }

  private parseType(): void {
    const token = this.next();
    if (token.type === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (token.type !== 'name') {
      throw new Error(`expected a type name, got ${token.value}`);
    }
    const bang = this.peek();
    if (bang && bang.type === 'punct' && bang.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.type === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek() as Token;
      if (next.type === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.type === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | undefined;
    let fieldName = name;
    const colon = this.peek();
    if (colon && colon.type === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    const open = this.peek();
    if (open && open.type === 'punct' && open.value === '(') {
      this.next();
      while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    const brace = this.peek();
    const selections: Selection[] = brace && brace.type === 'punct' && brace.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name: fieldName, alias, arguments: args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'variable') return { kind: 'variable', name: token.value };
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.type === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() && !(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function parseDocument(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// schema: which fields exist on each type, and the type of fields that nest
// ---------------------------------------------------------------------------------------------

const FIELDS: Record<string, ReadonlySet<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name', 'email', 'url']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'url', 'createdAt']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body']),
  Ref: new Set(['name']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PullRequestChangedFileEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  IssueComment: new Set(['id', 'body']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  CommentEdge: new Set(['node', 'cursor']),
};

const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'REGISTRY_PACKAGE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  variableDefinitions: Record<string, ValueNode | undefined>;
  fragments: Record<string, FragmentDefinition>;
  errors: Array<{ message: string }>;
}

type AnyRecord = Record<string, unknown>;

function resolveValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable': {
      if (Object.prototype.hasOwnProperty.call(ctx.variables, node.name)) return ctx.variables[node.name];
      const fallback = ctx.variableDefinitions[node.name];
      return fallback === undefined ? null : resolveValue(fallback, ctx);
    }
    case 'list':
      return node.values.map((child) => resolveValue(child, ctx));
    case 'object': {
      const out: AnyRecord = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = resolveValue(child, ctx);
      return out;
    }
    default:
      return node.value;
  }
}

function resolveArguments(field: FieldSelection, ctx: ExecContext): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, node] of Object.entries(field.arguments)) out[key] = resolveValue(node, ctx);
  return out;
}

function executeSelections(selections: Selection[], parentType: string, parent: AnyRecord, ctx: ExecContext): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments[selection.name];
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      Object.assign(out, executeSelections(fragment.selections, parentType, parent, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && parent.__typename !== selection.typeCondition) continue;
      Object.assign(out, executeSelections(selection.selections, parentType, parent, ctx));
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = parent.__typename ?? parentType;
      continue;
    }
    const allowed = FIELDS[parentType];
    if (!allowed || !allowed.has(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      out[responseKey] = null;
      continue;
    }
    const args = resolveArguments(field, ctx);
    const value = resolveField(parentType, field.name, parent, args, ctx);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (field.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    let childType = FIELD_TYPE[parentType]?.[field.name];
    if (parentType === 'Query' && field.name === 'node') childType = (value as AnyRecord).__typename as string;
    if (!childType) {
      out[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => executeSelections(field.selections, childType as string, item as AnyRecord, ctx));
    } else {
      out[responseKey] = executeSelections(field.selections, childType, value as AnyRecord, ctx);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// values: wrap store records so resolvers can read them uniformly
// ---------------------------------------------------------------------------------------------

function userValue(): AnyRecord {
  return { __typename: 'User', login: VIEWER.login, id: globalId('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email, url: '' };
}

function repoValue(repo: Repo): AnyRecord {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): AnyRecord {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): AnyRecord {
  return { __typename: 'PullRequest', repo, pull };
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findByGlobalId(store: Store, id: string): { kind: string; repo: Repo | null; issue?: Issue; pull?: Pull } | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const [first, second] = parsed.parts;
  if (parsed.kind === 'Repository') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    return repo === null ? null : { kind: 'Repository', repo };
  }
  if (parsed.kind === 'Issue') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    if (!repo) return null;
    const issue = repo.issues.get(Number.parseInt(second ?? '', 10));
    return issue === undefined ? null : { kind: 'Issue', repo, issue };
  }
  if (parsed.kind === 'PullRequest') {
    const repo = findRepoById(store, Number.parseInt(first ?? '', 10));
    if (!repo) return null;
    const pull = repo.pulls.get(Number.parseInt(second ?? '', 10));
    return pull === undefined ? null : { kind: 'PullRequest', repo, pull };
  }
  return null;
}

function encodeCursor(number: number): string {
  return Buffer.from(`c:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('c:')) return null;
    const n = Number.parseInt(text.slice(2), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function computeMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'CONFLICTING';
  const baseTip = resolveCommit(repo, `refs/heads/${pull.baseRef}`);
  const headTip = resolveCommit(repo, `refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = findMergeBase(repo, baseTip, headTip);
  if (base === null) return 'UNKNOWN';
  const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
  const oursTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const theirsTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  return threeWayMerge(repo, baseTree, oursTree, theirsTree).conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

function resolveIssues(repo: Repo, args: AnyRecord): AnyRecord {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const orderBy = (args.orderBy as AnyRecord | undefined) ?? {};
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? args.after : undefined;
  let list = [...repo.issues.values()].filter((issue) => states.includes(issue.state.toUpperCase()));
  list.sort((a, b) => {
    const ka = field === 'UPDATED_AT' ? a.updatedMs : a.createdMs;
    const kb = field === 'UPDATED_AT' ? b.updatedMs : b.createdMs;
    const compared = ka - kb || a.number - b.number;
    return direction === 'DESC' ? -compared : compared;
  });
  let start = 0;
  if (after !== undefined) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      const index = list.findIndex((issue) => issue.number === cursorNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const page = list.slice(start, start + first);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue(repo, issue)),
    edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueValue(repo, issue), cursor: encodeCursor(issue.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < list.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(page[0]?.number ?? 0) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null,
    },
    totalCount: list.length,
  };
}

function resolvePullRequests(repo: Repo, args: AnyRecord): AnyRecord {
  const first = typeof args.first === 'number' ? args.first : 30;
  const list = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.createdMs - a.createdMs || b.number - a.number);
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullValue(repo, pull)),
    edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullValue(repo, pull), cursor: encodeCursor(pull.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < list.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(page[0]?.number ?? 0) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null,
    },
    totalCount: list.length,
  };
}

function resolvePullFiles(repo: Repo, pull: Pull, args: AnyRecord): AnyRecord {
  const first = typeof args.first === 'number' ? args.first : 30;
  const baseTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
  const files = diffTrees(repo, baseTree, headTree).slice(0, first);
  const nodes = files.map((change) => ({
    __typename: 'PullRequestChangedFile',
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
  }));
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'PullRequestChangedFileEdge', node, cursor: '' })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: nodes.length,
  };
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

export function createIssueRecord(store: Store, repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: store.nextEntityId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [],
    createdMs: nowMs(),
    seq: store.seq,
    updatedMs: nowMs(),
    closedAt: null,
    comments: [],
    globalId: '',
  };
  store.nextEntityId += 1;
  store.seq += 1;
  repo.nextNumber += 1;
  issue.globalId = globalId('Issue', repo.id, issue.number);
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(store: Store, repo: Repo, title: string, headRef: string, baseRef: string, body: string): Pull | string {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (headTip === undefined) return `Head branch '${headRef}' does not exist`;
  if (baseTip === undefined) return `Base branch '${baseRef}' does not exist`;
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) return 'A pull request already exists for this branch';
  }
  const pull: Pull = {
    id: store.nextEntityId,
    number: repo.nextNumber,
    title,
    body,
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
  store.nextEntityId += 1;
  store.seq += 1;
  repo.nextNumber += 1;
  pull.globalId = globalId('PullRequest', repo.id, pull.number);
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function mergePullRecord(repo: Repo, pull: Pull): { ok: boolean; reason: string; sha?: string } {
  if (pull.merged) return { ok: false, reason: 'Pull request has already been merged' };
  if (pull.state !== 'open') return { ok: false, reason: 'Pull request is not open' };
  const baseTip = resolveCommit(repo, `refs/heads/${pull.baseRef}`);
  const headTip = resolveCommit(repo, `refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'Head or base branch is missing' };
  const mergeBase = findMergeBase(repo, baseTip, headTip);
  if (mergeBase === null) return { ok: false, reason: 'No merge base between head and base' };
  const baseTree = parseCommit(repo.objects.get(mergeBase)?.data ?? Buffer.alloc(0)).tree;
  const oursTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const theirsTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const { merged, conflicts } = threeWayMerge(repo, baseTree, oursTree, theirsTree);
  if (merged === null || conflicts.length > 0) return { ok: false, reason: 'Merge conflict' };
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
  return { ok: true, reason: '', sha: mergeCommit };
}

function resolveField(parentType: string, field: string, parent: AnyRecord, args: AnyRecord, ctx: ExecContext): unknown {
  const store = ctx.store;
  if (parentType === 'Query') {
    if (field === 'viewer') return userValue();
    if (field === 'repository') {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (owner !== VIEWER.login || typeof name !== 'string') return null;
      const repo = store.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
      return repo === undefined ? null : repoValue(repo);
    }
    if (field === 'node') {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      const found = findByGlobalId(store, id);
      if (!found || !found.repo) return null;
      if (found.kind === 'Repository') return repoValue(found.repo);
      if (found.kind === 'Issue' && found.issue) return issueValue(found.repo, found.issue);
      if (found.kind === 'PullRequest' && found.pull) return pullValue(found.repo, found.pull);
      return null;
    }
    if (field === '__type') {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name]) {
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: (TYPE_FIELDS[name] as string[]).map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null })),
          enumValues: [],
        };
      }
      if (ENUM_VALUES[name]) {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          fields: [],
          enumValues: (ENUM_VALUES[name] as string[]).map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
        };
      }
      return null;
    }
    if (field === '__schema') return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
    return null;
  }

  if (parentType === 'Mutation') {
    if (field === 'createIssue') {
      const input = (args.input as AnyRecord | undefined) ?? {};
      const found = typeof input.repositoryId === 'string' ? findByGlobalId(store, input.repositoryId) : null;
      if (!found || found.kind !== 'Repository' || !found.repo) {
        ctx.errors.push({ message: 'Repository not found.' });
        return null;
      }
      const issue = createIssueRecord(store, found.repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      return { __typename: 'CreateIssuePayload', issue: issueValue(found.repo, issue) };
    }
    if (field === 'closeIssue') {
      const input = (args.input as AnyRecord | undefined) ?? {};
      const found = typeof input.issueId === 'string' ? findByGlobalId(store, input.issueId) : null;
      if (!found || found.kind !== 'Issue' || !found.repo || !found.issue) {
        ctx.errors.push({ message: 'Issue not found.' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = nowIso();
      found.issue.updatedMs = nowMs();
      return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) };
    }
    if (field === 'createPullRequest') {
      const input = (args.input as AnyRecord | undefined) ?? {};
      const found = typeof input.repositoryId === 'string' ? findByGlobalId(store, input.repositoryId) : null;
      if (!found || found.kind !== 'Repository' || !found.repo) {
        ctx.errors.push({ message: 'Repository not found.' });
        return null;
      }
      const created = createPullRecord(
        store,
        found.repo,
        String(input.title ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        typeof input.body === 'string' ? input.body : '',
      );
      if (typeof created === 'string') {
        ctx.errors.push({ message: created });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(found.repo, created) };
    }
    if (field === 'mergePullRequest') {
      const input = (args.input as AnyRecord | undefined) ?? {};
      const found = typeof input.pullRequestId === 'string' ? findByGlobalId(store, input.pullRequestId) : null;
      if (!found || found.kind !== 'PullRequest' || !found.repo || !found.pull) {
        ctx.errors.push({ message: 'Pull request not found.' });
        return null;
      }
      const result = mergePullRecord(found.repo, found.pull);
      if (!result.ok) {
        ctx.errors.push({ message: result.reason });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(found.repo, found.pull) };
    }
    if (field === 'addComment') {
      const input = (args.input as AnyRecord | undefined) ?? {};
      const found = typeof input.subjectId === 'string' ? findByGlobalId(store, input.subjectId) : null;
      if (!found || found.kind !== 'Issue' || !found.repo || !found.issue) {
        ctx.errors.push({ message: 'Issue not found.' });
        return null;
      }
      const commentId = store.nextEntityId;
      store.nextEntityId += 1;
      const comment = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', found.repo.id, found.issue.number, commentId),
        body: typeof input.body === 'string' ? input.body : '',
      };
      found.issue.comments.push({ id: commentId, body: comment.body as string, createdMs: nowMs(), globalId: comment.id as string });
      found.issue.updatedMs = nowMs();
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: comment, cursor: '' } };
    }
    return null;
  }

  if (parentType === 'User') {
    if (field === 'login') return parent.login;
    if (field === 'id') return parent.id;
    if (field === 'name') return parent.name;
    if (field === 'email') return parent.email;
    if (field === 'url') return parent.url;
    return null;
  }

  if (parentType === 'Repository') {
    const repo = parent.repo as Repo;
    switch (field) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return userValue();
      case 'defaultBranchRef':
        return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      case 'issues':
        return resolveIssues(repo, args);
      case 'pullRequests':
        return resolvePullRequests(repo, args);
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      default:
        return null;
    }
  }

  if (parentType === 'Issue') {
    const issue = parent.issue as Issue;
    switch (field) {
      case 'id':
        return issue.globalId;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      case 'url':
        return '';
      case 'createdAt':
        return new Date(issue.createdMs).toISOString();
      default:
        return null;
    }
  }

  if (parentType === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (field) {
      case 'id':
        return pull.globalId;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return computeMergeable(repo, pull);
      case 'files':
        return resolvePullFiles(repo, pull, args);
      case 'body':
        return pull.body;
      default:
        return null;
    }
  }

  if (parentType === 'Ref') return parent.name;
  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection') {
    return parent[field] ?? null;
  }
  if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge' || parentType === 'PullRequestChangedFileEdge' || parentType === 'CommentEdge') {
    return parent[field] ?? null;
  }
  if (parentType === 'PageInfo') return parent[field] ?? null;
  if (parentType === '__Type') return parent[field] ?? null;
  if (parentType === '__Field' || parentType === '__EnumValue') return parent[field] ?? null;
  if (parentType === 'IssueComment') return parent[field] ?? null;
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') return parent.issue ?? null;
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') return parent.pullRequest ?? null;
  if (parentType === 'AddCommentPayload') return parent.commentEdge ?? null;
  return parent[field] ?? null;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

function executeOne(store: Store, body: unknown): AnyRecord {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as AnyRecord).query !== 'string') {
    return { data: null, errors: [{ message: 'Request body must be an object with a query string.' }] };
  }
  const record = body as AnyRecord;
  const variables = (record.variables as AnyRecord | undefined) ?? {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  let document: Document;
  try {
    document = parseDocument(record.query as string);
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) operation = document.operations.find((op) => op.name === operationName);
  else operation = document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation to execute.' }] };
  const ctx: ExecContext = {
    store,
    variables,
    variableDefinitions: operation.variableDefinitions,
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, rootType, { __typename: rootType }, ctx);
  const out: AnyRecord = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((item) => executeOne(store, item)) };
  }
  return { status: 200, body: executeOne(store, body) };
}
