import { analyze, buildCommand } from './parser.js';

const $ = (id) => document.getElementById(id);
const el = {
  target: $('target'), source: $('source'), swap: $('swap'),
  cmdBox: $('cmd-box'), command: $('command'), copyCommand: $('copy-command'), cmdHint: $('cmd-hint'),
  log: $('log'), paste: $('paste'), clear: $('clear'),
  result: $('result'), resultMain: $('result-main'), notices: $('notices'), chips: $('chips'), list: $('list'), toast: $('toast'),
};

const store = {
  get(k) { try { return localStorage.getItem(`pts:${k}`) ?? ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(`pts:${k}`, v); } catch { /* storage unavailable */ } },
};

let filter = 'all';
let lastAnalysis = null;

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const branch = (input) => input.value.trim();

// ---------- clipboard & toast ----------

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1600);
}

async function copy(text, button, what = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(what);
  if (button) {
    const prev = button.textContent;
    button.textContent = 'Готово ✓';
    button.classList.add('done');
    setTimeout(() => { button.textContent = prev; button.classList.remove('done'); }, 1200);
  }
}

// ---------- step 1–2: branches & command ----------

function renderCommand() {
  const target = branch(el.target);
  const source = branch(el.source);
  const ready = Boolean(target && source);
  const cmd = buildCommand(target || '<цель>', source || '<источник>');
  const [head] = cmd.split(/ (?=\S+\.\.\.\S+$)/);
  el.command.innerHTML = `${esc(head)} <span class="b">${esc(target || '<цель>')}</span>...<span class="b">${esc(source || '<источник>')}</span>`;
  el.cmdBox.classList.toggle('empty', !ready);
  el.copyCommand.disabled = !ready;
  el.cmdHint.hidden = ready;

  store.set('target', target);
  store.set('source', source);
  const url = new URL(location.href);
  target ? url.searchParams.set('target', target) : url.searchParams.delete('target');
  source ? url.searchParams.set('source', source) : url.searchParams.delete('source');
  history.replaceState(null, '', url);
}

// ---------- step 3: analysis ----------

