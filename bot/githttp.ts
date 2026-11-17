// Git smart HTTP: info/refs advertisements, upload-pack v2 (ls-refs, fetch) and
// receive-pack v0. The suite's client is the only speaker; see gitproto.ts for the
// framing and pack code.

import {
  FLUSH,
  PktReader,
  advertiseV0,
  advertiseV2,
  advertisedRefs,
  pktLine,
  readPackRaw,
  selectFetchObjects,
  sidebandPack,
  writePack,
} from './gitproto.ts';
import { ZERO_OID, isOid, type Repo, type Store } from './store.ts';

export interface GitReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function reply(status: number, contentType: string, body: Buffer): GitReply {
  return { status, contentType, body };
}

function jsonReply(status: number, message: string): GitReply {
  return reply(status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'));
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Route a git request. `service` is the info/refs service or the POST service name. */
export function handleGit(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitReply | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const tail = match[3] as string;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) return jsonReply(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);

  if (method === 'GET' && tail === 'info/refs') {
    const service = query.get('service');
    if (repo === undefined) return jsonReply(404, 'Not Found');
    if (service === 'git-upload-pack') {
      const wantsV2 = headers['git-protocol'] === 'version=2';
      if (wantsV2) return reply(200, UPLOAD_AD, advertiseV2());
      return reply(200, UPLOAD_AD, advertiseV0(store, repo, 'git-upload-pack'));
    }
    if (service === 'git-receive-pack') {
      return reply(200, RECEIVE_AD, advertiseV0(store, repo, 'git-receive-pack'));
    }
    return jsonReply(400, 'Bad Request');
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    if (repo === undefined) return jsonReply(404, 'Not Found');
    const wantsV2 = headers['git-protocol'] === 'version=2';
    return wantsV2 ? uploadPackV2(store, repo, body) : uploadPackV0(store, repo, body);
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    if (repo === undefined) return jsonReply(404, 'Not Found');
    return receivePack(store, repo, body);
  }

  return null;
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsResult {
  readonly refs: { oid: string; name: string; symrefTarget?: string; peeled?: string; unborn?: boolean }[];
}

function doLsRefs(store: Store, repo: Repo, args: Record<string, string[]>, wantPeel: boolean, wantSymrefs: boolean): LsRefsResult {
  const prefixes = args['ref-prefix'] ?? [];
  const out: LsRefsResult['refs'] = [];
  const refs = advertisedRefs(store, repo);
  const hasRefs = refs.some((ref) => ref.name !== 'HEAD');
  if (!hasRefs) {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
    return { refs: out };
  }
  for (const ref of refs) {
    if (ref.name === 'HEAD') {
      // A prefix-filtered ls-refs answers only refs under the prefix; HEAD is not one.
      if (prefixes.length > 0) continue;
      if (wantSymrefs) out.push({ oid: ref.oid, name: 'HEAD', symrefTarget: ref.symrefTarget });
      continue;
    }
    if (ref.name.endsWith('^{}')) {
      // Peeled lines are attached to their tag line in v2 as `peeled:` on the tag itself.
      continue;
    }
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    const entry: LsRefsResult['refs'][number] = { oid: ref.oid, name: ref.name };
    if (wantPeel) {
      const peeled = refs.find((candidate) => candidate.name === `${ref.name}^{}`);
      if (peeled !== undefined) entry.peeled = peeled.oid;
    }
    out.push(entry);
  }
  return { refs: out };
}

function lsRefsResponse(result: LsRefsResult): Buffer {
  const parts: Buffer[] = [];
  for (const ref of result.refs) {
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn HEAD symref-target:${ref.symrefTarget ?? ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
  readonly filter: string | null;
  readonly done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let filter: string | null = null;
  let done = false;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) { /* not exercised */ }
    else if (text.startsWith('deepen-not ')) { /* not exercised */ }
    else if (text.startsWith('filter ')) filter = text.slice(7).trim();
    else if (text === 'done') done = true;
  }
  return { wants, haves, shallow, depth, filter, done };
}

function wantedRefsLines(store: Store, repo: Repo, wants: readonly string[]): string[] {
  const lines: string[] = [];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) lines.push(`${want} ${name}`);
    }
  }
  return lines;
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  let acked = false;
  for (const have of args.haves) {
    if (args.wants.some((want) => store.isAncestor(repo, have, want))) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  parts.push(pktLine('ready\n'));
  parts.push(FLUSH);
  // shallow-info
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  // wanted-refs
  const wanted = wantedRefsLines(store, repo, args.wants);
  if (wanted.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wanted) parts.push(pktLine(`${line}\n`));
    parts.push(FLUSH);
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of args.haves) {
    if (args.wants.some((want) => store.isAncestor(repo, have, want))) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2(store: Store, repo: Repo, body: Buffer): GitReply {
  let reader: PktReader;
  try {
    reader = new PktReader(body);
  } catch {
    return jsonReply(400, 'Bad Request');
  }
  const lines: string[] = [];
  let command = '';
  const args: Record<string, string[]> = {};
  let section: 'args' | 'ls-refs' | 'fetch' = 'args';
  try {
    for (;;) {
      const item = reader.next();
      if (item === null) break;
      if (item.kind === 'flush') break;
      if (item.kind === 'delim') {
        section = command === 'ls-refs' ? 'ls-refs' : 'fetch';
        continue;
      }
      if (item.kind !== 'data') continue;
      const text = item.payload.toString('utf8').trim();
      if (text.startsWith('command=')) {
        command = text.slice('command='.length);
        continue;
      }
      const eq = text.indexOf('=');
      if (section === 'args' || command === '') {
        if (eq > 0) {
          const key = text.slice(0, eq);
          const value = text.slice(eq + 1);
          (args[key] ??= []).push(value);
        } else if (text !== '') {
          (args[text] ??= []).push('');
        }
        continue;
      }
      lines.push(text);
    }
  } catch {
    return jsonReply(400, 'Bad Request');
  }
  if (command === 'ls-refs') {
    const wantPeel = lines.includes('peel');
    const wantSymrefs = lines.includes('symrefs');
    const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const result = doLsRefs(store, repo, { 'ref-prefix': prefixes }, wantPeel, wantSymrefs);
    return reply(200, UPLOAD_RESULT, lsRefsResponse(result));
  }
  if (command === 'fetch') {
    const fetchArgs = parseFetchArgs(lines);
    return reply(200, UPLOAD_RESULT, fetchResponseV2(store, repo, fetchArgs));
  }
  return jsonReply(400, 'Bad Request');
}

function uploadPackV0(store: Store, repo: Repo, body: Buffer): GitReply {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let inHaves = false;
  try {
    for (;;) {
      const item = reader.next();
      if (item === null) break;
      if (item.kind === 'flush') {
        if (!inHaves) inHaves = true;
        else break;
      }
      if (item.kind !== 'data') continue;
      const text = item.payload.toString('utf8').trim();
      if (text.startsWith('want ')) {
        const oid = text.slice(5).split(' ')[0] as string;
        if (isOid(oid)) wants.push(oid);
      } else if (text.startsWith('have ')) {
        haves.push(text.slice(5).trim());
      } else if (text.startsWith('shallow ')) {
        shallow.push(text.slice(8).trim());
      } else if (text.startsWith('deepen ')) {
        depth = Number(text.slice(7).trim());
      } else if (text === 'done') {
        break;
      }
    }
  } catch {
    return jsonReply(400, 'Bad Request');
  }
  return reply(200, UPLOAD_RESULT, fetchResponseV0(store, repo, { wants, haves, shallow, depth, filter: null, done: true }));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function receivePack(store: Store, repo: Repo, body: Buffer): GitReply {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  try {
    for (;;) {
      const item = reader.next();
      if (item === null) break;
      if (item.kind === 'flush') break;
      if (item.kind !== 'data') continue;
      let text = item.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const parts = text.trim().split(' ');
      if (parts.length < 3) continue;
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) continue;
      commands.push({ oldOid, newOid, ref });
    }
  } catch {
    return jsonReply(400, 'Bad Request');
  }
  const packBytes = reader.rest();
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const entries = readPackRaw(packBytes, (oid) => repo.objects.get(oid));
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (newObject === undefined || (newObject.type !== 'commit' && newObject.type !== 'tag')) {
        results.push({ ref: command.ref, ok: false, reason: 'unpack failed: object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      // Fast-forward check: the new tip must descend from the old tip.
      const targetCommit = newObject.type === 'tag' ? tagTarget(newObject.data) : command.newOid;
      if (targetCommit === null || !store.isAncestor(repo, current, targetCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: unpackDetail });
  }
  const lines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(lines.map((line) => pktLine(line)));
  const framed = Buffer.concat([sidebandPack(report), FLUSH]);
  return reply(200, RECEIVE_RESULT, framed);
}

function tagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match === null ? null : (match[1] as string);
}
