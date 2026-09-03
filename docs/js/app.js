import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { extractText } from './pdftext.js';
import { sliceReferences, splitEntries, extractDoi } from './refs.js';
import {
  fetchDoi, crossrefSearch, openAlexSearch, crossrefUpdates, checkRepo, checkWeb,
  pool, clearCache,
} from './meta.js';
import {
  compare, scoreCandidate, cslTitle, cslAuthors, cslYear, cslContainer,
  refTitleGuess, openAlexToCsl, statusIssue,
} from './compare.js';
import { clean, shorten, wordSpans } from './text.js';
import { t, getLang, setLang, LANGS } from './i18n.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// 애초에 DOI 가 없을 웹페이지 인용은 검색을 건너뛴다
const WEBISH_RE =
  /\bretrieved\b[\s\S]{0,40}\bfrom\b\s*https?:\/\/|^\s*https?:\/\/|\baccessed\b[\s\S]{0,20}\d{4}/i;

// 소프트웨어·모델 저장소. DOI 가 없는 것이 정상이라 못 찾았다고 할 일이 아니다.
// (Zenodo·figshare 는 DOI 를 발급하므로 제외)
const REPO_RE = new RegExp(
  '(?:^|//|\\.)(?:github\\.com|gitlab\\.com|bitbucket\\.org|gitee\\.com|codeberg\\.org'
  + '|huggingface\\.co|modelscope\\.cn|ollama\\.com|kaggle\\.com'
  + '|pypi\\.org|npmjs\\.com|crates\\.io|rubygems\\.org|sourceforge\\.net)/',
  'i');

const ICON = {
  error: '✕', warn: '!', match: '✓',
  found: '✓', likely: '?', none: '—', repo: '⌘', dead: '✕', web: '🔗', fail: '⚠',
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
  if (!busy) setStatus('');
}

// ---------------------------------------------------------------------------
// 분석
// ---------------------------------------------------------------------------

function setStatus(msg) {
  $('#status').textContent = msg;
}

/**
 * 진행 표시. 몇 개 중 몇 개인지가 주(主)이고, 지금 무슨 단계인지가 부(副).
 * @param {number} done 처리된 개수
 * @param {number} total 전체 개수
 * @param {string} unit 단위 (쪽 / 참고문헌)
 * @param {string} stage 현재 단계 설명
 */
function setProgress(done, total, unit, stage) {
  $('#progress').hidden = false;
  $('#pg-n').textContent = String(done);
  $('#pg-t').textContent = String(total);
  $('#pg-u').textContent = unit;
  $('#pg-sub').textContent = stage;
  $('#bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

function hideProgress() {
  $('#progress').hidden = true;
}

async function analyze(file) {
  if (busy) return;
  busy = true;
  filter = null;
  $('#run').disabled = true;
  $('#results').innerHTML = '';
  $('#summary').hidden = true;
  $('#restart').hidden = true;

  try {
    const opts = { findMissing: true, mailto: '', workers: 6 };

    setProgress(0, 1, '', `${t().reading} ${file.name}`);
    const buf = await file.arrayBuffer();
    const doc = await extractText(pdfjsLib, buf, (p, n) =>
      setProgress(p, n, t().page, t().extracting));

    const refsText = sliceReferences(doc.text);
    const entries = splitEntries(refsText);
    if (!entries.length) {
      report = { file: file.name, doc, entries: [], checked: [], withoutDoi: [], refsText };
      hideProgress();
      setStatus(t().noRefs);
      renderDebug();
      return;
    }

    const withDoi = [], withoutDoi = [];
    for (const e of entries) {
      const doi = extractDoi(e.entry);
      (doi ? withDoi : withoutDoi).push({ ...e, doi: doi || null });
    }

    const total = entries.length;
    setProgress(0, total, t().tRefs, `${t().querying} 0/${withDoi.length}`);
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
    }, (d, n) => setProgress(d, total, t().tRefs, `${t().querying} ${d}/${n}`));

    // 철회·정정된 문헌을 인용하고 있지는 않은지 (Retraction Watch)
    const resolved = checked.filter(r => r.status === 200).map(r => r.doi);
    if (resolved.length) {
      setProgress(withDoi.length, entries.length, t().tRefs, t().checkingStatus);
      const updates = await crossrefUpdates(resolved, { mailto: opts.mailto });
      for (const r of checked) {
        const issue = statusIssue(updates.get(String(r.doi).toLowerCase()));
        if (issue) r.issues = [issue, ...r.issues];
      }
    }

    let missing = withoutDoi.map(x => ({ ...x, found: null, skipped: null }));
    if (opts.findMissing) {
      // 해석되지 않는 DOI 도 올바른 DOI 후보를 찾아준다
      const broken = checked.filter(r => r.status !== 200);
      const targets = [...withoutDoi, ...broken];
      if (targets.length) {
        setProgress(withDoi.length, total, t().tRefs, `${t().searching} 0/${targets.length}`);
        // 검색은 요청 수가 많아 동시 실행을 더 낮춘다 (429 방지)
        const searched = await pool(targets, Math.min(opts.workers, 4),
          item => searchOne(item, opts.mailto),
          (d, n) => setProgress(Math.min(total, withDoi.length + d), total, t().tRefs,
            `${t().searching} ${d}/${n}`));
        missing = searched.slice(0, withoutDoi.length);
        searched.slice(withoutDoi.length).forEach((r, i) => { broken[i].found = r.found; });
      }
    }

    report = { file: file.name, doc, entries, checked, withoutDoi: missing, refsText };
    hideProgress();
    setStatus('');
    showFilebar(file.name);
    render();
    renderDebug();
  } catch (err) {
    console.error(err);
    hideProgress();
    setStatus(`${t().error}: ${err.message}`);
  } finally {
    busy = false;
    $('#run').disabled = false;
  }
}

