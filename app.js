import { analyze, buildCommand } from './parser.js';

const $ = (id) => document.getElementById(id);
const el = {
  target: $('target'), source: $('source'), swap: $('swap'),
  cmdBox: $('cmd-box'), command: $('command'), copyCommand: $('copy-command'), cmdHint: $('cmd-hint'),
  log: $('log'), paste: $('paste'), clear: $('clear'),
  result: $('result'), resultMain: $('result-main'), testWarning: $('test-warning'), chips: $('chips'), list: $('list'), toast: $('toast'),
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

function commitRow(c) {
  const pill = c.reapplied
    ? `<span class="pill" title="${esc(c.subject)}">reapply${c.reapplied > 1 ? ` ×${c.reapplied}` : ''}</span>`
    : '';
  return `<div class="row ${c.category}">
    <span class="badge ${c.category}">${c.category}</span>
    <div class="msg">${highlight(c.message)}${pill}
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

function renderTestWarning(a) {
  if (!a.test.length) {
    el.testWarning.hidden = true;
    return;
  }
  const n = a.test.length;
  el.testWarning.innerHTML = `<span class="warn-icon" aria-hidden="true">!</span>
    <div class="body">Есть тестовые коммиты — <b>${n}</b> ${plural(n, 'коммит', 'коммита', 'коммитов')} <code>[test]</code>. В строку задач не попали.</div>
    <button class="btn ghost" type="button" data-filter="test">Показать</button>`;
  el.testWarning.hidden = false;
}

function renderResultMain(a) {
  renderTestWarning(a);
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

el.testWarning.addEventListener('click', (e) => {
  if (!e.target.closest('[data-filter]') || !lastAnalysis) return;
  filter = 'test';
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
});

renderCommand();
runAnalysis();
(branch(el.target) ? (branch(el.source) ? el.log : el.source) : el.target).focus();
