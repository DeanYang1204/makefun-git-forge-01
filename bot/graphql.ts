// GitHub GraphQL v4, hand-rolled for exactly the documents gh and github-mcp-server
// send: a small parser for the used subset, plus resolvers over the shared store.
// Unknown fields answer HTTP 200 with an errors array naming the field; an unknown
// repository answers data.repository = null with no errors.

import { EPOCH_ISO, VIEWER, decodeGlobalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { pullFiles, pullMergeable } from './rest.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface Argument {
  readonly name: string;
  readonly value: Value;
}

interface Selection {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Argument[];
  readonly children: Selection[] | null;
  readonly fragmentType: string | null;
}

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: Selection[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]$=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9]/.test(ch) || ch === '-') {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.-]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('graphql: unexpected end of document');
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`graphql: expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        this.skipVariableDefinitions();
        operations.push({ kind: token, name, selections: this.parseSelectionSet() });
      } else if (token === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`graphql: unexpected token ${String(token)}`);
      }
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    if (this.peek() !== '(') return;
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const children = this.parseSelectionSet();
      return { alias: null, name: '', args: [], children, fragmentType };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Argument[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let children: Selection[] | null = null;
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias, name, args, children, fragmentType: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'private', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------- execution

interface ExecCtx {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly errors: { message: string }[];
}

function unknownField(ctx: ExecCtx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveIssues(
  ctx: ExecCtx,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  issues.sort((a, b) => direction * (a.number - b.number));
  const after = decodeCursor(args.after);
  if (after !== null) issues = issues.filter((issue) => (direction === 1 ? issue.number > after : issue.number < after));
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, Math.max(0, first));
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  return {
    nodes: page.map((issue) => ({ __type: 'Issue', __value: issue, __repo: repo })),
    pageInfo: { hasNextPage, endCursor },
    totalCount: issues.length,
  };
}

function resolvePullRequests(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let pulls = [...repo.pulls.values()];
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, Math.max(0, first));
  return {
    nodes: page.map((pull) => ({ __type: 'PullRequest', __value: pull, __repo: repo })),
    pageInfo: { hasNextPage: pulls.length > page.length, endCursor: null },
    totalCount: pulls.length,
  };
}

function mergePull(store: Store, repo: Repo, pull: PullRequest): { ok: boolean; sha?: string; reason?: string } {
  return store.squashMerge(repo, pull);
}

function resolveSelection(
  ctx: ExecCtx,
  typeName: string,
  object: Record<string, unknown> | null,
  selections: readonly Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      if (selection.fragmentType !== typeName) continue;
      const nested = resolveSelection(ctx, typeName, object, selection.children ?? []);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, typeName, object, selection);
    out[key] = value;
  }
  return out;
}

function resolveField(ctx: ExecCtx, typeName: string, object: Record<string, unknown> | null, selection: Selection): unknown {
  const { store } = ctx;
  const args = argsOf(selection, ctx.variables);
  const name = selection.name;

  if (typeName === 'Query') {
    if (name === 'viewer') {
      if (selection.children === null) return unknownField(ctx, typeName, name);
      return resolveSelection(ctx, 'User', { __type: 'User' }, selection.children);
    }
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return null;
      if (selection.children === null) return unknownField(ctx, typeName, name);
      return resolveSelection(ctx, 'Repository', { __type: 'Repository', __value: repo }, selection.children);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = store.findRepoByGlobalId(String(args.id ?? ''));
        if (repo === undefined) return null;
        if (selection.children === null) return unknownField(ctx, typeName, name);
        return resolveSelection(ctx, 'Repository', { __type: 'Repository', __value: repo }, selection.children);
      }
      return null;
    }
    if (name === '__type') {
      const type = String(args.name ?? '');
      const fields = TYPE_FIELDS[type];
      const enums = TYPE_ENUMS[type];
      const value: Record<string, unknown> = { name: type };
      if (selection.children === null) return value;
      const sub: Record<string, unknown> = {};
      for (const child of selection.children) {
        if (child.name === 'fields') sub[child.alias ?? 'fields'] = (fields ?? []).map((field) => ({ name: field }));
        else if (child.name === 'enumValues') sub[child.alias ?? 'enumValues'] = (enums ?? []).map((value2) => ({ name: value2 }));
        else if (child.name === 'name') sub[child.alias ?? 'name'] = type;
        else sub[child.alias ?? child.name] = null;
      }
      return sub;
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'User') {
    if (name === 'login') return VIEWER.login;
    if (name === 'id') return globalUserId();
    if (name === 'name') return VIEWER.name;
    if (name === 'email') return VIEWER.email;
    if (name === 'url') return `https://example.invalid/${VIEWER.login}`;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Repository') {
    const repo = object?.__value as Repo | undefined;
    if (repo === undefined) return null;
    switch (name) {
      case 'id':
        return store.repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        if (selection.children === null) return { login: repo.owner };
        return resolveSelection(ctx, 'User', { __type: 'User' }, selection.children);
      case 'defaultBranchRef':
        return { name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.private;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return EPOCH_ISO;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        if (issue === undefined) return null;
        if (selection.children === null) return unknownField(ctx, typeName, name);
        return resolveSelection(ctx, 'Issue', { __type: 'Issue', __value: issue, __repo: repo }, selection.children);
      }
      case 'issues': {
        const connection = resolveIssues(ctx, repo, args);
        if (selection.children === null) return connection;
        return resolveConnection(ctx, connection, selection.children, 'Issue');
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        if (pull === undefined) return null;
        if (selection.children === null) return unknownField(ctx, typeName, name);
        return resolveSelection(ctx, 'PullRequest', { __type: 'PullRequest', __value: pull, __repo: repo }, selection.children);
      }
      case 'pullRequests': {
        const connection = resolvePullRequests(ctx, repo, args);
        if (selection.children === null) return connection;
        return resolveConnection(ctx, connection, selection.children, 'PullRequest');
      }
      default:
        return unknownField(ctx, typeName, name);
    }
  }

  if (typeName === 'Issue') {
    const issue = object?.__value as Issue | undefined;
    const repo = object?.__repo as Repo | undefined;
    if (issue === undefined || repo === undefined) return null;
    switch (name) {
      case 'id':
        return store.issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state.toUpperCase();
      case 'body':
        return issue.body;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt':
      case 'updatedAt':
        return EPOCH_ISO;
      default:
        return unknownField(ctx, typeName, name);
    }
  }

  if (typeName === 'PullRequest') {
    const pull = object?.__value as PullRequest | undefined;
    const repo = object?.__repo as Repo | undefined;
    if (pull === undefined || repo === undefined) return null;
    switch (name) {
      case 'id':
        return store.pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pullMergeable(store, repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt':
      case 'updatedAt':
        return EPOCH_ISO;
      case 'files': {
        const files = pullFiles(store, repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, Math.max(0, first)).map((file) => ({ __type: 'PullRequestChangedFile', __value: file }));
        if (selection.children === null) return { nodes };
        const out: Record<string, unknown> = {};
        for (const child of selection.children) {
          if (child.name === 'nodes') {
            out[child.alias ?? 'nodes'] = nodes.map((node) => resolveSelection(ctx, 'PullRequestChangedFile', node as unknown as Record<string, unknown>, child.children ?? []));
          } else if (child.name === 'pageInfo') {
            out[child.alias ?? 'pageInfo'] = { hasNextPage: files.length > nodes.length, endCursor: null };
          } else if (child.name === 'totalCount') {
            out[child.alias ?? 'totalCount'] = files.length;
          } else {
            out[child.alias ?? child.name] = null;
          }
        }
        return out;
      }
      default:
        return unknownField(ctx, typeName, name);
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = object?.__value as Record<string, unknown> | undefined;
    if (file === undefined) return null;
    if (name === 'path') return file.filename ?? null;
    if (name === 'additions') return file.additions ?? 0;
    if (name === 'deletions') return file.deletions ?? 0;
    if (name === 'changeType') return file.status ?? null;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, selection);
  }

  return unknownField(ctx, typeName, name);
}