function highlight(message) {
  const m = message.match(/^(?:\[[A-Za-z]+-\d+\])+/);
  if (!m) return esc(message);
  return `<span class="tag">${esc(m[0])}</span>${esc(message.slice(m[0].length))}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const jump = (hash) =>
  `<button class="hash jump" type="button" data-jump="${esc(hash)}" title="Перейти к коммиту">${esc(hash.slice(0, 10))}</button>`;

function revertInfo(c) {
  const lines = [];
  if (c.revertsSubject !== undefined) {
    const verb = c.subject.trim().startsWith('Reapply') ? 'возвращает' : 'ревертит';
    lines.push(c.reverts
      ? `<div class="link">↩ ${verb} ${jump(c.reverts)} <span class="ref">${esc(lastAnalysis.byHash.get(c.reverts).subject)}</span></div>`
      : `<div class="link missing">↩ ${verb} <span class="ref">${esc(c.revertsSubject)}</span> — коммита нет в этом диапазоне</div>`);
  }
  if (c.revertedBy) {
    lines.push(c.undone
      ? `<div class="link undone">✕ отревертен в ${jump(c.revertedBy)}</div>`
      : `<div class="link">✕ отревертен в ${jump(c.revertedBy)}, но ревёрт потом откатили — изменения в силе</div>`);
  }
  return lines.join('');
}

function commitRow(c) {
  const pills = [];
  if (c.reapplied) {
    pills.push(`<span class="pill" title="${esc(c.subject)}">reapply${c.reapplied > 1 ? ` ×${c.reapplied}` : ''}</span>`);
  }
  if (c.revertedBy) pills.push(c.undone ? '<span class="pill reverted">reverted</span>' : '<span class="pill">reverted → reapplied</span>');
  return `<div class="row ${c.category}${c.undone ? ' undone' : ''}" data-hash="${esc(c.hash)}">
    <span class="badge ${c.category}">${c.category}</span>
    <div class="msg"><span class="text">${highlight(c.message)}</span>${pills.join('')}
      ${revertInfo(c)}
      <div class="meta">
        <button class="hash" type="button" data-copy="${esc(c.hash)}" title="Скопировать полный хэш">${esc(c.hash.slice(0, 10))}</button>
        <span title="${esc(c.email)}">${esc(c.name)}</span>
      </div>
    </div>
    <span class="date" title="${esc(c.date)}">${formatDate(c.date)}</span>
  </div>`;
}

function invalidRow(x) {
  return `<div class="row invalid">
    <span class="badge invalid">строка ${x.lineNo}</span>
    <div class="msg"><div class="raw">${esc(x.raw)}</div>
      <div class="meta">Не удалось разобрать: ожидается 5 полей через табуляцию</div>
    </div><span></span>
  </div>`;
}

function renderNotices(a) {
  const notices = [];
  if (a.test.length) {
    const n = a.test.length;
    notices.push(`<div class="notice"><span class="warn-icon" aria-hidden="true">!</span>
      <div class="body">Есть тестовые коммиты — <b>${n}</b> ${plural(n, 'коммит', 'коммита', 'коммитов')} <code>[test]</code>. В строку задач не попали.</div>
      <button class="btn ghost" type="button" data-filter="test">Показать</button></div>`);
  }
  if (a.undoneTasks.length) {
    notices.push(`<div class="notice"><span class="warn-icon" aria-hidden="true">!</span>
      <div class="body">Все коммиты отревертены, но задачи в строке есть: <b class="mono">${a.undoneTasks.map((t) => `[${esc(t)}]`).join('')}</b>. Проверь, нужны ли они.</div>
      <button class="btn ghost" type="button" data-filter="reverted">Показать</button></div>`);
  }
  el.notices.innerHTML = notices.join('');
  el.notices.hidden = !notices.length;
}

function renderResultMain(a) {
  renderNotices(a);
  if (a.ok && a.tasks.length) {
    el.resultMain.className = 'result-main ok';
    el.resultMain.innerHTML = `<div class="body">
        <div class="label">Готово · ${a.tasks.length} ${plural(a.tasks.length, 'задача', 'задачи', 'задач')}</div>
        <div class="value">${esc(a.result).replaceAll('][', ']<wbr>[')}</div>
      </div>
      <button class="btn" type="button" id="copy-result">Копировать</button>`;
    $('copy-result').addEventListener('click', (e) => copy(a.result, e.currentTarget, 'Строка задач скопирована'));
    return;
  }
  if (a.ok) {
    el.resultMain.className = 'result-main empty';
    el.resultMain.innerHTML = `<div class="body"><div class="label">Нет задач</div>
      <div class="value muted">Задач с тегом нет — переносить нечего.</div></div>`;
    return;
  }
  const problems = [];
  if (a.unknown.length) problems.push(`неизвестный тип коммита — ${a.unknown.length} шт.`);
  if (a.invalid.length) problems.push(`не разобрано строк — ${a.invalid.length}`);
  el.resultMain.className = 'result-main err';
  el.resultMain.innerHTML = `<div class="body"><div class="label">Ошибка</div>
    <div class="value">${problems.length ? cap(problems.join('; ')) : 'Коммитов не найдено'}</div></div>`;
}

function renderList(a) {
  const groups = [
    ['all', 'Все', a.commits.length + a.invalid.length],
    ['unknown', 'unknown', a.unknown.length],
    ['invalid', 'не разобрано', a.invalid.length],
    ['test', 'test', a.test.length],
    ['main', 'main', a.main.length],
    ['skip', 'skip', a.skip.length],
    ['reverted', 'reverted', a.reverted.length],
  ].filter(([key, , n]) => key === 'all' || key === 'main' || key === 'skip' || n > 0);

  if (!groups.some(([key]) => key === filter)) filter = 'all';

  el.chips.innerHTML = groups.map(([key, label, n]) =>
    `<button class="chip" role="tab" type="button" data-filter="${key}" aria-selected="${key === filter}">
      ${key === 'all' ? '' : `<span class="dot ${key}"></span>`}${label} <b>${n}</b></button>`).join('');

  // Problems first, then the rest in original log order.
  const rows = [];
  if (filter === 'all' || filter === 'invalid') rows.push(...a.invalid.map(invalidRow));
  const commits = filter === 'all'
    ? [...a.unknown, ...a.commits.filter((c) => c.category !== 'unknown')]
    : a[filter] ?? [];
  if (filter !== 'invalid') rows.push(...commits.map(commitRow));
  el.list.innerHTML = rows.join('') || '<div class="none">Пусто</div>';
}

function runAnalysis() {
  const text = el.log.value;
  store.set('log', text);
  if (!text.trim()) {
    el.result.hidden = true;
    lastAnalysis = null;
    return;
  }
  lastAnalysis = analyze(text);
  lastAnalysis.byHash = new Map(lastAnalysis.commits.map((c) => [c.hash, c]));
  // Everything involved in a revert chain: reverts themselves and what they undo.
  lastAnalysis.reverted = lastAnalysis.commits.filter((c) => c.revertedBy || c.revertsSubject !== undefined);
  renderResultMain(lastAnalysis);
  renderList(lastAnalysis);
  el.result.hidden = false;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---------- wiring ----------

const params = new URLSearchParams(location.search);
el.target.value = params.get('target') ?? store.get('target');
el.source.value = params.get('source') ?? store.get('source');
el.log.value = store.get('log');

el.target.addEventListener('input', renderCommand);
el.source.addEventListener('input', renderCommand);
el.swap.addEventListener('click', () => {
  [el.target.value, el.source.value] = [el.source.value, el.target.value];
  renderCommand();
});
for (const input of [el.target, el.source]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.copyCommand.disabled) copy(el.command.textContent, el.copyCommand, 'Команда скопирована');
  });
}
el.copyCommand.addEventListener('click', () => copy(el.command.textContent, el.copyCommand, 'Команда скопирована'));

el.log.addEventListener('input', runAnalysis);
el.clear.addEventListener('click', () => { el.log.value = ''; runAnalysis(); el.log.focus(); });
el.paste.addEventListener('click', async () => {
  try {
    el.log.value = await navigator.clipboard.readText();
    runAnalysis();
  } catch {
    el.log.focus();
    toast('Нет доступа к буферу — вставь через ⌘V');
  }
});

el.notices.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn || !lastAnalysis) return;
  filter = btn.dataset.filter;
  renderList(lastAnalysis);
  el.chips.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
el.chips.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip || !lastAnalysis) return;
  filter = chip.dataset.filter;
  renderList(lastAnalysis);
});
el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) copy(btn.dataset.copy, null, 'Хэш скопирован');
  const link = e.target.closest('[data-jump]');
  if (link) jumpTo(link.dataset.jump);
});

function jumpTo(hash) {
  const find = () => el.list.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  if (!find()) {
    filter = 'all';
    renderList(lastAnalysis);
  }
  const row = find();
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart animation
  row.classList.add('flash');
}

renderCommand();
runAnalysis();
(branch(el.target) ? (branch(el.source) ? el.log : el.source) : el.target).focus();
