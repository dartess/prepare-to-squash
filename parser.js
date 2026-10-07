// Pure parsing / classification logic. No DOM here — covered by tests/parser.test.mjs.

export const FORMAT = '%H%x09%an%x09%ae%x09%aI%x09%s';

export function buildCommand(target, source) {
  return `git --no-pager log --right-only --cherry-pick --no-merges --format='${FORMAT}' ${target}...${source}`;
}

// Fallback for output whose tabs were turned into spaces (copied from a terminal).
const LOOSE_LINE = /^([0-9a-f]{7,40})\s+(.+?)\s+(\S+@\S+)\s+(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))\s+(.*)$/i;
const HASH = /^[0-9a-f]{7,40}$/i;
const REAPPLY = /^Reapply "(.*)"$/s;
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
  const prefix = message.match(TASK_PREFIX);
  if (prefix) {
    const tasks = [...prefix[0].matchAll(TASK_TAG)].map((t) => `${t[1].toUpperCase()}-${t[2]}`);
    return { category: 'main', reason: 'task', tasks };
  }
  if (message.startsWith('[test] ')) return { category: 'test', reason: 'test' };
  if (message.startsWith('Revert')) return { category: 'skip', reason: 'Revert' };
  return { category: 'unknown', reason: 'unknown' };
}

export function compareTasks(a, b) {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa.localeCompare(pb) || Number(na) - Number(nb);
}

export function analyze(text) {
  const commits = [];
  const invalid = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const parsed = parseLine(raw);
    if (!parsed) {
      invalid.push({ lineNo: i + 1, raw });
      return;
    }
    const { message, reapplied } = unwrapReapply(parsed.subject);
    commits.push({ ...parsed, message, reapplied, ...classify(message) });
  });

  const by = (c) => commits.filter((x) => x.category === c);
  const main = by('main');
  const skip = by('skip');
  const test = by('test');
  const unknown = by('unknown');
  const tasks = [...new Set(main.flatMap((c) => c.tasks))].sort(compareTasks);
  const ok = commits.length > 0 && unknown.length === 0 && invalid.length === 0;

  return {
    commits, main, skip, test, unknown, invalid, tasks, ok,
    result: ok ? tasks.map((t) => `[${t}]`).join('') : '',
  };
}
