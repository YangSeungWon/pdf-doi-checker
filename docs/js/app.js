import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { extractText } from './pdftext.js';
import { sliceReferences, splitEntries, extractDoi } from './refs.js';
import { fetchDoi, crossrefSearch, pool, clearCache } from './meta.js';
import { compare, scoreCandidate, cslTitle, cslAuthors, cslYear, cslContainer } from './compare.js';
import { clean, shorten, wordSpans } from './text.js';
import { t, getLang, setLang, LANGS } from './i18n.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// 애초에 DOI 가 없을 웹페이지 인용은 검색을 건너뛴다
const WEBISH_RE =
  /\bretrieved\b[\s\S]{0,40}\bfrom\b\s*https?:\/\/|^\s*https?:\/\/|\baccessed\b[\s\S]{0,20}\d{4}/i;

const ICON = {
  error: '✕', warn: '!', match: '✓',
  found: '✓', likely: '?', none: '—', web: '🔗', fail: '⚠',
};
const LANG_NAME = { en: 'EN', ko: '한국어' };

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let report = null;
let busy = false;
let picked = null;

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

function applyStatic() {
  document.title = t().title;
  for (const n of document.querySelectorAll('[data-i18n]')) {
    const v = t()[n.dataset.i18n];
    if (typeof v === 'string') n.textContent = v;
  }
  for (const n of document.querySelectorAll('[data-i18n-title]')) {
    n.title = t()[n.dataset.i18nTitle] || '';
  }
  const box = $('#lang');
  box.innerHTML = '';
  for (const l of LANGS) {
    const b = el('button', null, LANG_NAME[l] || l);
    b.setAttribute('aria-pressed', String(l === getLang()));
    b.onclick = () => { setLang(l); applyStatic(); if (report) render(); };
    box.append(b);
  }
  if (!busy) setStatus('', null);
}

// ---------------------------------------------------------------------------
// 분석
// ---------------------------------------------------------------------------

function setStatus(msg, pct) {
  $('#status').textContent = msg;
  $('#progress').hidden = pct === null || pct === undefined;
  if (typeof pct === 'number') $('#bar').style.width = `${Math.round(pct * 100)}%`;
}

async function analyze(file) {
  if (busy) return;
  busy = true;
  filter = null;
  $('#run').disabled = true;
  $('#results').innerHTML = '';
  $('#summary').hidden = true;
  $('#exports').hidden = true;

  try {
    const opts = { findMissing: true, mailto: '', workers: 6 };

    setStatus(`${t().reading} ${file.name}`, 0);
    const buf = await file.arrayBuffer();
    const doc = await extractText(pdfjsLib, buf, (p, n) =>
      setStatus(`${t().extracting} ${p}/${n} ${t().page}`, (p / n) * 0.25));

    const refsText = sliceReferences(doc.text);
    const entries = splitEntries(refsText);
    if (!entries.length) {
      report = { file: file.name, doc, entries: [], checked: [], withoutDoi: [], refsText };
      setStatus(t().noRefs, null);
      renderDebug();
      return;
    }

    const withDoi = [], withoutDoi = [];
    for (const e of entries) {
      const doi = extractDoi(e.entry);
      (doi ? withDoi : withoutDoi).push({ ...e, doi: doi || null });
    }

    const p1 = opts.findMissing ? 0.35 : 0.75;
    setStatus(`${t().querying} 0/${withDoi.length}`, 0.25);
    const checked = await pool(withDoi, opts.workers, async item => {
      const res = await fetchDoi(item.doi, 'csl');
      if (!res.ok) {
        return { ...item, status: res.status, csl: null, issues: [{
          field: 'doi', severity: 'error', pdf: item.doi,
          doi: `HTTP ${res.status || '—'}`,
          note: { code: res.status === 404 ? 'doi404' : 'doiFail' },
        }] };
      }
      let csl;
      try { csl = JSON.parse(res.body); }
      catch {
        return { ...item, status: 200, csl: null, issues: [{
          field: 'doi', severity: 'error', pdf: item.doi, doi: '—', note: { code: 'doiParse' },
        }] };
      }
      return {
        ...item, status: 200,
        csl: {
          title: cslTitle(csl), authors: cslAuthors(csl), year: cslYear(csl),
          container: cslContainer(csl), volume: clean(csl.volume || ''),
          issue: clean(csl.issue || ''), pages: clean(csl.page || ''), type: csl.type || '',
        },
        issues: compare(item.entry, csl),
      };
    }, (d, n) => setStatus(`${t().querying} ${d}/${n}`, 0.25 + (d / n) * p1));

    let missing = withoutDoi.map(x => ({ ...x, found: null, skipped: null }));
    if (opts.findMissing) {
      // 해석되지 않는 DOI 도 올바른 DOI 후보를 찾아준다
      const broken = checked.filter(r => r.status !== 200);
      const targets = [...withoutDoi, ...broken];
      if (targets.length) {
        setStatus(`${t().searching} 0/${targets.length}`, 0.6);
        // 검색은 요청 수가 많아 동시 실행을 더 낮춘다 (429 방지)
        const searched = await pool(targets, Math.min(opts.workers, 4),
          item => searchOne(item, opts.mailto),
          (d, n) => setStatus(`${t().searching} ${d}/${n}`, 0.6 + (d / n) * 0.4));
        missing = searched.slice(0, withoutDoi.length);
        searched.slice(withoutDoi.length).forEach((r, i) => { broken[i].found = r.found; });
      }
    }

    report = { file: file.name, doc, entries, checked, withoutDoi: missing, refsText };
    setStatus('', null);
    showFilebar(file.name);
    render();
    renderDebug();
  } catch (err) {
    console.error(err);
    setStatus(`${t().error}: ${err.message}`, null);
  } finally {
    busy = false;
    $('#run').disabled = false;
  }
}

