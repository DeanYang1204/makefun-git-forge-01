// Git smart HTTP, implemented from scratch on node:zlib / node:crypto:
// pkt-line framing, packfile read/write (plain objects, no deltas — the suite's
// client never sends or requires deltas), upload-pack protocol v2 and receive-pack v0.

import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, isOid, parseCommit, parseTree, ZERO_OID, type GitObject, type ObjectType, type Repo, type Store } from './store.ts';

export const PKT_MAX = 65520;

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type PktItem = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Incremental pkt-line reader over a buffer. */
export class PktReader {
  private offset = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  /** Next item, or null when the buffer is exhausted. */
  next(): PktItem | null {
    if (this.offset >= this.buf.length) return null;
    if (this.buf.length - this.offset < 4) throw new Error('truncated pkt-line');
    const header = this.buf.subarray(this.offset, this.offset + 4).toString('ascii');
    if (header === '0000') {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (header === '0001') {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (header === '0002') {
      this.offset += 4;
      return { kind: 'end' };
    }
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length < 4 || this.offset + length > this.buf.length) throw new Error('bad pkt-line length');
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** The rest of the buffer, raw (the pack after the flush in receive-pack). */
  rest(): Buffer {
    const out = this.buf.subarray(this.offset);
    this.offset = this.buf.length;
    return out;
  }
}

/** Read all data packets until flush; returns the payload lines as strings. */
export function readLines(reader: PktReader): string[] {
  const lines: string[] = [];
  for (;;) {
    const item = reader.next();
    if (item === null) break;
    if (item.kind === 'flush') break;
    if (item.kind === 'data') lines.push(item.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a v2 pack of plain (non-delta) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODES[object.type];
    const size = object.data.length;
    const head: number[] = [(typeCode << 4) | (size & 0x0f)];
    let remaining = size >> 4;
    while (remaining > 0) {
      head[head.length - 1] |= 0x80;
      head.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(requireSha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

import { createHash } from 'node:crypto';
function requireSha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface ParsedPackEntry {
  readonly oid: string;
  readonly type: ObjectType;
  readonly data: Buffer;
}

/**
 * Read a packfile; supports OFS_DELTA (6) and REF_DELTA (7) entries. Deflate stream
 * lengths are found by probing prefixes until the inflated size matches the declared
 * size — the suite's client sends plain packs, and this handles them exactly.
 */
export function readPackRaw(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPackEntry[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  if (requireSha1(pack.subarray(0, pack.length - 20)) !== trailer.toString('hex')) throw new Error('pack checksum');
  interface RawEntry {
    readonly offset: number;
    readonly typeCode: number;
    readonly size: number;
    readonly data: Buffer;
    readonly baseOffset?: number;
    readonly baseOid?: string;
  }
  const rawEntries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // Find the deflate stream's end by binary search: inflateSync throws on a truncated
    // stream and ignores trailing bytes, so success is monotonic in the prefix length.
    let lo = offset;
    let hi = pack.length - 20;
    let consumed = -1;
    let inflated: Buffer | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const out = inflateSync(pack.subarray(offset, mid));
        if (out.length === size) {
          consumed = mid;
          inflated = out;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      } catch {
        lo = mid + 1;
      }
    }
    if (consumed < 0 || inflated === null) throw new Error('pack deflate');
    rawEntries.push({ offset: start, typeCode, size, data: inflated, baseOffset, baseOid });
    offset = consumed;
  }
  if (offset !== pack.length - 20) throw new Error('pack trailing bytes');
  const byOffset = new Map<number, ParsedPackEntry>();
  const resolved: ParsedPackEntry[] = [];
  const resolve = (entry: RawEntry, seen: Set<number>): ParsedPackEntry => {
    if (byOffset.has(entry.offset)) return byOffset.get(entry.offset) as ParsedPackEntry;
    if (seen.has(entry.offset)) throw new Error('pack delta cycle');
    seen.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: ParsedPackEntry | undefined;
      if (entry.typeCode === 6 && entry.baseOffset !== undefined) {
        const baseRaw = rawEntries.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseRaw !== undefined) base = resolve(baseRaw, seen);
      } else if (entry.typeCode === 7 && entry.baseOid !== undefined) {
        base = resolved.find((candidate) => candidate.oid === entry.baseOid);
        if (base === undefined && resolveBase !== undefined) {
          const found = resolveBase(entry.baseOid);
          if (found !== undefined) base = { oid: entry.baseOid, type: found.type, data: found.data };
        }
      }
      if (base === undefined) throw new Error('pack delta base missing');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPES[entry.typeCode] as ObjectType;
      if (type === undefined) throw new Error('pack unknown type');
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const parsed: ParsedPackEntry = { oid, type, data };
    byOffset.set(entry.offset, parsed);
    resolved.push(parsed);
    return parsed;
  };
  for (const entry of rawEntries) resolve(entry, new Set());
  if (resolved.length !== count) throw new Error('pack count mismatch');
  return resolved;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size');
  const parts: Buffer[] = [];
  let outSize = 0;
  while (pos < delta.length) {
    const opcode = delta[pos];
    pos += 1;
    if (opcode === 0) throw new Error('delta opcode 0');
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          copyOffset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          copySize |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy overrun');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      outSize += copySize;
    } else {
      parts.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      outSize += opcode;
    }
  }
  if (outSize !== targetSize) throw new Error('delta target size');
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

export interface AdvertisedRef {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
  readonly unborn?: boolean;
}

function capsLine(caps: readonly string[]): string {
  return caps.join(' ');
}

/** All refs of a repo, HEAD first, with peeled lines for annotated tags. */
export function advertisedRefs(store: Store, repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) refs.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    refs.push({ oid, name });
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) refs.push({ oid: match[1] as string, name: `${name}^{}`, peeled: match[1] as string });
    }
  }
  return refs;
}

const UPLOAD_V0_CAPS = ['side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack_detailed', 'shallow', 'agent=makefun-git-forge/1.0'];
const RECEIVE_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=makefun-git-forge/1.0'];

/** The v0 advertisement body for a service. */
export function advertiseV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = advertisedRefs(store, repo);
  if (refs.length === 0) {
    const symref = service === 'git-upload-pack' ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsLine(caps)}${symref}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) {
        const symref = ref.name === 'HEAD' && ref.symrefTarget !== undefined ? ` symref=HEAD:${ref.symrefTarget}` : '';
        parts.push(pktLine(`${ref.oid} ${ref.name}\0${capsLine(caps)}${symref}\n`));
      } else {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement body for upload-pack. */
export function advertiseV2(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'agent=makefun-git-forge/1.0\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
}

// ---------------------------------------------------------------- object selection for fetch

export interface FetchSelection {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * Objects to send for a fetch: commits reachable from `wants` within `depth` (1 = the
 * wants themselves), minus commits reachable from non-shallow haves, minus the shallow
 * boundary oids themselves; trees/blobs are the closure of the sent commits minus the
 * closure of every have. This matches git's shallow-deepening semantics and never
 * re-sends an object the client already holds.
 */
export function selectFetchObjects(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchSelection {
  const shallowSet = new Set(shallowBoundaries);
  // Commits reachable from wants within the depth limit.
  const wantedCommits = new Map<string, number>(); // oid -> depth from a want
  const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid, depth: 1 }));
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    if (wantedCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      wantedCommits.set(oid, d);
      if (match !== null) queue.push({ oid: match[1] as string, depth: d });
      continue;
    }
    if (object.type !== 'commit') continue;
    wantedCommits.set(oid, d);
    if (depth === null || d < depth) {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: d + 1 });
    }
  }
  // Commits excluded by non-shallow haves (their full ancestry).
  const excludedCommits = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) continue;
    for (const oid of store.reachableCommits(repo, have)) excludedCommits.add(oid);
  }
  for (const oid of shallowSet) excludedCommits.add(oid);
  const sendCommits = [...wantedCommits.keys()].filter((oid) => !excludedCommits.has(oid));
  // Shallow bookkeeping.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of wantedCommits) {
      if (d === depth && !excludedCommits.has(oid)) shallow.push(oid);
    }
    for (const oid of shallowSet) {
      if (wantedCommits.has(oid) && (wantedCommits.get(oid) as number) < depth) unshallow.push(oid);
    }
  }
  // Trees/blobs the client already holds: the tree closure of every commit reachable
  // from a have. Commit oids are deliberately NOT in this set: a shallow boundary's
  // ancestors must still be sendable when deepening.
  const heldObjects = new Set<string>();
  const addTreeClosureTo = (target: Set<string>, treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (target.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      target.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  for (const have of haves) {
    // Walk the have's ancestry, but never cross a shallow boundary: the client holds
    // a boundary commit's own tree, never its parents' trees.
    const stack = [have];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = repo.objects.get(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      addTreeClosureTo(heldObjects, parseCommit(commit.data).tree);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(commit.data).parents) stack.push(parent);
    }
  }
  const sendObjects = new Map<string, GitObject>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (heldObjects.has(oid) || sendObjects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      sendObjects.set(oid, object);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    sendObjects.set(oid, object);
    if (object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
  }
  // Wanted tag objects themselves (not reachable from a commit).
  for (const oid of wants) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag' && !heldObjects.has(oid)) {
      sendObjects.set(oid, object);
    }
  }
  return { objects: [...sendObjects.values()], shallow, unshallow };
}

/** Sideband-wrap pack bytes: band 1 packets, each at most 65515 data bytes. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
