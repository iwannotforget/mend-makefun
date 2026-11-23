// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths and format detection (sections 1 to 4), line matching at three tiers (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): that hand-over and runner.ts are the kit's, kept as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in the patch's order, as [old path, new path]. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- Section 3: a file as lines ----------

interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function serialize(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.finalBreak ? fl.br : '');
}

// ---------- Section 5: matching lines at three tiers ----------

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!matchLine(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

function findTier(lines: string[], O: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, O, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** A line of N: a context line (ctx: its index in O) is written as the file's own matched line; any other line is
 *  written as it is, except at tier 2, where it is re-indented from O's first line's indent to the file's. */
interface NLine {
  text: string;
  ctx: number;
}

function buildWritten(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadWs(lines[pos]!);
  const P = leadWs(O[0]!);
  return N.map((e) => {
    if (e.ctx >= 0) return lines[pos + e.ctx]!;
    if (tier === 2) {
      const t = e.text;
      if (t === '' || t.trim() === '') return t;
      if (t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return e.text;
  });
}

// ---------- Section 9: JSON edits ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Section 6: unified diffs ----------

interface HunkBodyLine {
  kind: string; // ' ', '-', '+' or '\'
  text: string;
  empty: boolean; // the patch line itself was empty (a context line); dropped at the end of a body
}
interface Hunk {
  a: number;
  body: HunkBodyLine[];
}
interface Section {
  gitOld?: string;
  gitNew?: string;
  dashOld?: string | null;
  dashNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a --- or +++ line: the text after the four characters, up to the first tab, with surrounding
 *  spaces removed; /dev/null is no file; a leading a/ or b/ is removed. */
function headerPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfter(body: HunkBodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const k = body[j]!.kind;
    if (k === ' ' || k === '+') return j + 1 < body.length && body[j + 1]!.kind === '\\';
  }
  return false;
}

function applyHunks(fl: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = [...fl.lines];
  let finalBreak = fl.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        O.push(b.text);
        N.push({ text: b.text, ctx: O.length - 1 });
      } else if (b.kind === '-') O.push(b.text);
      else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
    }
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...N.map((e) => e.text));
      if (atEnd) finalBreak = !backslashAfter(h.body);
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      for (const p of found.occ) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const written = buildWritten(lines, pos, O, N, found.tier);
      const touches = pos + O.length === lines.length;
      lines.splice(pos, O.length, ...written);
      if (touches) finalBreak = !backslashAfter(h.body);
      d += N.length - O.length;
    }
  }
  return { lines, br: fl.br, finalBreak };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = (sec.dashOld !== undefined ? sec.dashOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld) as string | null;
  const newP = (sec.dashNew !== undefined ? sec.dashNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew) as string | null;
  return (tree) => {
    for (const p of [oldP, newP]) if (typeof p === 'string' && !safe(p)) throw new Fail('unsafe', p);
    if (oldP === null || sec.newFile) {
      // a creation: the file is the + lines of all its hunks, in order
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastBackslash = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, j) => {
          if (b.kind === '+') {
            plus.push(b.text);
            lastBackslash = h.body[j + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastBackslash ? '' : '\n'));
      return;
    }
    if (newP === null || sec.deletedFile) {
      // a deletion: its hunks are not read
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const text = serialize(applyHunks(parseFile(before), sec.hunks, strict, oldP));
    if (newP !== oldP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  const closeSection = (): void => {
    closeHunk();
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const newSection = (): Section => ({ newFile: false, deletedFile: false, hunks: [] });
  const startGit = (line: string, ln: number): void => {
    const rest = line.slice('diff --git '.length);
    const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
    if (sep < 0) throw new Exit2(`error: parse ${ln}`);
    closeSection();
    cur = newSection();
    cur.gitOld = rest.slice(2, sep);
    cur.gitNew = rest.slice(sep + 3);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    const next = i + 1 < lines.length ? lines[i + 1]! : undefined;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        startGit(line, ln);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        closeSection();
        cur = newSection();
        cur.dashOld = headerPath(line.slice(4));
        cur.dashNew = headerPath(next.slice(4));
        i += 2;
        continue;
      }
      const c = line[0];
      if (line === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk.body.push({ kind: line === '' ? ' ' : c!, text: line === '' ? '' : line.slice(1), empty: line === '' });
        i += 1;
        continue;
      }
      closeHunk();
    }
    if (line.startsWith('diff --git ')) {
      startGit(line, ln);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.dashOld === undefined) {
          cur.dashOld = headerPath(line.slice(4));
          cur.dashNew = headerPath(next.slice(4));
        } else {
          closeSection();
          cur = newSection();
          cur.dashOld = headerPath(line.slice(4));
          cur.dashNew = headerPath(next.slice(4));
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${ln + 1}`);
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && cur.hunks.length === 0 && cur.dashNew === undefined) {
      cur.dashNew = headerPath(line.slice(4));
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  closeSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = parseFile(before);
    const found = findTier(fl.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const lines = [...fl.lines];
    lines.splice(
      pos,
      oldLines.length,
      ...buildWritten(fl.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier),
    );
    tree.now.set(path, serialize({ lines, br: fl.br, finalBreak: fl.finalBreak }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= from; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLn}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLn}`);
    let rp = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = k;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${searchLn}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    from = rp + 1;
    i = rp + 1;
  }
  return edits;
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

function v4aAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, body: { line: string; ln: number }[], headerLn: number, strict: boolean): Edit {
  let moveTo: string | undefined;
  let idx = 0;
  if (body.length > 0 && body[0]!.line.startsWith('*** Move to: ')) {
    moveTo = body[0]!.line.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  for (; idx < body.length; idx += 1) {
    const { line, ln } = body[idx]!;
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, O: [], N: [] };
      chunks.push(chunk);
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${ln}`);
      chunk.eof = true;
      chunk = null;
      continue;
    }
    const c = line[0];
    if (line === '' || c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        chunk = { anchor: null, eof: false, O: [], N: [] };
        chunks.push(chunk);
      }
      if (line === '' || c === ' ') {
        const t = line === '' ? '' : line.slice(1);
        chunk.O.push(t);
        chunk.N.push({ text: t, ctx: chunk.O.length - 1 });
      } else if (c === '-') chunk.O.push(line.slice(1));
      else chunk.N.push({ text: line.slice(1), ctx: -1 });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headerLn}`);
  const tiers = strict ? [0] : [0, 1, 2];
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fl = parseFile(before);
    let lines = [...fl.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (matchLine(lines[k]!, ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...ch.N.map((e) => e.text));
        cursor = at + ch.N.length;
      } else {
        let placed: { tier: number; pos: number } | null = null;
        for (const tier of tiers) {
          const occ = occurrences(lines, ch.O, tier, cursor).filter((p) => !ch.eof || p + ch.O.length === lines.length);
          if (occ.length > 0) {
            placed = { tier, pos: occ[0]! };
            break;
          }
        }
        if (placed === null) throw new Fail('no-match', path);
        const written = buildWritten(lines, placed.pos, ch.O, ch.N, placed.tier);
        lines.splice(placed.pos, ch.O.length, ...written);
        cursor = placed.pos + written.length;
      }
    }
    const text = serialize({ lines, br: fl.br, finalBreak: fl.finalBreak });
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const prefixes: [string, string][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const hit = prefixes.find(([p]) => line.startsWith(p));
    if (hit === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const [prefix, kind] = hit;
    const headerLn = i + 1;
    const path = line.slice(prefix.length).trim();
    const body: { line: string; ln: number }[] = [];
    let j = i + 1;
    while (j < last && !prefixes.some(([p]) => lines[j]!.startsWith(p))) {
      body.push({ line: lines[j]!, ln: j + 1 });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new Exit2(`error: parse ${b.ln}`);
      }
      edits.push(v4aAdd(path, content));
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.ln}`);
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdate(path, body, headerLn, strict));
    }
    i = j;
  }
  return edits;
}

// ---------- Sections 1, 2 and 10: the command line, the run, the write ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) state.set(p, { was: tree.original(p), now: tree.now.get(p)! });
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const [o, n] of tree.moves) {
    const bo = state.get(o);
    const bn = state.get(n);
    if (bo !== undefined && bn !== undefined && bo.was !== null && bo.now === null && bn.was === null && bn.now !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const [p, st] of state) {
    if (used.has(p) || st.was === st.now) continue;
    rows.push({ key: p, text: `${st.was === null ? 'A' : st.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, st] of state) {
      if (st.was === st.now) continue;
      if (st.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, st.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
