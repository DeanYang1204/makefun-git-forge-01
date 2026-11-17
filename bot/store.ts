// The forge's whole state: one in-memory store, shared by git smart HTTP, REST v3,
// GraphQL v4 and MCP. Nothing here reads a clock or Math.random: every id and every
// ordering comes from monotonic counters, so two runs of the same trial leave the same
// state. Server-made commits use the fixed scenario epoch, never the wall clock.

import { createHash } from 'node:crypto';
// zlib is used by gitproto.ts, not here.

/** The fixed epoch every server-made commit carries (wire.ts SCENARIO_EPOCH_SEC). */
export const EPOCH_SEC = 1_735_689_600;
export const EPOCH_ISO = '2025-01-01T00:00:00Z';
/** The token owner, fixed by the suite's one seeded scenario (wire.ts buildScenario). */
export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' } as const;

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** Opaque global ids: base64url of a typed path, never the bare numeric id. */
export function globalId(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- git objects

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries, git-sorted. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
}

export function buildCommit(fields: CommitParts): Buffer {
  const timestamp = fields.timestamp ?? EPOCH_SEC;
  const who = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
  const author = fields.author ?? who;
  const committer = fields.committer ?? who;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

// ---------------------------------------------------------------- domain types

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly number: number;
  readonly id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: { id: number; body: string }[];
}

export interface PullRequest {
  readonly number: number;
  readonly id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
    };
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  repoGlobalId(repo: Repo): string {
    return globalId('Repository', [repo.id]);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('Issue', [repo.id, issue.number]);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return globalId('PullRequest', [repo.id, pull.number]);
  }

  commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
    return globalId('IssueComment', [repo.id, issue.number, commentId]);
  }

  findRepoByGlobalId(id: string): Repo | undefined {
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') return undefined;
    const dbId = Number(decoded.parts[0]);
    for (const repo of this.repos.values()) if (repo.id === dbId) return repo;
    return undefined;
  }

  findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return undefined;
    const dbId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of this.repos.values()) {
      if (repo.id !== dbId) continue;
      const issue = repo.issues.get(number);
      if (issue !== undefined) return { repo, issue };
    }
    return undefined;
  }

  findPullByGlobalId(id: string): { repo: Repo; pull: PullRequest } | undefined {
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
    const dbId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of this.repos.values()) {
      if (repo.id !== dbId) continue;
      const pull = repo.pulls.get(number);
      if (pull !== undefined) return { repo, pull };
    }
    return undefined;
  }

  // ------------------------------------------------------------ git helpers

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** All objects reachable from `oid` (commit/tag/tree/blob closure). */
  reachableObjects(repo: Repo, oid: string, out = new Set<string>()): Set<string> {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (out.has(current)) continue;
      const object = repo.objects.get(current);
      if (object === undefined) continue;
      out.add(current);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
        if (match !== null) stack.push(match[1] as string);
      }
    }
    return out;
  }

  /** Commits reachable from `oid` (following parents only). */
  reachableCommits(repo: Repo, oid: string, out = new Set<string>()): Set<string> {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (out.has(current)) continue;
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      out.add(current);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return out;
  }

  /** Is `ancestor` an ancestor of `oid` (or equal)? */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    return this.reachableCommits(repo, oid).has(ancestor);
  }

  /** The blob oid at `path` in the tree of `commitOid`, or null. */
  blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    const segments = path.split('/').filter((segment) => segment !== '');
    let treeOid = parseCommit(commit.data).tree;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** The tree oid of `commitOid` with `path` set to `blobOid` (creating dirs as needed). */
  treeWithPath(repo: Repo, commitOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const head = segments[depth] as string;
      const kept = entries.filter((entry) => entry.name !== head);
      if (depth === segments.length - 1) {
        if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
        kept.push({ mode: '40000', name: head, oid: build(existing?.oid ?? null, depth + 1) });
      }
      return this.putObject(repo, 'tree', buildTree(kept));
    };
    let rootTree: string | null = null;
    if (commitOid !== null) {
      const commit = repo.objects.get(commitOid);
      if (commit !== undefined && commit.type === 'commit') rootTree = parseCommit(commit.data).tree;
    }
    return build(rootTree, 0);
  }

  /** List the entries of the tree at `path` ('' for root) in `commitOid`'s tree. */
  listTreePath(repo: Repo, commitOid: string, path: string): TreeEntry[] | null {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '');
    for (const segment of segments) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    return parseTree(tree.data);
  }

  /** Commits reachable from `refOid`, newest first (BFS by generation, parents after children). */
  listCommits(repo: Repo, refOid: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [refOid];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return order;
  }

  /** Merge-base of two commits: the first common ancestor in BFS order from `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsB = this.reachableCommits(repo, b);
    const queue = [a];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsB.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return null;
  }

  /** Three-way conflict check: paths changed on both sides from base with different results. */
  hasConflict(repo: Repo, baseOid: string, headOid: string, targetOid: string): boolean {
    const base = repo.objects.get(baseOid);
    const head = repo.objects.get(headOid);
    const target = repo.objects.get(targetOid);
    if (base === undefined || head === undefined || target === undefined) return false;
    const baseTree = parseCommit(base.data).tree;
    const headTree = parseCommit(head.data).tree;
    const targetTree = parseCommit(target.data).tree;
    const flat = (treeOid: string, prefix: string, out: Map<string, string>): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined) return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') flat(entry.oid, path, out);
        else out.set(path, entry.oid);
      }
    };
    const baseMap = new Map<string, string>();
    const headMap = new Map<string, string>();
    const targetMap = new Map<string, string>();
    flat(baseTree, '', baseMap);
    flat(headTree, '', headMap);
    flat(targetTree, '', targetMap);
    const paths = new Set([...headMap.keys(), ...targetMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path) ?? null;
      const h = headMap.get(path) ?? null;
      const t = targetMap.get(path) ?? null;
      if (h !== b && t !== b && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid. */
  squashMerge(repo: Repo, pull: PullRequest): { ok: boolean; sha?: string; reason?: string } {
    if (pull.state !== 'open') return { ok: false, reason: 'already closed' };
    // The base is the branch's live tip: another pull may have merged since this one opened.
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(repo, pull.headSha, baseTip);
    if (base !== null && this.hasConflict(repo, base, pull.headSha, baseTip)) return { ok: false, reason: 'merge conflict' };
    const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
    const mergeOid = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: headTree, parents: [baseTip], message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n` }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeOid;
    pull.mergedAt = EPOCH_ISO;
    pull.baseSha = mergeOid;
    return { ok: true, sha: mergeOid };
  }

  /** Flat path -> blob oid map of a commit's tree. */
  flatTree(repo: Repo, commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined) return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }
}
