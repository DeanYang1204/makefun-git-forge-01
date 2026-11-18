// GitHub REST v3, as the conformance checks assert it: repositories, branches, commits
// and contents; issues, comments and labels; pull requests, their files and merges.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; errors carry {message}.

import { EPOCH_ISO, VIEWER, buildCommit, parseCommit, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface Ctx {
  readonly store: Store;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | undefined>;
  readonly body: unknown;
  readonly rawBody: Buffer;
}

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export function ok(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

export function err(status: number, message: string): Reply {
  return { status, body: { message } };
}

const SHA_RE = /^[0-9a-f]{40}$/;

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalNodeId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    pushed_at: EPOCH_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

import { globalId } from './store.ts';
function repoGlobalNodeId(repo: Repo): string {
  return globalId('Repository', [repo.id]);
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: issue.state === 'closed' ? EPOCH_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
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
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: pull.state === 'closed' ? EPOCH_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** MERGEABLE / CONFLICTING for a pull request, by three-way tree comparison. */
export function pullMergeable(store: Store, repo: Repo, pull: PullRequest): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = store.mergeBase(repo, pull.headSha, baseTip);
  if (base === null) return 'UNKNOWN';
  return store.hasConflict(repo, base, pull.headSha, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function bodyObject(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return null;
  return ctx.body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], ctx: Ctx): { page: T[]; total: number; pageCount: number } {
  const { page, perPage } = pageParams(ctx);
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageCount };
}

/** Build a Link header for the next page, same origin as the request's Host. */
function linkHeader(ctx: Ctx, basePath: string, page: number, pageCount: number): Record<string, string> {
  if (page >= pageCount) return {};
  const host = ctx.headers.host ?? 'localhost';
  const params = new URLSearchParams(ctx.query);
  params.set('page', String(page + 1));
  return { link: `<http://${host}${basePath}?${params.toString()}>; rel="next"` };
}

function requireRepo(ctx: Ctx, owner: string, name: string): Repo | Reply {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

/** Commit `message` on `branch` setting `path` to `blobOid` (null removes it). */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parentOid = repo.refs.get(ref);
  const treeOid = store.treeWithPath(repo, parentOid ?? null, path, blobOid);
  const commitOid = store.putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: parentOid === undefined ? [] : [parentOid], message }),
  );
  repo.refs.set(ref, commitOid);
  return commitOid;
}

function contentEntry(store: Store, repo: Repo, commitOid: string, path: string): { oid: string; size: number } | null {
  const oid = store.blobAtPath(repo, commitOid, path);
  if (oid === null) return null;
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  return { oid, size: object.data.length };
}

/** Line counts for a diff: [additions, deletions]. */
function lineDiff(oldText: string, newText: string): [number, number] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let additions = 0;
  const remaining = new Map(oldSet);
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return [additions, deletions];
}