/** 참고문헌 원문으로 Crossref 에서 올바른 문헌을 찾아본다 */
async function searchOne(item, mailto) {
  if (WEBISH_RE.test(item.entry)) return { ...item, found: null, skipped: 'web' };
  const search = await crossrefSearch(item.entry, { rows: 3, mailto });
  if (!search.ok) return { ...item, found: null, skipped: 'error' };
  let best = null;
  for (const cand of search.items) {
    const score = scoreCandidate(item.entry, cand);
    if (score.level === 'none') continue;
    if (!best || score.titleRatio > best.score.titleRatio) {
      best = {
        doi: cand.DOI || '', title: cslTitle(cand), authors: cslAuthors(cand),
        year: cslYear(cand), container: cslContainer(cand), score,
      };
    }
    if (score.level === 'high') break;
  }
  return { ...item, found: best, skipped: null };
}

// ---------------------------------------------------------------------------
// 표시
// ---------------------------------------------------------------------------

let filter = null;                 // 선택된 칩 (null 이면 기본 화면)

/** 항목을 카테고리 하나로 분류한다 */
function bucketOf(r, kind) {
  if (kind === 'doi') {
    if (r.issues.some(i => i.severity === 'error')) return 'error';
    return r.issues.length ? 'warn' : 'match';
  }
  if (r.skipped === 'web') return 'web';
  if (r.skipped === 'error') return 'fail';
  if (!r.found) return 'none';
  return r.found.score.level === 'high' ? 'found' : 'likely';
}

const DOI_KEYS = ['error', 'warn', 'match'];
const NODOI_KEYS = ['found', 'likely', 'none', 'web', 'fail'];

function counted(list, kind, keys) {
  const c = Object.fromEntries(keys.map(k => [k, 0]));
  for (const r of list) c[bucketOf(r, kind)]++;
  return c;
}

// ---------------------------------------------------------------------------
// 요약 — 69 = 56 + 13 이라는 갈래가 보여야 한다
// ---------------------------------------------------------------------------

function group(count, label, sub, keys, counts) {
  const g = el('section', 'group');
  const h = el('div', 'group-h');
  h.append(el('b', 'g-n', String(count)), el('span', 'g-l', label), el('span', 'g-s', sub));
  g.append(h);

  const live = keys.filter(k => counts[k]);     // 0 인 갈래는 아예 내보이지 않는다
  const bar = el('div', 'bar');
  for (const k of live) {
    const seg = el('span', `seg ${k}`, String(counts[k]));
    seg.style.flexGrow = String(counts[k]);
    seg.title = `${t().k[k]} — ${t().tip[k]}`;
    seg.onclick = () => setFilter(filter === k ? null : k);
    bar.append(seg);
  }
  if (live.length) g.append(bar);

  const legend = el('div', 'legend');
  for (const k of live) {
    const chip = el('button', `chip ${k}${filter === k ? ' on' : ''}`);
    chip.title = t().tip[k];
    chip.append(el('span', 'chip-i', ICON[k] ?? '·'), el('span', null, t().k[k]),
      el('b', null, String(counts[k])));
    chip.firstChild.setAttribute('aria-hidden', 'true');
    chip.onclick = () => setFilter(filter === k ? null : k);
    legend.append(chip);
  }
  g.append(legend);
  return g;
}

