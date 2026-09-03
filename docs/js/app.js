import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { extractText } from './pdftext.js';
import { sliceReferences, splitEntries, extractDoi } from './refs.js';
import { fetchDoi, crossrefSearch, pool, clearCache } from './meta.js';
import { compare, scoreCandidate, cslTitle, cslAuthors, cslYear, cslContainer } from './compare.js';
import { clean, shorten } from './text.js';
import { t, getLang, setLang, LANGS } from './i18n.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// 애초에 DOI 가 없을 웹페이지 인용은 검색을 건너뛴다
const WEBISH_RE =
  /\bretrieved\b[\s\S]{0,40}\bfrom\b\s*https?:\/\/|^\s*https?:\/\/|\baccessed\b[\s\S]{0,20}\d{4}/i;

const ICON = { error: '✕', warn: '!', ok: '✓', sure: '✓', likely: '?' };
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
  const box = $('#lang');
  box.innerHTML = '';
  for (const l of LANGS) {
    const b = el('button', null, LANG_NAME[l] || l);
    b.setAttribute('aria-pressed', String(l === getLang()));
    b.onclick = () => { setLang(l); applyStatic(); if (report) render(); };
    box.append(b);
  }
  if (busy) return;
  setStatus(report ? t().done : picked ? t().ready : t().idle, null);
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
  $('#run').disabled = true;
  $('#results').innerHTML = '';
  $('#summary').hidden = true;
  $('#exports').hidden = true;

  try {
    const opts = {
      findMissing: $('#opt-find-missing').checked,
      mailto: $('#opt-mailto').value.trim(),
      workers: Math.max(1, Math.min(12, +$('#opt-workers').value || 6)),
    };

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
    if (opts.findMissing && withoutDoi.length) {
      setStatus(`${t().searching} 0/${withoutDoi.length}`, 0.6);
      // 검색은 요청 수가 많아 동시 실행을 더 낮춘다 (429 방지)
      missing = await pool(withoutDoi, Math.min(opts.workers, 4), async item => {
        if (WEBISH_RE.test(item.entry)) return { ...item, found: null, skipped: 'web' };
        const search = await crossrefSearch(item.entry, { rows: 3, mailto: opts.mailto });
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
      }, (d, n) => setStatus(`${t().searching} ${d}/${n}`, 0.6 + (d / n) * 0.4));
    }

    report = { file: file.name, doc, entries, checked, withoutDoi: missing, refsText };
    setStatus(t().done, null);
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

// ---------------------------------------------------------------------------
// 표시
// ---------------------------------------------------------------------------

function tile(label, value, cls) {
  const n = el('div', 'tile' + (cls ? ' ' + cls : ''));
  n.append(el('div', 'tile-v', String(value)), el('div', 'tile-l', label));
  return n;
}

function badge(kind, text) {
  const b = el('span', 'badge');
  b.append(el('span', null, ICON[kind]), el('span', null, text));
  b.firstChild.setAttribute('aria-hidden', 'true');
  return b;
}

function renderNote(note) {
  if (!note) return '';
  const N = t().note;
  switch (note.code) {
    case 'diff':
      return note.ops.map(o =>
        o.tag === 'replace' ? `"${o.left}" → "${o.right}"`
          : o.tag === 'delete' ? `${t().diff.only}: "${o.left}"`
            : `${t().diff.doiOnly}: "${o.right}"`).join('; ');
    case 'missingAuthors': return N.missingAuthors(note.names, note.extra);
    case 'authorCount': return N.authorCount(note.a, note.b);
    default: return N[note.code] || '';
  }
}

function render() {
  const { checked, withoutDoi, entries } = report;
  const T = t();
  const errorsOnly = $('#opt-errors-only').checked;
  const findMissing = $('#opt-find-missing').checked;

  const bad = checked.filter(r => r.issues.length);
  const errs = checked.filter(r => r.issues.some(i => i.severity === 'error'));
  const hi = withoutDoi.filter(r => r.found?.score.level === 'high');
  const mid = withoutDoi.filter(r => r.found?.score.level === 'medium');
  const web = withoutDoi.filter(r => r.skipped === 'web');
  const failed = withoutDoi.filter(r => r.skipped === 'error');

  const sum = $('#summary');
  sum.innerHTML = '';
  sum.hidden = false;
  sum.append(
    tile(T.tRefs, entries.length),
    tile(T.tChecked, checked.length),
    tile(T.tErrors, errs.length, 'err'),
    tile(T.tWarns, bad.length - errs.length, 'warn'),
    tile(T.tOk, checked.length - bad.length, 'ok'),
  );
  if (findMissing) {
    sum.append(
      tile(T.tFound, hi.length, 'ok'),
      tile(T.tLikely, mid.length, 'warn'),
      tile(T.tNotFound, withoutDoi.length - hi.length - mid.length - web.length - failed.length),
    );
    if (failed.length) sum.append(tile(T.tFailed, failed.length, 'err'));
  }

  const out = $('#results');
  out.innerHTML = '';

  const shown = checked
    .filter(r => (errorsOnly ? r.issues.some(i => i.severity === 'error') : r.issues.length)
      || $('#opt-show-ok').checked)
    .sort((a, b) => (+a.label || 0) - (+b.label || 0));

  if (shown.length) {
    out.append(el('h2', null, `${T.hMismatch} (${shown.length})`));
    for (const r of shown) out.append(resultCard(r, errorsOnly));
  } else if (checked.length) {
    out.append(el('p', 'empty', `${ICON.ok} ${T.allOk}`));
  }

  if (failed.length) {
    out.append(el('p', 'empty', T.searchFailed(failed.length)));
  }

  if (findMissing && (hi.length || mid.length)) {
    out.append(el('h2', null, `${T.hFound} (${hi.length + mid.length})`));
    for (const r of [...hi, ...mid].sort((a, b) => (+a.label || 0) - (+b.label || 0))) {
      out.append(foundCard(r));
    }
  }
  $('#exports').hidden = false;
}

function cardHead(kind, badgeText, label, doi) {
  const head = el('header', 'card-h');
  head.append(badge(kind, badgeText), el('span', 'label', `[${label}]`));
  const a = el('a', 'doi', doi);
  a.href = 'https://doi.org/' + doi;
  a.target = '_blank';
  a.rel = 'noopener';
  head.append(a);
  return head;
}

function bibButton(doi) {
  const btn = el('button', 'ghost');
  btn.append(el('span', null, '{ }'), el('span', null, t().bibtex));
  btn.onclick = async () => {
    btn.disabled = true;
    btn.lastChild.textContent = t().loading;
    const res = await fetchDoi(doi, 'bib');
    btn.replaceWith(bibBlock(res.ok ? res.body.trim() : `${t().fetchFail} (HTTP ${res.status})`));
  };
  return btn;
}

function resultCard(r, errorsOnly) {
  const T = t();
  const issues = errorsOnly ? r.issues.filter(i => i.severity === 'error') : r.issues;
  const kind = issues.some(i => i.severity === 'error') ? 'error' : issues.length ? 'warn' : 'ok';
  const card = el('article', `card ${kind}`);
  card.append(cardHead(kind, kind === 'error' ? T.badgeError : kind === 'warn' ? T.badgeWarn : T.badgeOk,
    r.label, r.doi));
  card.append(el('p', 'entry', r.entry));

  for (const i of issues) {
    const row = el('div', `issue ${i.severity}`);
    const f = el('div', 'issue-f');
    f.append(el('span', null, ICON[i.severity]), el('span', null, T.field[i.field] || i.field));
    f.firstChild.setAttribute('aria-hidden', 'true');
    row.append(f);
    const body = el('div', 'issue-b');
    body.append(kv(T.fPdf, i.pdf || T.missing), kv(T.fDoi, i.doi));
    const note = renderNote(i.note);
    if (note) body.append(el('div', 'note', note));
    row.append(body);
    card.append(row);
  }
  if (issues.length && r.csl) card.append(bibButton(r.doi));
  return card;
}

function foundCard(r) {
  const T = t();
  const f = r.found;
  const high = f.score.level === 'high';
  const card = el('article', `card ${high ? 'ok' : 'warn'}`);
  card.append(cardHead(high ? 'sure' : 'likely', high ? T.badgeSure : T.badgeLikely, r.label, f.doi));
  card.append(el('p', 'entry', r.entry));

  const body = el('div', 'issue-b');
  const byline = f.authors.slice(0, 4).join(', ') + (f.authors.length > 4 ? ' +' : '');
  body.append(kv(T.fCrossref, f.title));
  body.append(kv('', `${byline} · ${f.container || '—'} · ${f.year || '—'}`));
  body.append(el('div', 'note', T.note.score(
    f.score.titleRatio, Math.round(f.score.authorHit * 100), f.score.nAuthors,
    T.note.year[f.score.year])));
  card.append(body, bibButton(f.doi));
  return card;
}

function kv(k, v) {
  const n = el('div', 'kv');
  n.append(el('span', 'k', k), el('span', 'v', v));
  return n;
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

function exportJson() {
  download(`${baseName()}.doi-check.json`, JSON.stringify({
    file: report.file,
    pages: report.doc.pages,
    totalReferences: report.entries.length,
    checked: report.checked.map(({ label, doi, entry, status, csl, issues }) =>
      ({ label, doi, entry, status, csl, issues })),
    withoutDoi: report.withoutDoi.map(({ label, entry, found, skipped }) =>
      ({ label, entry, found, skipped })),
  }, null, 2));
}

// ---------------------------------------------------------------------------
// 배선
// ---------------------------------------------------------------------------

const drop = $('#drop');
const fileInput = $('#file');

function setFile(f) {
  if (!f || f.type !== 'application/pdf') return setStatus(t().pdfOnly, null);
  picked = f;
  $('#filename').textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  $('#run').disabled = false;
  setStatus(t().ready, null);
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
$('#opt-errors-only').addEventListener('change', () => report?.entries.length && render());
$('#opt-show-ok').addEventListener('change', () => report?.entries.length && render());
$('#dl-json').addEventListener('click', exportJson);
$('#dl-bib').addEventListener('click', exportBibtex);
$('#clear-cache').addEventListener('click', e => {
  clearCache();
  const span = e.currentTarget.lastChild;
  const orig = span.textContent;
  span.textContent = '✓';
  setTimeout(() => (span.textContent = orig), 1200);
});

setLang(getLang());
applyStatic();
$('#pdfjs-version').textContent = pdfjsLib.version;