export function handleRest(ctx: Ctx): Reply | null {
  const store = ctx.store;
  const path = ctx.path;
  const m = ctx.method;

  // ---- API root ------------------------------------------------------------
  if (path === '/api/v3' || path === '/api/v3/') {
    if (m !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta') {
    if (m !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (path === '/api/v3/user') {
    if (m !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', [VIEWER.id]), name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }
  if (path === '/api/v3/user/repos') {
    if (m === 'GET') {
      const repos = store.listRepos();
      const { page, pageCount } = paginate(repos, ctx);
      const { page: pageNum } = pageParams(ctx);
      return ok(200, page.map(repoJson), linkHeader(ctx, path, pageNum, pageCount));
    }
    if (m === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const name = asString(body.name);
      if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
      if (store.getRepo(VIEWER.login, name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
      const repo = store.createRepo(name, asBoolean(body.private) ?? false, asString(body.description) ?? '');
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // ---- /api/v3/repos/{owner}/{repo}[...] ------------------------------------
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(path);
  if (repoMatch === null) return null;
  const owner = decodeURIComponent(repoMatch[1] as string);
  const repoName = decodeURIComponent(repoMatch[2] as string);
  const rest = repoMatch[3] as string;

  // GET/DELETE/PATCH the repo itself
  if (rest === '') {
    if (m === 'GET') {
      const repo = requireRepo(ctx, owner, repoName);
      if (!isRepo(repo)) return repo;
      return ok(200, repoJson(repo));
    }
    if (m === 'PATCH') {
      const repo = requireRepo(ctx, owner, repoName);
      if (!isRepo(repo)) return repo;
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      return ok(200, repoJson(repo));
    }
    if (m === 'DELETE') {
      const repo = requireRepo(ctx, owner, repoName);
      if (!isRepo(repo)) return repo;
      store.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  // Everything below needs the repo to exist.
  const repoOrReply = requireRepo(ctx, owner, repoName);
  if (!isRepo(repoOrReply)) return repoOrReply;
  const repo = repoOrReply;

  // ---- branches -------------------------------------------------------------
  if (rest === '/branches') {
    if (m !== 'GET') return err(404, 'Not Found');
    const branches: Record<string, unknown>[] = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    return ok(200, branches);
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(rest);
  if (branchMatch !== null) {
    if (m !== 'GET') return err(404, 'Not Found');
    const oid = repo.refs.get(`refs/heads/${decodeURIComponent(branchMatch[1] as string)}`);
    if (oid === undefined) return err(404, 'Not Found');
    return ok(200, { name: decodeURIComponent(branchMatch[1] as string), commit: { sha: oid } });
  }

  // ---- commits --------------------------------------------------------------
  if (rest === '/commits') {
    if (m !== 'GET') return err(404, 'Not Found');
    const sha = ctx.query.get('sha');
    const refName = sha !== null && sha !== '' ? (sha.startsWith('refs/') ? sha : `refs/heads/${sha}`) : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return ok(200, []);
    const commits = store.listCommits(repo, tip).map((oid) => {
      const object = repo.objects.get(oid);
      const message = object === undefined ? '' : parseCommit(object.data).message;
      return { sha: oid, commit: { message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } } };
    });
    const { page } = paginate(commits, ctx);
    return ok(200, page);
  }

  // ---- git refs ---------------------------------------------------------------
  if (rest === '/git/refs' && m === 'POST') {
    const body = bodyObject(ctx);
    if (body === null) return err(422, 'Validation Failed');
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === undefined || sha === undefined || !SHA_RE.test(sha)) return err(422, 'Validation Failed');
    if (!ref.startsWith('refs/')) return err(422, 'Validation Failed: ref must start with refs/');
    if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
    if (!repo.objects.has(sha)) return err(422, 'Validation Failed: object does not exist');
    repo.refs.set(ref, sha);
    return ok(201, { ref, object: { sha, type: 'commit' } });
  }
  const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(rest);
  if (gitRefMatch !== null) {
    if (m === 'GET') {
      const ref = decodeURIComponent(gitRefMatch[1] as string);
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha: oid, type: 'commit' } });
    }
    if (m === 'PATCH') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const ref = decodeURIComponent(gitRefMatch[1] as string);
      const sha = asString(body.sha);
      if (sha === undefined || !SHA_RE.test(sha)) return err(422, 'Validation Failed');
      if (!repo.refs.has(ref)) return err(404, 'Not Found');
      repo.refs.set(ref, sha);
      return ok(200, { ref, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  // ---- contents ---------------------------------------------------------------
  if (rest.startsWith('/contents/')) {
    const filePath = decodeURIComponent(rest.slice('/contents/'.length));
    if (filePath === '' || filePath.endsWith('/')) return err(404, 'Not Found');
    const refName = ctx.query.get('ref') ?? undefined;
    const branch = refName !== undefined && refName !== '' ? (refName.startsWith('refs/') ? refName.slice('refs/heads/'.length) : refName) : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (m === 'GET') {
      if (tip === undefined) return err(404, 'Not Found');
      const entry = contentEntry(store, repo, tip, filePath);
      if (entry !== null) {
        const object = repo.objects.get(entry.oid) as { data: Buffer };
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: entry.size,
          name: filePath.split('/').pop(),
          path: filePath,
          content: object.data.toString('base64'),
          sha: entry.oid,
        });
      }
      const entries = store.listTreePath(repo, tip, filePath);
      if (entries === null) return err(404, 'Not Found');
      return ok(200, entries.map((item) => ({ type: item.mode === '40000' ? 'dir' : 'file', name: item.name, path: filePath === '' ? item.name : `${filePath}/${item.name}`, sha: item.oid })));
    }
    if (m === 'PUT') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const message = asString(body.message) ?? `Update ${filePath}`;
      const contentB64 = asString(body.content);
      if (contentB64 === undefined) return err(422, 'Validation Failed: content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'Validation Failed: content is not base64');
      }
      const useBranch = asString(body.branch) ?? branch;
      const useTip = repo.refs.get(`refs/heads/${useBranch}`);
      const current = useTip === undefined ? null : contentEntry(store, repo, useTip, filePath);
      const sha = asString(body.sha);
      if (sha !== undefined && current !== null && sha.toLowerCase() !== current.oid.toLowerCase()) return err(409, 'Conflict: sha does not match');
      if (sha !== undefined && current === null) return err(409, 'Conflict: sha does not match');
      const isUpdate = current !== null;
      const blobOid = store.putObject(repo, 'blob', content);
      const commitOid = commitFile(store, repo, useBranch, filePath, blobOid, message);
      return ok(isUpdate ? 200 : 201, { content: { sha: blobOid, encoding: 'base64', size: content.length }, commit: { sha: commitOid } });
    }
    if (m === 'DELETE') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const sha = asString(body.sha);
      if (tip === undefined) return err(404, 'Not Found');
      const current = contentEntry(store, repo, tip, filePath);
      if (current === null) return err(404, 'Not Found');
      if (sha !== undefined && sha.toLowerCase() !== current.oid.toLowerCase()) return err(409, 'Conflict: sha does not match');
      const message = asString(body.message) ?? `Delete ${filePath}`;
      const commitOid = commitFile(store, repo, branch, filePath, null, message);
      return ok(200, { commit: { sha: commitOid } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels -----------------------------------------------------------------
  if (rest === '/labels') {
    if (m === 'GET') return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    if (m === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const name = asString(body.name);
      if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
      const label = { name, color: asString(body.color) ?? 'ededed' };
      repo.labels.set(name, label);
      return ok(201, { name: label.name, color: label.color });
    }
    return err(404, 'Not Found');
  }

  // ---- issues -------------------------------------------------------------------
  if (rest === '/issues') {
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      if (sort === 'created') issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, pageCount } = paginate(issues, ctx);
      const { page: pageNum } = pageParams(ctx);
      return ok(200, page.map((issue) => issueJson(store, repo, issue)), linkHeader(ctx, path, pageNum, pageCount));
    }
    if (m === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const title = asString(body.title);
      if (title === undefined || title === '') return err(422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) return err(422, `Validation Failed: label "${labelName}" does not exist`);
      }
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        id: '',
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        labels: labelNames.map((name) => repo.labels.get(name) as { name: string; color: string }),
        comments: [],
      };
      (issue as { id: string }).id = store.issueGlobalId(repo, issue);
      repo.issues.set(issue.number, issue);
      return ok(201, issueJson(store, repo, issue));
    }
    return err(404, 'Not Found');
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, 'Not Found');
    if (issueMatch[2] === '/comments') {
      if (m === 'GET') return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      if (m === 'POST') {
        const body = bodyObject(ctx);
        if (body === null) return err(422, 'Validation Failed');
        const commentBody = asString(body.body);
        if (commentBody === undefined) return err(422, 'Validation Failed: body is required');
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body: commentBody };
        issue.comments.push(comment);
        return ok(201, { id: comment.id, body: comment.body });
      }
      return err(404, 'Not Found');
    }
    if (m === 'GET') return ok(200, issueJson(store, repo, issue));
    if (m === 'PATCH') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const state = asString(body.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = asString(body.title);
      if (title !== undefined) issue.title = title;
      const bodyText = asString(body.body);
      if (bodyText !== undefined) issue.body = bodyText;
      return ok(200, issueJson(store, repo, issue));
    }
    return err(404, 'Not Found');
  }

  // ---- pull requests ------------------------------------------------------------
  if (rest === '/pulls') {
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page, pageCount } = paginate(pulls, ctx);
      const { page: pageNum } = pageParams(ctx);
      return ok(200, page.map((pull) => pullJson(store, repo, pull)), linkHeader(ctx, path, pageNum, pageCount));
    }
    if (m === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) return err(422, 'Validation Failed');
      const head = asString(body.head);
      const base = asString(body.base);
      const title = asString(body.title);
      if (head === undefined || base === undefined || title === undefined) return err(422, 'Validation Failed');
      const headOid = repo.refs.get(`refs/heads/${head}`);
      const baseOid = repo.refs.get(`refs/heads/${base}`);
      if (headOid === undefined || baseOid === undefined) return err(422, 'Validation Failed: head or base branch does not exist');
      repo.pullSeq += 1;
      const pull: PullRequest = {
        number: repo.pullSeq,
        id: '',
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        headRef: head,
        baseRef: base,
        headSha: headOid,
        baseSha: baseOid,
      };
      (pull as { id: string }).id = store.pullGlobalId(repo, pull);
      repo.pulls.set(pull.number, pull);
      return ok(201, pullJson(store, repo, pull));
    }
    return err(404, 'Not Found');
  }
  const pullMatch = /^\/pulls\/(\d+)(\/merge|\/files)?$/.exec(rest);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return err(404, 'Not Found');
    if (pullMatch[2] === '/files') {
      if (m !== 'GET') return err(404, 'Not Found');
      return ok(200, pullFiles(store, repo, pull));
    }
    if (pullMatch[2] === '/merge') {
      if (m !== 'PUT') return err(404, 'Not Found');
      if (pull.state !== 'open') return err(405, 'Pull request is already closed');
      const merged = store.squashMerge(repo, pull);
      if (!merged.ok) return err(405, merged.reason ?? 'Merge conflict');
      const mergeOid = merged.sha as string;
      return ok(200, { merged: true, sha: mergeOid, message: `Pull Request #${pull.number} merged` });
    }
    if (m === 'GET') return ok(200, pullJson(store, repo, pull));
    return err(404, 'Not Found');
  }

  return null;
}

function isRepo(value: Repo | Reply): value is Repo {
  return (value as Repo).objects !== undefined;
}

/** Changed files between a PR's base and head, with line counts. */
export function pullFiles(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown>[] {
  const baseMap = store.flatTree(repo, pull.baseSha);
  const headMap = store.flatTree(repo, pull.headSha);
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const baseOid = baseMap.get(path);
    const headOid = headMap.get(path);
    if (baseOid === headOid) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (baseOid === undefined) {
      status = 'added';
      const text = repo.objects.get(headOid as string)?.data.toString('utf8') ?? '';
      additions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      if (additions === 0) additions = 1;
    } else if (headOid === undefined) {
      status = 'removed';
      const text = repo.objects.get(baseOid)?.data.toString('utf8') ?? '';
      deletions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } else {
      status = 'modified';
      const oldText = repo.objects.get(baseOid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(headOid)?.data.toString('utf8') ?? '';
      [additions, deletions] = lineDiff(oldText, newText);
    }
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}