function globalUserId(): string {
  return Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url');
}

function resolveConnection(
  ctx: ExecCtx,
  connection: Record<string, unknown>,
  selections: readonly Selection[],
  nodeType: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    const key = selection.alias ?? selection.name;
    if (selection.name === 'nodes') {
      const nodes = connection.nodes as Record<string, unknown>[];
      out[key] = nodes.map((node) => resolveSelection(ctx, nodeType, node, selection.children ?? []));
    } else if (selection.name === 'pageInfo') {
      const pageInfo = connection.pageInfo as Record<string, unknown>;
      if (selection.children === null) {
        out[key] = pageInfo;
      } else {
        const sub: Record<string, unknown> = {};
        for (const child of selection.children) sub[child.alias ?? child.name] = pageInfo[child.name] ?? null;
        out[key] = sub;
      }
    } else if (selection.name === 'totalCount') {
      out[key] = connection.totalCount ?? null;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function resolveMutation(ctx: ExecCtx, selection: Selection): unknown {
  const { store } = ctx;
  const args = argsOf(selection, ctx.variables);
  const name = selection.name;
  const children = selection.children ?? [];

  if (name === 'createIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = store.findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      number: repo.issueSeq,
      id: '',
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
    };
    (issue as { id: string }).id = store.issueGlobalId(repo, issue);
    repo.issues.set(issue.number, issue);
    return resolveSelection(ctx, 'CreateIssuePayload', { __type: 'CreateIssuePayload', __value: { issue, repo } }, children);
  }

  if (name === 'closeIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = store.findIssueByGlobalId(String(input.issueId ?? ''));
    if (found === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    found.issue.state = 'closed';
    return resolveSelection(ctx, 'CloseIssuePayload', { __type: 'CloseIssuePayload', __value: { issue: found.issue, repo: found.repo } }, children);
  }

  if (name === 'createPullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = store.findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const headOid = repo.refs.get(`refs/heads/${String(input.headRefName ?? '')}`);
    const baseOid = repo.refs.get(`refs/heads/${String(input.baseRefName ?? '')}`);
    if (headOid === undefined || baseOid === undefined) {
      ctx.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    repo.pullSeq += 1;
    const pull: PullRequest = {
      number: repo.pullSeq,
      id: '',
      title: String(input.title ?? ''),
      body: '',
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      headRef: String(input.headRefName ?? ''),
      baseRef: String(input.baseRefName ?? ''),
      headSha: headOid,
      baseSha: baseOid,
    };
    (pull as { id: string }).id = store.pullGlobalId(repo, pull);
    repo.pulls.set(pull.number, pull);
    return resolveSelection(ctx, 'CreatePullRequestPayload', { __type: 'CreatePullRequestPayload', __value: { pull, repo } }, children);
  }

  if (name === 'mergePullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = store.findPullByGlobalId(String(input.pullRequestId ?? ''));
    if (found === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    const result = mergePull(store, found.repo, found.pull);
    if (!result.ok) {
      ctx.errors.push({ message: `Merge failed: ${result.reason ?? ''}` });
      return null;
    }
    return resolveSelection(ctx, 'MergePullRequestPayload', { __type: 'MergePullRequestPayload', __value: { pull: found.pull, repo: found.repo } }, children);
  }

  if (name === 'addComment') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = store.findIssueByGlobalId(String(input.subjectId ?? ''));
    if (found === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    found.repo.commentSeq += 1;
    const comment = { id: found.repo.commentSeq, body: String(input.body ?? '') };
    found.issue.comments.push(comment);
    const node = { id: store.commentGlobalId(found.repo, found.issue, comment.id), body: comment.body };
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === 'commentEdge') {
        const edge: Record<string, unknown> = {};
        for (const edgeChild of child.children ?? []) {
          if (edgeChild.name === 'node') {
            const nodeOut: Record<string, unknown> = {};
            for (const nodeChild of edgeChild.children ?? []) {
              nodeOut[nodeChild.alias ?? nodeChild.name] = node[nodeChild.name as keyof typeof node] ?? null;
            }
            edge[edgeChild.alias ?? 'node'] = nodeOut;
          }
        }
        out[child.alias ?? 'commentEdge'] = edge;
      }
    }
    return out;
  }

  return unknownField(ctx, 'Mutation', name);
}

// Payload types resolve their single wrapped object by field name.
const PAYLOAD_FIELDS: Record<string, string> = {
  CreateIssuePayload: 'issue',
  CloseIssuePayload: 'issue',
  CreatePullRequestPayload: 'pullRequest',
  MergePullRequestPayload: 'pullRequest',
};

const _resolveSelection = resolveSelection;
// Patch resolveSelection to handle payload wrappers (kept separate to avoid a cycle).
resolveSelection = ((): typeof resolveSelection => {
  const original = _resolveSelection;
  return (ctx, typeName, object, selections) => {
    const payloadField = PAYLOAD_FIELDS[typeName];
    if (payloadField !== undefined && object !== null) {
      const out: Record<string, unknown> = {};
      for (const selection of selections) {
        const key = selection.alias ?? selection.name;
        if (selection.name === payloadField) {
          const wrapped = object.__value as { issue?: Issue; pull?: PullRequest; repo: Repo };
          if (wrapped.issue !== undefined) {
            out[key] = resolveSelection(ctx, 'Issue', { __type: 'Issue', __value: wrapped.issue, __repo: wrapped.repo }, selection.children ?? []);
          } else if (wrapped.pull !== undefined) {
            out[key] = resolveSelection(ctx, 'PullRequest', { __type: 'PullRequest', __value: wrapped.pull, __repo: wrapped.repo }, selection.children ?? []);
          } else {
            out[key] = null;
          }
        } else {
          out[key] = null;
        }
      }
      return out;
    }
    return original(ctx, typeName, object, selections);
  };
})();

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { message: string }[];
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'no operation' }] };
  const operation = operations[0] as Operation;
  const ctx: ExecCtx = { store, variables, errors: [] };
  const typeName = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelection(ctx, typeName, null, operation.selections);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Execute one request body (single operation or a JSON array batch). */
export function handleGraphQL(store: Store, body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, payload: { errors: [{ message: 'empty batch' }] } };
    const results = body.map((item) => {
      if (item === null || typeof item !== 'object') return { errors: [{ message: 'parse error' }] };
      const record = item as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, query, variables);
    });
    return { status: 200, payload: results };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: { errors: [{ message: 'request body must be a JSON object' }] } };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  return { status: 200, payload: executeGraphQL(store, query, variables) };
}
