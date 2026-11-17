// Model Context Protocol over Streamable HTTP: JSON-RPC 2.0, modern revision
// 2026-07-28 (server/discover, no handshake) with a legacy initialize fallback.
// Tools act on the same store as REST, with identical ids.

import { VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { pullMergeable } from './rest.ts';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
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
    description: 'Merge a pull request by number, squash-merged onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof data === 'object' && data !== null ? data : { result: data },
    ...(isError ? { isError: true } : {}),
  };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pullMergeable(store, repo, pull),
    head: pull.headRef,
    base: pull.baseRef,
    head_sha: pull.headSha,
    base_sha: pull.baseSha,
  };
}

/** Run one tools/call. Returns a JSON-RPC result object or an error object. */
function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { error: { code: -32602, message: `missing required argument: ${key}` } };
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (store.getRepo(VIEWER.login, repoName) !== undefined) {
      return { result: toolResult(`Repository ${VIEWER.login}/${repoName} already exists.`, true) };
    }
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return { result: toolResult(repoJson(store, repo)) };
  }

  if (name === 'get_repo') {
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { result: toolResult(`Repository ${String(args.owner)}/${String(args.repo)} not found.`, true) };
    return { result: toolResult(repoJson(store, repo)) };
  }

  if (name === 'create_issue') {
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { result: toolResult(`Repository ${String(args.owner)}/${String(args.repo)} not found.`, true) };
    repo.issueSeq += 1;
    const issue: Issue = {
      number: repo.issueSeq,
      id: '',
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
    };
    (issue as { id: string }).id = store.issueGlobalId(repo, issue);
    repo.issues.set(issue.number, issue);
    return { result: toolResult(issueJson(store, repo, issue)) };
  }

  if (name === 'list_issues') {
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { result: toolResult(`Repository ${String(args.owner)}/${String(args.repo)} not found.`, true) };
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => a.number - b.number);
    return { result: toolResult(issues.map((issue) => issueJson(store, repo, issue))) };
  }

  if (name === 'create_pull_request') {
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { result: toolResult(`Repository ${String(args.owner)}/${String(args.repo)} not found.`, true) };
    const headOid = repo.refs.get(`refs/heads/${String(args.head)}`);
    const baseOid = repo.refs.get(`refs/heads/${String(args.base)}`);
    if (headOid === undefined || baseOid === undefined) {
      return { result: toolResult('Head or base branch does not exist.', true) };
    }
    repo.pullSeq += 1;
    const pull: PullRequest = {
      number: repo.pullSeq,
      id: '',
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      headRef: String(args.head),
      baseRef: String(args.base),
      headSha: headOid,
      baseSha: baseOid,
    };
    (pull as { id: string }).id = store.pullGlobalId(repo, pull);
    repo.pulls.set(pull.number, pull);
    return { result: toolResult(pullJson(store, repo, pull)) };
  }

  if (name === 'merge_pull_request') {
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { result: toolResult(`Repository ${String(args.owner)}/${String(args.repo)} not found.`, true) };
    const pull = repo.pulls.get(Number(args.pull_number));
    if (pull === undefined) return { result: toolResult(`Pull request #${String(args.pull_number)} not found.`, true) };
    const merged = store.squashMerge(repo, pull);
    if (!merged.ok) return { result: toolResult(`Merge failed: ${merged.reason ?? ''}`, true) };
    return { result: toolResult({ ...pullJson(store, repo, pull), merged: true, sha: merged.sha }) };
  }

  return { error: { code: -32602, message: `unknown tool: ${name}` } };
}

/**
 * Handle one POST /mcp body. Returns the HTTP status and the JSON payload.
 * `rawBody` is used to detect a non-JSON body (HTTP 400, -32700).
 */
export function handleMcp(store: Store, rawBody: Buffer): { status: number; payload: unknown; headers?: Record<string, string> } {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, payload: rpcError(null, -32700, 'Parse error') };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: rpcError(null, -32700, 'Parse error') };
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications get no JSON-RPC response.
  if (method.startsWith('notifications/')) {
    return { status: 202, payload: '' };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      payload: rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-git-forge', version: '1.0.0' },
      }),
    };
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-git-forge', version: '1.0.0' },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, payload: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    // One fixed list, byte-identical on every call.
    return { status: 200, payload: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, toolName, args);
    if (outcome.error !== undefined) {
      return { status: 200, payload: rpcError(id, outcome.error.code, outcome.error.message) };
    }
    return { status: 200, payload: rpcResult(id, outcome.result) };
  }

  return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}
