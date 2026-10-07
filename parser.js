// Pure parsing / classification logic. No DOM here — covered by tests/parser.test.mjs.

// Header line per commit, then the body indented by 4 spaces (%w) so it can't be mistaken for a header.
export const FORMAT = '%H%x09%an%x09%ae%x09%aI%x09%s%n%w(0,4,4)%b';

export function buildCommand(target, source) {
  return `git --no-pager log --right-only --cherry-pick --no-merges --format='${FORMAT}' ${target}...${source}`;
}

// Fallback for output whose tabs were turned into spaces (copied from a terminal).
const LOOSE_LINE = /^([0-9a-f]{7,40})\s+(.+?)\s+(\S+@\S+)\s+(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))\s+(.*)$/i;
const HASH = /^[0-9a-f]{7,40}$/i;
const REAPPLY = /^Reapply "(.*)"$/s;
const BODY_LINE = /^[ \t]/;
const REVERTS_HASH = /This reverts commit ([0-9a-f]{7,40})/i;
const TASK_PREFIX = /^(?:\[[A-Za-z]+-\d+\])+/;
const TASK_TAG = /\[([A-Za-z]+)-(\d+)\]/g;

export function parseLine(line) {
  const parts = line.split('\t');
  if (parts.length >= 5 && HASH.test(parts[0].trim())) {
    const [hash, name, email, date, ...rest] = parts;
    return { hash: hash.trim(), name: name.trim(), email: email.trim(), date: date.trim(), subject: rest.join('\t') };
  }
  const m = line.trim().match(LOOSE_LINE);
  if (m) return { hash: m[1], name: m[2], email: m[3], date: m[4], subject: m[5] };
  return null;
}

export function unwrapReapply(subject) {
  let s = subject.trim();
  let depth = 0;
  for (let m; (m = s.match(REAPPLY)); depth++) s = m[1].trim();
  return { message: s, reapplied: depth };
}

export function classify(message) {
  if (message.startsWith('[AUTOCOMMIT]')) return { category: 'skip', reason: 'AUTOCOMMIT' };
  if (message.startsWith('[hotfix]')) return { category: 'skip', reason: 'hotfix' };
  const prefix = message.match(TASK_PREFIX);
  if (prefix) {
    const tasks = [...prefix[0].matchAll(TASK_TAG)].map((t) => `${t[1].toUpperCase()}-${t[2]}`);
    return { category: 'main', reason: 'task', tasks };
  }
  if (message.startsWith('[test] ')) return { category: 'test', reason: 'test' };
  if (message.startsWith('Revert')) return { category: 'skip', reason: 'Revert' };
  return { category: 'unknown', reason: 'unknown' };
}

const REVERT = /^Revert "(.*)"$/s;

// What a commit undoes, judged by subject: `Revert "S"` undoes S;
// git names a revert of `Revert "S"` as `Reapply "S"`. Used when the body has no hash.
export function revertTarget(subject) {
  const s = subject.trim();
  const revert = s.match(REVERT);
  if (revert) return revert[1].trim();
  const reapply = s.match(REAPPLY);
  if (reapply) return `Revert "${reapply[1].trim()}"`;
  return null;
}

// Links reverts to the commits they undo: by `This reverts commit <hash>` from the body,
// otherwise by subject. Log is newest first, so a subject match is looked up among older
// (later) entries first; each commit can be undone once.
export function linkReverts(commits) {
  commits.forEach((c, i) => {
    const hash = c.body.match(REVERTS_HASH)?.[1].toLowerCase();
    if (hash) {
      c.revertsHash = hash;
      c.revertsSubject = revertTarget(c.subject) ?? '';
      const undone = commits.find((x) => x !== c && x.hash.toLowerCase().startsWith(hash));
      if (undone) {
        c.reverts = undone.hash;
        undone.revertedBy = c.hash;
      }
      return;
    }
    const target = revertTarget(c.subject);
    if (target === null) return;
    c.revertsSubject = target;
    const free = (x) => x.subject.trim() === target && !x.revertedBy;
    const undone = commits.slice(i + 1).find(free) ?? commits.slice(0, i).reverse().find(free);
    if (!undone) return;
    c.reverts = undone.hash;
    undone.revertedBy = c.hash;
  });
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const isUndone = (c, seen = new Set()) => {
    if (!c.revertedBy || seen.has(c.hash)) return false;
    seen.add(c.hash);
    return !isUndone(byHash.get(c.revertedBy), seen);
  };
  for (const c of commits) c.undone = isUndone(c);
}

export function compareTasks(a, b) {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa.localeCompare(pb) || Number(na) - Number(nb);
}

// Pulls task ids out of free text: "abc-1, [ABC-2]" → ['ABC-1', 'ABC-2'].
export function parseTasks(text) {
  return [...new Set([...text.matchAll(/([A-Za-z]+)-(\d+)/g)].map((t) => `${t[1].toUpperCase()}-${t[2]}`))];
}

// overrides: hash → { category, tasks? } — manual decisions for commits the rules call unknown.
export function analyze(text, overrides = new Map()) {
  const commits = [];
  const invalid = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    if (BODY_LINE.test(raw) && commits.length) {
      const last = commits[commits.length - 1];
      last.body += (last.body ? '\n' : '') + raw.replace(/^ {4}/, '');
      return;
    }
    const parsed = parseLine(raw);
    if (!parsed) {
      invalid.push({ lineNo: i + 1, raw });
      return;
    }
    const { message, reapplied } = unwrapReapply(parsed.subject);
    let cls = classify(message);
    const manual = cls.category === 'unknown' ? overrides.get(parsed.hash) : undefined;
    if (manual) cls = { category: manual.category, reason: 'manual', tasks: manual.tasks ?? [], manual: true };
    commits.push({ ...parsed, body: '', message, reapplied, ...cls });
  });

  linkReverts(commits);

  const by = (c) => commits.filter((x) => x.category === c);
  const main = by('main');
  const skip = by('skip');
  const test = by('test');
  const unknown = by('unknown');
  const tasks = [...new Set(main.flatMap((c) => c.tasks))].sort(compareTasks);
  // Tasks whose every main commit ends up reverted — likely nothing to carry over.
  const undoneTasks = tasks.filter((t) => main.every((c) => !c.tasks.includes(t) || c.undone));
  const ok = commits.length > 0 && unknown.length === 0 && invalid.length === 0;

  return {
    commits, main, skip, test, unknown, invalid, tasks, undoneTasks, ok,
    result: ok ? tasks.map((t) => `[${t}]`).join('') : '',
  };
}