function setFilter(k) {
  filter = k;
  render();
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** "3개 항목이 DOI 기록과 다릅니다." 같은 한 줄 요약 */
function headline(cDoi, cNo, total) {
  const T = t();
  const p = el('p', 'headline');
  const parts = [
    { n: cDoi.error + cDoi.warn, cls: cDoi.error ? 'error' : 'warn', text: T.hl.problem },
    { n: cNo.likely + cNo.none + cNo.fail, cls: 'none', text: T.hl.unverified },
    { n: cNo.found, cls: 'found', text: T.hl.found },
  ].filter(x => x.n);

  if (!parts.length) {
    p.append(el('span', 'hl-ok', `${ICON.match} ${T.hlAllOk(total)}`));
    return p;
  }
  parts.forEach((x, i) => {
    if (i) p.append(document.createTextNode(' '));
    p.append(el('b', `hl-n ${x.cls}`, String(x.n)));
    p.append(document.createTextNode(T.hlSpace + x.text));
  });
  return p;
}

function heading(text, n, sub) {
  const h = el('h2');
  h.append(el('span', 'h-t', text), el('span', 'h-n', String(n)), el('span', 'h-s', sub));
  return h;
}

const sorted = list => [...list].sort((a, b) => (+a.label || 0) - (+b.label || 0));

/** 검사 대상 전부를 참고문헌 번호 순서로 (문제 있는 것도, 없는 것도) */
function allRefs() {
  const rows = [
    ...report.checked.map(r => ({ r, src: 'doi', kind: bucketOf(r, 'doi') })),
    ...report.withoutDoi.map(r => ({ r, src: 'nodoi', kind: bucketOf(r, 'nodoi') })),
  ];
  return rows.sort((a, b) => (+a.r.label || 0) - (+b.r.label || 0));
}

function render() {
  const { checked, withoutDoi, entries } = report;
  const T = t();
  const cDoi = counted(checked, 'doi', DOI_KEYS);
  const cNo = counted(withoutDoi, 'nodoi', NODOI_KEYS);

  const sum = $('#summary');
  sum.innerHTML = '';
  sum.hidden = false;
  const total = el('div', 'sum-total');
  total.append(el('b', null, String(entries.length)), el('span', null, T.tRefs));
  sum.append(total, group(checked.length, T.gDoi, T.gDoiSub, DOI_KEYS, cDoi));
  if (withoutDoi.length) sum.append(group(withoutDoi.length, T.gNoDoi, T.gNoDoiSub, NODOI_KEYS, cNo));

  const out = $('#results');
  out.innerHTML = '';
  out.append(headline(cDoi, cNo, entries.length));

  let rows = allRefs();
  if (filter) {
    rows = rows.filter(x => x.kind === filter);
    const clear = el('button', 'ghost clear');
    clear.append(el('span', null, '✕'), el('span', null, T.clearFilter));
    clear.onclick = () => setFilter(null);
    const head = el('div', 'filter-h');
    head.append(heading(T.k[filter], rows.length, T.tip[filter]), clear);
    out.append(head);
  }

  const list = el('div', 'reflist');
  for (const x of rows) list.append(refItem(x));
  out.append(list);
  $('#exports').hidden = false;
}

// ---------------------------------------------------------------------------
// 목록 — 참고문헌 번호를 거터에 두고, 비교는 좌우 diff 로 보여준다
// ---------------------------------------------------------------------------

const CLEAN = ['match', 'found', 'web'];

/** 참고문헌 한 건. 문제 없는 건 접어둔다. */
function refItem({ r, src, kind }) {
  const T = t();
  const item = el('details', `ref ${kind}`);
  if (!CLEAN.includes(kind) || filter) item.open = true;

  const sum = el('summary');
  const gut = el('span', 'ref-n');
  const st = el('span', `st ${kind}`, ICON[kind] ?? '·');
  st.title = `${T.k[kind]} — ${T.tip[kind]}`;
  gut.append(st, el('b', null, r.label));
  sum.append(gut, el('span', 'ref-sum', shorten(r.entry, 150)));
  item.append(sum);

  const body = el('div', 'ref-b');
  const doi = src === 'doi' ? r.doi : r.found?.doi;
  if (doi) body.append(doiLink(doi));
  body.append(el('p', 'src', r.entry));

  if (src === 'doi') {
    for (const i of r.issues) body.append(fieldBlock(i));
    if (kind === 'match' && r.csl) body.append(recordBlock(r.csl));
    if (r.found) body.append(suggestBlock(r.found));
    else if (r.issues.length && r.csl) body.append(bibButton(r.doi));
  } else if (r.found) {
    body.append(candidateBlock(r.found));
    body.append(bibButton(r.found.doi));
  }
  item.append(body);
  return item;
}

function doiLink(doi) {
  const a = el('a', 'doi', doi);
  a.href = 'https://doi.org/' + doi;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** 문제 없는 항목에서, 대조한 공식 기록을 눈으로 확인할 수 있게 */
function recordBlock(csl) {
  const box = el('div', 'fld');
  box.append(el('div', 'fld-k', t().record));
  const v = el('div', 'fld-v');
  v.append(el('div', 'cand-t', csl.title));
  const byline = csl.authors.slice(0, 4).join(', ') + (csl.authors.length > 4 ? ' +' : '');
  v.append(el('div', 'cand-s', `${byline} · ${csl.container || '—'} · ${csl.year || '—'}`));
  box.append(v);
  return box;
}

function candidateBlock(f) {
  const box = el('div', 'fld');
  box.append(el('div', 'fld-k', t().fCrossref));
  const v = el('div', 'fld-v');
  v.append(el('div', 'cand-t', f.title));
  const byline = f.authors.slice(0, 4).join(', ') + (f.authors.length > 4 ? ' +' : '');
  v.append(el('div', 'cand-s', `${byline} · ${f.container || '—'} · ${f.year || '—'}`),
    scoreRow(f.score));
  box.append(v);
  return box;
}

function side(cls, key, spans, raw) {
  const r = el('div', `side ${cls}`);
  r.append(el('span', 'side-k', key));
  const v = el('span', 'side-t');
  if (!raw) v.append(el('i', 'muted', t().missing));
  else {
    spans.forEach((sp, i) => {
      if (i) v.append(document.createTextNode(' '));
      v.append(sp.x ? el('mark', null, sp.t) : document.createTextNode(sp.t));
    });
  }
  r.append(v);
  return r;
}

/** 필드 하나의 비교. 다른 낱말에만 표시가 붙는다. */
function fieldBlock(i) {
  const T = t();
  const box = el('div', `fld ${i.severity}`);
  box.append(el('div', 'fld-k', T.field[i.field] || i.field));
  const v = el('div', 'fld-v');
  const { left, right } = wordSpans(i.pdf || '', i.doi || '');
  v.append(side('pdf', T.fPdf, left, i.pdf), side('doi', T.fDoi, right, i.doi));
  const note = renderNote(i.note);
  if (note) v.append(el('div', 'note', note));
  box.append(v);
  return box;
}

function renderNote(note) {
  if (!note || note.code === 'diff') return '';       // 낱말 표시가 대신한다
  const N = t().note;
  if (note.code === 'missingAuthors') return N.missingAuthors(note.names, note.extra);
  if (note.code === 'authorCount') return N.authorCount(note.a, note.b);
  return N[note.code] || '';
}

/** 해석되지 않는 DOI 에 대해 Crossref 가 제안하는 올바른 문헌 */
function suggestBlock(f) {
  const wrap = el('div');
  const box = el('div', 'fld suggest');
  box.append(el('div', 'fld-k', t().suggest));
  const v = el('div', 'fld-v');
  v.append(doiLink(f.doi), el('div', 'cand-t', f.title), scoreRow(f.score));
  box.append(v);
  wrap.append(box, bibButton(f.doi));
  return wrap;
}

/** 매칭 근거를 지표 세 개로 나눠 보여준다 */
function scoreRow(sc) {
  const T = t();
  const box = el('div', 'metrics');
  const grade = (v, ok, warn) => (v >= ok ? 'ok' : v >= warn ? 'warn' : 'low');
  box.append(metric(T.field.title, sc.titleRatio.toFixed(3), '', grade(sc.titleRatio, 0.95, 0.85)));
  box.append(metric(T.field.authors, `${Math.round(sc.authorHit * 100)}%`,
    T.note.authorsN(sc.nAuthors), grade(sc.authorHit, 1, 0.5)));
  box.append(metric(T.field.year, T.note.year[sc.year], '',
    sc.year === 'match' ? 'ok' : sc.year === 'mismatch' ? 'low' : 'warn'));
  return box;
}

function metric(label, value, sub, cls) {
  const m = el('span', `metric ${cls}`);
  m.append(el('span', 'm-l', label), el('b', null, value));
  if (sub) m.append(el('small', null, sub));
  return m;
}

function bibButton(doi) {
  const btn = el('button', 'ghost bib-btn');
  btn.append(el('span', null, '{ }'), el('span', null, t().bibtex));
  btn.onclick = async () => {
    btn.disabled = true;
    btn.lastChild.textContent = t().loading;
    const res = await fetchDoi(doi, 'bib');
    btn.replaceWith(bibBlock(res.ok ? res.body.trim() : `${t().fetchFail} (HTTP ${res.status})`));
  };
  return btn;
}

function bibBlock(text) {
  const wrap = el('div', 'bib');
  const copy = el('button', 'ghost');
  copy.append(el('span', null, '⧉'), el('span', null, t().copy));
  copy.onclick = () => {
    navigator.clipboard.writeText(text);
    copy.lastChild.textContent = t().copied;
    setTimeout(() => (copy.lastChild.textContent = t().copy), 1200);
  };
  wrap.append(el('pre', null, text), copy);
  return wrap;
}

function renderDebug() {
  const { doc, entries, refsText } = report;
  const box = $('#debug-body');
  box.innerHTML = '';
  box.append(el('p', 'note',
    `${doc.pages} ${t().page} · ${doc.columns.filter(c => c === 2).length} × 2-col · ` +
    `${entries.length} refs` +
    (doc.removedHeads.length
      ? ` · heads: ${doc.removedHeads.map(h => `"${shorten(h, 50)}"`).join(', ')}` : '')));
  box.append(el('pre', 'dump',
    entries.map(e => `[${e.label}] ${e.entry}`).join('\n\n') || refsText.slice(0, 4000)));
  $('#debug').hidden = false;
}

// ---------------------------------------------------------------------------
// 내려받기
// ---------------------------------------------------------------------------

function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = () => (report?.file || 'refs').replace(/\.pdf$/i, '');

async function exportBibtex() {
  const btn = $('#dl-bib');
  const orig = btn.lastChild.textContent;
  btn.disabled = true;
  const seen = new Set();
  const uniq = [
    ...report.checked.filter(r => r.status === 200).map(r => r.doi),
    ...report.withoutDoi.filter(r => r.found).map(r => r.found.doi),
  ].filter(d => d && !seen.has(d) && seen.add(d));

  const out = [];
  await pool(uniq, 6, async doi => {
    const res = await fetchDoi(doi, 'bib');
    if (res.ok) out.push(res.body.trim());
  }, (d, n) => (btn.lastChild.textContent = `${d}/${n}`));
  download(`${baseName()}.bib`, out.join('\n\n') + '\n', 'text/plain');
  btn.lastChild.textContent = orig;
  btn.disabled = false;
}

// ---------------------------------------------------------------------------
// 배선
// ---------------------------------------------------------------------------

const drop = $('#drop');
const fileInput = $('#file');

function showFilebar(name) {
  $('#fb-name').textContent = name;
  $('#filebar').hidden = false;
  $('#pick').hidden = true;
}

function setFile(f) {
  if (!f || f.type !== 'application/pdf') return setStatus(t().pdfOnly, null);
  picked = f;
  $('#filename').textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  $('#run').disabled = false;
  setStatus('', null);
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => setFile(e.dataTransfer.files[0]));

$('#run').addEventListener('click', () => picked && analyze(picked));
$('#reset').addEventListener('click', () => {
  report = null;
  picked = null;
  filter = null;
  clearCache();
  $('#filebar').hidden = true;
  $('#pick').hidden = false;
  $('#filename').textContent = '';
  $('#run').disabled = true;
  fileInput.value = '';
  for (const id of ['#summary', '#results', '#exports', '#debug']) {
    const n = $(id);
    if (n.tagName === 'SECTION' || n.tagName === 'DIV' || n.tagName === 'DETAILS') n.hidden = true;
  }
  $('#results').innerHTML = '';
  setStatus('', null);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('#dl-bib').addEventListener('click', exportBibtex);
setLang(getLang());
applyStatic();
$('#pdfjs-version').textContent = pdfjsLib.version;