// arXiv 는 모든 프리프린트에 DataCite DOI 를 붙인다: 10.48550/arXiv.<id>
const ARXIV_RE = /arxiv[.:\s/]*(?:abs\/)?((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?/i;

function candFrom(csl, doi, source) {
  return {
    doi, source, title: cslTitle(csl), authors: cslAuthors(csl),
    year: cslYear(csl), container: cslContainer(csl),
    score: null,
  };
}

/** 후보 목록에서 가장 그럴듯한 하나를 고른다 */
function pickBest(entry, cands, source) {
  let best = null;
  for (const csl of cands) {
    if (!csl.DOI) continue;
    const score = scoreCandidate(entry, csl);
    if (score.level === 'none') continue;
    if (!best || score.titleRatio > best.score.titleRatio) {
      best = { ...candFrom(csl, csl.DOI, source), score };
    }
    if (score.level === 'high') break;
  }
  return best;
}

/** 참고문헌 원문으로 올바른 문헌을 찾아본다 */
async function searchOne(item, mailto) {
  if (REPO_RE.test(item.entry)) {
    // 저장소는 DOI 를 찾을 게 아니라 아직 있는지를 확인해야 한다
    const repo = await checkRepo(item.entry);
    return {
      ...item, found: null,
      skipped: repo.state === 'dead' ? 'dead' : 'repo',
      repo,
    };
  }
  if (WEBISH_RE.test(item.entry)) {
    return { ...item, found: null, skipped: 'web', web: await checkWeb(item.entry) };
  }
  const search = await crossrefSearch(item.entry, { rows: 3, mailto });
  if (!search.ok) return { ...item, found: null, skipped: 'error' };
  let best = pickBest(item.entry, search.items, 'crossref');

  // Crossref 에 정식 출판본이 없으면 arXiv DOI 를 직접 만들어 확인한다.
  // (출판본이 있으면 그쪽이 낫기 때문에 검색을 먼저 한다)
  if (!best) {
    const m = ARXIV_RE.exec(item.entry);
    if (m) {
      const doi = '10.48550/arXiv.' + m[1];
      const res = await fetchDoi(doi, 'csl');
      if (res.ok) {
        try {
          const csl = JSON.parse(res.body);
          const sc = scoreCandidate(item.entry, csl);
          // ID 가 참고문헌에 직접 적혀 있으므로, 제목이나 저자 중 하나만
          // 맞아도 같은 글로 본다. 저자가 맞는데 제목이 다르면 개정판에서
          // 제목을 바꾼 경우다 (arXiv 에서 드물지 않다). 그런 건 버리지 말고
          // '추정' 으로 올려서, 인용한 제목이 낡았다는 걸 알려줘야 한다.
          const titleOk = sc.titleRatio >= 0.85;
          const authorsOk = sc.authorHit !== null && sc.authorHit >= 0.5;
          if (titleOk || authorsOk) {
            const strong = sc.titleRatio >= 0.95 && (sc.authorHit === null || authorsOk);
            best = {
              ...candFrom(csl, doi, 'arxiv'),
              score: { ...sc, level: strong ? 'high' : 'medium' },
              note: !titleOk && authorsOk ? { code: 'retitled' } : null,
            };
          }
        } catch { /* 무시 */ }
      }
    }
  }

  // 그래도 없으면 OpenAlex. Crossref 가 놓치는 학술서 챕터·일부 저널을 덮는다.
  //
  // 단, OpenAlex 는 doi.org 에 등록되지 않은 DOI 도 들고 있다 (출판사 사이트에는
  // 그 경로로 글이 있지만 DOI 등록은 안 된 경우). 풀리지 않는 DOI 를 "넣으세요"
  // 라고 내미는 건 못 찾았다고 하는 것보다 나쁘므로, 해석되는 것만 채택한다.
  if (!best) {
    const oa = await openAlexSearch(refTitleGuess(item.entry), { rows: 3, mailto });
    const cand = oa.ok ? pickBest(item.entry, oa.items.map(openAlexToCsl), 'openalex') : null;
    if (cand) {
      const res = await fetchDoi(cand.doi, 'csl');
      if (res.ok) {
        try {
          const csl = JSON.parse(res.body);        // 공식 기록으로 다시 채점
          const sc = scoreCandidate(item.entry, csl);
          if (sc.level !== 'none') best = { ...candFrom(csl, cand.doi, 'openalex'), score: sc };
        } catch { /* 무시 */ }
      }
    }
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
  if (r.skipped === 'dead') return 'dead';
  if (r.skipped === 'repo') return 'repo';
  if (r.skipped === 'web') return 'web';
  if (r.skipped === 'error') return 'fail';
  if (!r.found) return 'none';
  return r.found.score.level === 'high' ? 'found' : 'likely';
}

const DOI_KEYS = ['error', 'warn', 'match'];
const NODOI_KEYS = ['found', 'likely', 'none', 'dead', 'repo', 'web', 'fail'];

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
    out.append(filterBar(filter, rows.length, entries.length));
  }

  const list = el('div', `reflist${filter ? ' filtered' : ''}`);
  appendRows(list, rows, !filter);
  out.append(list);
  if (filter) out.append(clearButton('bottom'));
  $('#restart').hidden = false;
}

function clearButton(where) {
  const b = el('button', `clear ${where}`);
  b.append(el('span', null, '✕'), el('span', null, t().clearFilter));
  b.onclick = () => setFilter(null);
  return b;
}

/** 지금 무엇만 보고 있는지, 전체 중 몇 건인지 */
function filterBar(kind, shown, total) {
  const T = t();
  const bar = el('div', `filterbar ${kind}`);
  const what = el('span', 'fb-what');
  what.append(el('span', 'dot', ICON[kind] ?? '·'), el('span', null, T.k[kind] + T.filtering));
  bar.append(what, el('span', 'fb-count', T.filterCount(shown, total)), clearButton('top'));
  return bar;
}

/**
 * 손볼 것 없는 구간은 diff 처럼 한 줄로 접어 둔다.
 * 띠를 누르면 그 자리에 원래 행들이 펼쳐진다.
 */
function appendRows(list, rows, band) {
  let i = 0;
  while (i < rows.length) {
    if (band && CLEAN.includes(rows[i].kind)) {
      let j = i;
      while (j < rows.length && CLEAN.includes(rows[j].kind)) j++;
      const run = rows.slice(i, j);
      if (run.length >= 2) {
        list.append(gapBand(run));
        i = j;
        continue;
      }
    }
    list.append(refItem(rows[i]));
    i++;
  }
}

function gapBand(run) {
  const b = el('button', 'gap');
  const from = run[0].r.label;
  const to = run[run.length - 1].r.label;
  const add = run.filter(x => x.kind === 'found').length;
  b.append(el('span', 'gap-i', '⋯'), el('span', 'gap-r', `[${from}]–[${to}]`),
    el('span', 'gap-l', t().gapOk(run.length)));
  if (add) b.append(el('span', 'gap-add', t().gapAdd(add)));
  b.onclick = () => {
    const frag = document.createDocumentFragment();
    run.forEach(x => frag.append(refItem(x)));
    b.replaceWith(frag);
  };
  return b;
}

// ---------------------------------------------------------------------------
// 목록 — 참고문헌 번호를 거터에 두고, 비교는 좌우 diff 로 보여준다
// ---------------------------------------------------------------------------

// 손볼 것이 없는 것들. 펼치지 않고, 이어지면 중략 띠로 접는다.
// '확인됨' 도 여기 든다 — 틀린 데가 없고 넣을 DOI 가 있을 뿐이라,
// 그 사실은 띠에 개수로만 남기고 자세한 건 칩으로 걸러 본다.
const CLEAN = ['match', 'found', 'repo', 'web'];

/** 참고문헌 한 건. 문제 없는 건 접어둔다. */
function refItem({ r, src, kind }) {
  const T = t();
  const item = el('details', `ref ${kind}`);
  if (!CLEAN.includes(kind) || filter) item.open = true;

  const sum = el('summary');
  const gut = el('span', 'ref-n');
  const st = el('span', `st ${kind}`, ICON[kind] ?? '·');
  st.title = `${T.k[kind]} — ${T.tip[kind]}`;
  gut.append(st, el('b', null, `[${r.label}]`));
  sum.append(gut, el('span', 'ref-sum', shorten(r.entry, 150)));
  item.append(sum);

  const body = el('div', 'ref-b');
  const doi = src === 'doi' ? r.doi : r.found?.doi;
  body.append(el('p', 'src', r.entry));

  if (src === 'doi') {
    for (const i of r.issues) body.append(i.field === 'status' ? statusBlock(i) : fieldBlock(i));
    if (kind === 'match' && r.csl) body.append(recordBlock(r.csl));
    if (r.found) body.append(suggestBlock(r.found));
  } else if (r.found) {
    body.append(candidateBlock(r.found));
  } else if (r.repo && r.repo.state !== 'unknown') {
    body.append(repoBlock(r.repo));
  } else if (r.web) {
    body.append(webBlock(r.web));
  }

  // 어느 항목이든 원문으로 바로 갈 수 있게 한다
  const links = el('div', 'links');
  if (doi) links.append(outLink('https://doi.org/' + doi, `doi.org/${doi}`));
  // arXiv 초록 페이지에는 개정 이력과 철회 표시가 있다. 우리가 메타데이터로는
  // 알 수 없는 정보라, ID 가 적혀 있으면 항상 바로 갈 수 있게 둔다.
  const ax = ARXIV_RE.exec(r.entry);
  if (ax) links.append(outLink(`https://arxiv.org/abs/${ax[1]}`, `arXiv:${ax[1]}`));
  const q = refTitleGuess(r.entry) || clean(r.entry).slice(0, 200);
  links.append(outLink(
    'https://scholar.google.com/scholar?q=' + encodeURIComponent(q), t().scholar));
  body.append(links);

  item.append(body);
  return item;
}

function outLink(href, label) {
  const a = el('a', 'outlink');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.append(el('span', null, '↗'), el('span', null, label));
  a.firstChild.setAttribute('aria-hidden', 'true');
  return a;
}

function doiLink(doi) {
  const a = el('a', 'doi', doi);
  a.href = 'https://doi.org/' + doi;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** 저자 · 게재처 · 연도. 비어 있는 칸은 구분점째로 뺀다. */
function bylineOf(rec) {
  const authors = rec.authors || [];
  const who = authors.slice(0, 4).join(', ') + (authors.length > 4 ? ' +' : '');
  return [who, rec.container, rec.year].filter(Boolean).join(' · ');
}

/** 문제 없는 항목에서, 대조한 공식 기록을 눈으로 확인할 수 있게 */
function recordBlock(csl) {
  const box = el('div', 'fld');
  box.append(el('div', 'fld-k', t().record));
  const v = el('div', 'fld-v');
  v.append(el('div', 'cand-t', csl.title));
  const by = bylineOf(csl);
  if (by) v.append(el('div', 'cand-s', by));
  box.append(v);
  return box;
}

function candidateBlock(f) {
  const box = el('div', 'fld');
  box.append(el('div', 'fld-k', t().src[f.source] || t().fCrossref));
  const v = el('div', 'fld-v');
  v.append(el('div', 'cand-t', f.title));
  const by = bylineOf(f);
  if (by) v.append(el('div', 'cand-s', by));
  v.append(scoreRow(f.score));
  const note = renderNote(f.note);
  if (note) v.append(el('div', 'note', note));
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

/**
 * 웹페이지 인용 확인 결과.
 * 생사는 브라우저에서 판정할 수 없으므로(살아 있는 사이트도 예외를 내는 걸
 * 확인했다) 아카이브 사본만 알려준다.
 */
function webBlock(web) {
  const T = t();
  const box = el('div', 'fld');
  box.append(el('div', 'fld-k', T.k.web));
  const v = el('div', 'fld-v');
  v.append(el('div', 'note', T.note.liveUnknown));
  if (web.archive) {
    const ts = web.archive.timestamp || '';
    const pretty = ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : ts;
    const links = el('div', 'links');
    links.append(outLink(web.archive.url, T.note.snapshot(pretty)));
    v.append(links);
  } else {
    v.append(el('div', 'note', T.note.noSnapshot));
  }
  box.append(v);
  return box;
}

/** 저장소가 아직 있는지 확인한 결과 */
function repoBlock(repo) {
  const T = t();
  const box = el('div', `fld ${repo.state === 'dead' ? 'error' : ''}`);
  box.append(el('div', 'fld-k', T.k[repo.state === 'dead' ? 'dead' : 'repo']));
  const v = el('div', 'fld-v');
  if (repo.state === 'dead') {
    v.append(el('div', 'cand-t', T.note.repoGone));
  } else {
    v.append(el('div', 'cand-t', repo.name || ''));
    if (repo.note === 'archived') v.append(el('div', 'note', T.note.archived));
  }
  box.append(v);
  return box;
}

/** 철회·정정 같은 상태는 좌우 비교가 아니라 한 줄로 알린다 */
function statusBlock(i) {
  const box = el('div', `fld ${i.severity}`);
  box.append(el('div', 'fld-k', t().field.status));
  const v = el('div', 'fld-v');
  v.append(el('div', 'cand-t', renderNote(i.note)));
  if (i.doi) {
    const row = el('div', 'cand-s');
    row.append(el('span', null, `${t().note.notice}: `), doiLink(i.doi));
    v.append(row);
  }
  box.append(v);
  return box;
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
  const box = el('div', 'fld suggest');
  box.append(el('div', 'fld-k', t().suggest));
  const v = el('div', 'fld-v');
  v.append(doiLink(f.doi), el('div', 'cand-t', f.title), scoreRow(f.score));
  box.append(v);
  return box;
}

/** 매칭 근거를 지표 세 개로 나눠 보여준다 */
function scoreRow(sc) {
  const T = t();
  const box = el('div', 'metrics');
  const grade = (v, ok, warn) => (v >= ok ? 'ok' : v >= warn ? 'warn' : 'low');
  box.append(metric(T.field.title, sc.titleRatio.toFixed(3), '', grade(sc.titleRatio, 0.95, 0.85)));
  box.append(sc.authorHit === null
    ? metric(T.field.authors, '—', T.note.noAuthors, '')
    : metric(T.field.authors, `${Math.round(sc.authorHit * 100)}%`,
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
// 배선
// ---------------------------------------------------------------------------

const drop = $('#drop');
const fileInput = $('#file');

function showFilebar(name) {
  $('#fb-name').textContent = name;
  $('#filebar').hidden = false;
  $('#pick').hidden = true;
}

/** 첫 장을 그려서 무엇이 올라왔는지 눈으로 확인시킨다 */
async function showPreview(file) {
  const task = pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (168 / base.width) * dpr });
    const canvas = $('#thumb');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width / dpr}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    $('#pv-pages').textContent = `${doc.numPages} ${t().page}`;
  } catch (e) {
    console.error(e);
  } finally {
    await task.destroy();
  }
}

function showDropState() {
  $('#drop').hidden = false;
  $('#preview').hidden = true;
  $('#run-row').hidden = true;
  $('#filename').textContent = '';
  $('#pv-pages').textContent = '';
}

/**
 * PDF 인지 판정.
 * File.type 은 믿을 수 없다 — OS 에 MIME 매핑이 없거나 드롭 출처에 따라
 * 빈 문자열이나 application/octet-stream 으로 오는 일이 흔하다. 확장자도 본다.
 */
function isPdf(f) {
  return !!f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
}

function setFile(f) {
  if (!isPdf(f)) return setStatus(t().pdfOnly);
  picked = f;
  $('#filename').textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  $('#drop').hidden = true;
  $('#preview').hidden = false;
  $('#run-row').hidden = false;
  setStatus('');
  showPreview(f);
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  fileInput.value = '';          // 같은 파일을 다시 골라도 change 가 뜨도록
  setFile(f);
});

// 드롭은 창 전체에서 받는다. 드롭존을 살짝 빗나갔다고 브라우저가 PDF 를
// 열어버리면 사용자에겐 "아무 일도 안 일어난" 것으로 보인다.
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('dragging');
});
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('dragleave', e => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) setFile(f);
});

$('#run').addEventListener('click', () => picked && analyze(picked));
$('#change').addEventListener('click', () => {
  picked = null;
  fileInput.value = '';
  showDropState();
});
function resetAll() {
  report = null;
  picked = null;
  filter = null;
  clearCache();
  $('#filebar').hidden = true;
  $('#pick').hidden = false;
  showDropState();
  fileInput.value = '';
  for (const id of ['#summary', '#restart', '#debug']) $(id).hidden = true;
  $('#results').innerHTML = '';
  hideProgress();
  setStatus('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#reset').addEventListener('click', resetAll);
$('#reset-bottom').addEventListener('click', resetAll);
setLang(getLang());
applyStatic();
$('#pdfjs-version').textContent = pdfjsLib.version;
