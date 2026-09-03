// 참고문헌 원문 vs doi.org 공식 메타데이터 비교
import { clean, norm, normWords, ratio, wordDiff } from './text.js';

export const SEVERITY = {
  doi: 'error', title: 'error', authors: 'error', year: 'error',
  venue: 'warn', volume: 'warn', issue: 'warn', pages: 'warn',
};

const YEAR_RE = /(?<![0-9])((?:19|20)\d{2})(?![0-9])/;
// "저자들. 2019. 제목. 게재처 ..." (ACM/APA 계열)
const AUTHORS_YEAR_RE = /^([\s\S]{0,600}?)[.,]\s*\[?((?:19|20)\d{2}|n\.\s*d\.)\]?[a-z]?\.\s/;

/** 참고문헌에서 제목으로 보이는 부분 (검색어로 쓴다) */
export function refTitleGuess(entry) {
  const { rest } = splitRef(entry);
  const first = rest.split(/(?<=[.?!])\s+/)[0] || rest;
  return clean(first).replace(/[ .]+$/, '').slice(0, 300);
}

/** OpenAlex 결과를 CSL 모양으로 맞춘다 (아래 헬퍼들을 그대로 쓰기 위해) */
export function openAlexToCsl(w) {
  const author = (w.authorships || []).map(a => {
    const n = clean(a.author?.display_name || '');
    const parts = n.split(/\s+/);
    const family = parts.length > 1 ? parts.pop() : n;
    return { family, given: parts.join(' ') };
  });
  return {
    DOI: String(w.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
    title: w.title || '',
    author,
    issued: { 'date-parts': [[w.publication_year]] },
    'container-title': w.primary_location?.source?.display_name || '',
  };
}

/** @returns {{authorsPart: string, year: string|null, rest: string}} */
export function splitRef(entry) {
  const m = AUTHORS_YEAR_RE.exec(entry);
  if (m) {
    const y = /^(19|20)/.test(m[2]) ? m[2] : null;
    return { authorsPart: m[1], year: y, rest: entry.slice(m[0].length) };
  }
  const y = YEAR_RE.exec(entry);
  return { authorsPart: '', year: y ? y[1] : null, rest: entry };
}

/** 제목 뒤 문장부터 잘라, 공식 제목과 가장 비슷해지는 지점까지를 제목으로 본다 */
export function guessTitle(rest, officialTitle) {
  const parts = rest.split(/(?<=[.?!])\s+/);
  const tgt = norm(officialTitle);
  let best = parts[0] || rest, bestR = 0, acc = '';
  for (const p of parts.slice(0, 6)) {
    acc = (acc + ' ' + p).trim();
    const r = ratio(norm(acc), tgt);
    if (r > bestR) { best = acc; bestR = r; }
  }
  return best.replace(/[ .]+$/, '');
}

// --- CSL / Crossref 아이템에서 필드 뽑기 (두 스키마가 거의 같다) -----------

const first = v => (Array.isArray(v) ? (v[0] || '') : (v || ''));

export function cslTitle(c) {
  let t = clean(first(c.title));
  const sub = clean(first(c.subtitle));
  if (sub && !norm(t).includes(norm(sub))) t = `${t}: ${sub}`;
  return t;
}

export function cslAuthors(c) {
  return (c.author || []).map(a => {
    if (a.literal) return clean(a.literal);
    const fam = clean(a.family || ''), giv = clean(a.given || '');
    return fam ? (giv ? `${giv} ${fam}` : fam) : giv;
  }).filter(Boolean);
}

export function cslYear(c) {
  for (const k of ['issued', 'published-print', 'published-online', 'published']) {
    const dp = c[k]?.['date-parts'];
    if (dp?.[0]?.[0]) return String(dp[0][0]);
  }
  const raw = c.issued?.raw || '';
  const m = YEAR_RE.exec(raw);
  return m ? m[1] : null;
}

const VENUE_KEYS = ['container-title', 'event-title', 'event', 'collection-title', 'publisher'];

export function cslContainer(c) {
  for (const k of VENUE_KEYS) {
    const v = clean(first(c[k]));
    if (v) return v;
  }
  return '';
}

/**
 * 게재처 후보 전부. Springer LNCS 처럼 container-title 은 총서명이고
 * 참고문헌에는 권 제목이 적히는 경우가 있어, 하나라도 맞으면 통과시킨다.
 */
export function cslVenues(c) {
  const out = [];
  for (const k of VENUE_KEYS) {
    const v = clean(first(c[k]));
    if (v) out.push(v);
  }
  return out;
}

// --- 게재처 / 쪽수: 표기 관행 때문에 완화된 규칙 --------------------------

const VENUE_STOP = new Set([
  'the', 'of', 'on', 'in', 'and', 'for', 'a', 'an', 'at', 'to',
  'proceedings', 'conference', 'international', 'journal', 'annual',
]);

/** 'Comput. Surveys' ↔ 'ACM Computing Surveys' 같은 축약 표기를 통과시킨다 */
export function venueMatches(entry, official) {
  const off = normWords(official).filter(w => !VENUE_STOP.has(w) && w.length > 2);
  if (!off.length) return true;
  const ref = new Set(normWords(entry));
  const refPref = [...ref].filter(w => w.length >= 4);
  const flat = norm(entry);
  let hit = 0;
  for (const o of off) {
    if (ref.has(o)                                   // 그대로 일치
      || refPref.some(r => o.startsWith(r))          // 'Comput.' → Computing
      || (o.length >= 5 && flat.includes(o))) {      // 'HumanComputer' 처럼 붙은 경우
      hit++;
    }
  }
  return hit / off.length >= 0.6;
}

/** ACM 저널의 'Article 83 … 21 pages' 표기도 통과시킨다 */
export function pagesMatch(rest, official) {
  const txt = clean(rest);
  const digits = txt.replace(/[^0-9-]/g, '');
  const off = official.replace(/[^0-9-]/g, '');
  if (off && digits.includes(off)) return true;

  const m = /^(\d+)-(\d+)$/.exec(off);
  if (m) {
    const a = +m[1], b = +m[2], count = b - a + 1;
    for (const n of txt.matchAll(/(\d+)\s*(?:pages|pp\.?|p\.)/gi)) {
      if (+n[1] === count) return true;
    }
    if (new RegExp(`(?<!\\d)${a}(?!\\d)`).test(txt)) return true;
  } else if (off && new RegExp(`(?<!\\d)${off}(?!\\d)`).test(txt)) {
    return true;
  }
  return false;
}

function pagesGuess(rest) {
  const m = /(\d+\s*-\s*\d+|\d+\s*pages)/i.exec(clean(rest));
  return m ? m[1] : '';
}

function venueGuess(rest, official) {
  const parts = rest.split(/(?<=[.?!])\s+/);
  let best = null, bestR = 0;
  for (const p of parts.slice(0, 8)) {
    const r = ratio(norm(p), norm(official));
    if (r > bestR) { best = p.replace(/[ .]+$/, ''); bestR = r; }
  }
  return bestR > 0.3 ? best : '';
}

// --- 본 비교 ---------------------------------------------------------------

/** @returns {{field, severity, pdf, doi, note}[]} */
export function compare(entry, csl) {
  const issues = [];
  const flat = norm(entry);
  const { authorsPart, year: refYear, rest } = splitRef(entry);

  const add = (field, pdf, doi, note = null) =>
    issues.push({ field, severity: SEVERITY[field] || 'warn', pdf: clean(pdf), doi: clean(doi), note });

  // 제목
  const oTitle = cslTitle(csl);
  if (oTitle) {
    const nt = norm(oTitle);
    if (nt && !flat.includes(nt)) {
      const guess = guessTitle(rest, oTitle);
      if (ratio(norm(guess), nt) < 0.93) {
        add('title', guess, oTitle, { code: 'diff', ops: wordDiff(guess, oTitle) });
      }
    }
  }

  // 저자
  const offAuthors = cslAuthors(csl);
  if (offAuthors.length) {
    const scope = norm(authorsPart) || flat;
    const etal = /\bet\s*al\b/i.test(authorsPart || entry);
    const missing = offAuthors.filter(a => {
      const parts = a.split(/\s+/);
      const fam = parts.length ? parts[parts.length - 1] : a;
      return norm(fam).length >= 3 && !scope.includes(norm(fam));
    });
    if (missing.length && !(etal && missing.length < offAuthors.length)) {
      add('authors', authorsPart, offAuthors.join('; '), {
        code: 'missingAuthors',
        names: missing.slice(0, 6).join(', '),
        extra: Math.max(0, missing.length - 6),
      });
    } else if (!etal && authorsPart) {
      const nRef = authorsPart.split(/,| and |;/).filter(x => x.trim()).length;
      if (nRef && Math.abs(nRef - offAuthors.length) >= 2) {
        add('authors', authorsPart, offAuthors.join('; '),
          { code: 'authorCount', a: nRef, b: offAuthors.length });
      }
    }
  }

  // 연도 (±1년은 online-first 가능성이 있어 warn)
  const oYear = cslYear(csl);
  if (oYear && refYear && oYear !== refYear) {
    const near = Math.abs(+oYear - +refYear) <= 1;
    issues.push({
      field: 'year', severity: near ? 'warn' : 'error',
      pdf: refYear, doi: oYear,
      note: { code: near ? 'yearNear' : 'yearMismatch' },
    });
  }

  // 게재처 — 판단은 대표 이름으로 하되, 후보 중 하나라도 맞으면 통과.
  // LNCS 처럼 container-title 이 총서명이고 참고문헌엔 권 제목이 적힌 경우를 위한 것.
  const venue = cslContainer(csl);
  if (venue && norm(venue).length > 8
      && !cslVenues(csl).some(v => venueMatches(entry, v))) {
    add('venue', venueGuess(rest, venue), venue, { code: 'venueMismatch' });
  }

  // 권 / 호
  const vol = clean(csl.volume || '');
  if (vol && /^\d+$/.test(vol) && !new RegExp(`(?<!\\d)${vol}(?!\\d)`).test(clean(rest))) {
    add('volume', '', vol);
  }
  const iss = clean(csl.issue || '');
  if (iss && /^\d+$/.test(iss) && vol && !new RegExp(`(?<!\\d)${iss}(?!\\d)`).test(clean(rest))) {
    add('issue', '', iss);
  }

  // 쪽수
  const pages = clean(csl.page || '').replace(/--/g, '-');
  if (pages && !pagesMatch(rest, pages)) add('pages', pagesGuess(rest), pages);

  return issues;
}

// --- DOI 없는 항목: Crossref 후보 채점 -------------------------------------

export function scoreCandidate(entry, cand) {
  const { authorsPart, year: refYear, rest } = splitRef(entry);
  const flat = norm(entry);
  const title = cslTitle(cand);
  if (!title) return { level: 'none', titleRatio: 0, authorHit: 0, year: '?', nAuthors: 0 };

  const nt = norm(title);
  const titleRatio = (nt && flat.includes(nt)) ? 1 : ratio(norm(guessTitle(rest, title)), nt);

  const fams = cslAuthors(cand)
    .map(a => { const p = a.split(/\s+/); return p.length ? p[p.length - 1] : a; })
    .filter(f => norm(f).length >= 3);
  const scope = norm(authorsPart) || flat;
  // Crossref 에 저자가 아예 없는 기록이 흔하다 (책 챕터 등). 그럴 땐 감점하지 않는다.
  const authorHit = fams.length
    ? fams.filter(f => scope.includes(norm(f))).length / fams.length
    : null;

  const cy = cslYear(cand);
  let year;
  if (!cy || !refYear) year = 'unknown';
  else if (cy === refYear) year = 'match';
  else if (Math.abs(+cy - +refYear) <= 1) year = 'near';
  else year = 'mismatch';

  let level;
  if (authorHit === null) {
    // 저자로 교차확인할 수 없으니 제목·연도만으로 판단하고 기준을 올린다
    if (titleRatio >= 0.95 && (year === 'match' || year === 'near')) level = 'high';
    else if (titleRatio >= 0.90 && year !== 'mismatch') level = 'medium';
    else level = 'none';
  } else if (titleRatio >= 0.90 && authorHit >= 0.5 && year !== 'mismatch') level = 'high';
  else if (titleRatio >= 0.90 && authorHit >= 0.5) level = 'medium';   // 연도만 다름 = 선공개판일 수 있음
  else if (titleRatio >= 0.78 && authorHit >= 0.34 && year !== 'mismatch') level = 'medium';
  else level = 'none';

  return {
    level,
    titleRatio: Math.round(titleRatio * 1000) / 1000,
    authorHit: authorHit === null ? null : Math.round(authorHit * 1000) / 1000,
    year,
    nAuthors: fams.length,
  };
}
