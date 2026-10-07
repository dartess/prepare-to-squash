import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildCommand, classify, parseLine, unwrapReapply } from '../parser.js';

const T = (h, s) => `${h}\tJohn Doe\tjohn@example.com\t2026-05-22T15:17:01+04:00\t${s}`;
const H = '0123456789abcdef0123456789abcdef01234567';

test('command is one line', () => {
  assert.equal(
    buildCommand('target', 'source'),
    "git --no-pager log --right-only --cherry-pick --no-merges --format='%H%x09%an%x09%ae%x09%aI%x09%s%n%w(0,4,4)%b' target...source",
  );
});

test('parses tab-separated line', () => {
  assert.deepEqual(parseLine(T(H, '[ABC-42] implement feature')), {
    hash: H, name: 'John Doe', email: 'john@example.com',
    date: '2026-05-22T15:17:01+04:00', subject: '[ABC-42] implement feature',
  });
});

test('parses space-separated line (tabs lost on copy)', () => {
  const p = parseLine(`${H}        John Doe   john@example.com      2026-05-22T15:17:01+04:00       [ABC-42] implement  x`);
  assert.equal(p.name, 'John Doe');
  assert.equal(p.email, 'john@example.com');
  assert.equal(p.subject, '[ABC-42] implement  x');
});

test('unwraps Reapply, including nested', () => {
  assert.deepEqual(unwrapReapply('Reapply "[ABC-42] ui analytics"'), { message: '[ABC-42] ui analytics', reapplied: 1 });
  assert.deepEqual(unwrapReapply('Reapply "Reapply "[A-1] x""'), { message: '[A-1] x', reapplied: 2 });
});

test('classification rules', () => {
  assert.equal(classify('[AUTOCOMMIT] bump').category, 'skip');
  assert.deepEqual(classify('[SFA-1][ab-22] x').tasks, ['SFA-1', 'AB-22']);
  assert.equal(classify('[test] smth').category, 'test');
  assert.equal(classify('[test]smth').category, 'unknown');
  assert.equal(classify('Revert "[SFA-1] x"').category, 'skip');
  assert.equal(classify('[SFA-] x').category, 'unknown');
  assert.equal(classify('fix typo').category, 'unknown');
});

test('result: sorted unique tags', () => {
  const r = analyze([
    T(H, '[SFA-100] a'), T(H, '[SFA-20] b'), T(H, 'Reapply "[ABC-5] c"'),
    T(H, '[SFA-20] again'), T(H, '[AUTOCOMMIT] d'), T(H, '[test] e'), '',
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.test.length, 1);
  assert.equal(r.result, '[ABC-5][SFA-20][SFA-100]');
  assert.equal(r.skip.length, 1);
});

test('unknown blocks result', () => {
  const r = analyze([T(H, '[SFA-1] a'), T(H, 'oops')].join('\r\n'));
  assert.equal(r.ok, false);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.result, '');
});

test('garbage lines are reported', () => {
  const r = analyze('hello world');
  assert.equal(r.invalid.length, 1);
  assert.equal(r.ok, false);
});

test('links reverts to reverted commits', () => {
  const h = (n) => String(n).repeat(40).slice(0, 40);
  const r = analyze([
    T(h(5), 'Reapply "[ABC-1] a"'),
    T(h(4), 'Revert "[ABC-1] a"'),
    T(h(3), 'Revert "[ABC-2] b"'),
    T(h(2), '[ABC-2] b'),
    T(h(1), '[ABC-1] a'),
    T(h(6), 'Revert "[ABC-9] not here"'),
  ].join('\n'));
  const get = (n) => r.commits.find((c) => c.hash === h(n));
  assert.equal(get(4).reverts, h(1));
  assert.equal(get(5).reverts, h(4));
  assert.equal(get(3).reverts, h(2));
  assert.equal(get(6).reverts, undefined);
  assert.equal(get(6).revertsSubject, '[ABC-9] not here');
  assert.equal(get(1).undone, false); // reverted, then reapplied
  assert.equal(get(4).undone, true);
  assert.equal(get(2).undone, true);
  assert.deepEqual(r.undoneTasks, ['ABC-2']);
  assert.equal(r.result, '[ABC-1][ABC-2]');
});

test('body lines attach to the commit; revert hash from body wins over subject', () => {
  const h = (n) => String(n).repeat(40).slice(0, 40);
  const r = analyze([
    T(h(3), 'Revert "[ABC-1] a"'),
    `    This reverts commit ${h(1)}.`,
    T(h(2), '[ABC-1] a'),
    '    second commit with the same subject',
    '',
    T(h(1), '[ABC-1] a'),
    T(h(4), 'Revert "[ABC-7] gone"'),
    '    This reverts commit abcdef1234567.',
  ].join('\n'));
  const get = (n) => r.commits.find((c) => c.hash === h(n));
  assert.equal(r.invalid.length, 0);
  assert.equal(r.commits.length, 4);
  assert.equal(get(2).body, 'second commit with the same subject');
  assert.equal(get(3).reverts, h(1)); // subject match would have picked h(2)
  assert.equal(get(2).revertedBy, undefined);
  assert.equal(get(4).revertsHash, 'abcdef1234567');
  assert.equal(get(4).reverts, undefined);
});

test('indented line before any commit is invalid', () => {
  assert.equal(analyze('    orphan body').invalid.length, 1);
});
