// doi.org / Crossref 조회. 서버 없이 브라우저에서 직접 부른다.
//
// CORS: doi.org 는 302 응답에 Access-Control-Allow-Origin 으로 요청 Origin 을
// 그대로 돌려주고, 최종 목적지(api.crossref.org 등)는 '*' 를 준다.
// Accept 는 CORS 안전목록 헤더라 프리플라이트도 붙지 않는다.

const ACCEPT = {
  csl: 'application/vnd.citationstyles.csl+json',
  bib: 'application/x-bibtex',
};

const cache = new Map();

// Crossref 가 응답 헤더로 알려주는 상한 (2026-09 실측):
//   검색  /works?query...        공개 1 req/s · polite(mailto) 3 req/s
//   DOI   /works/{doi}/transform 공개 5 req/s
// 이 헤더는 CORS 로 노출되지 않아 브라우저가 읽을 수 없으므로 값을 박아 둔다.
const RATE = { doi: 5, search: 1, searchPolite: 3 };

/** 초당 n 건을 넘지 않도록 호출 간격을 벌린다 */
function limiter(perSecond) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  };
}

const gate = {
  doi: limiter(RATE.doi),
  search: limiter(RATE.search),
  searchPolite: limiter(RATE.searchPolite),
};

export function clearCache() { cache.clear(); }
export function cacheSize() { return cache.size; }

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) return r;
    last = r;
    await new Promise(res => setTimeout(res, 1200 * (i + 1)));
  }
  return last;
}

/** @returns {Promise<{ok: boolean, status: number, body: string}>} */
export async function fetchDoi(doi, kind = 'csl') {
  const key = `${kind}:${doi}`;
  if (cache.has(key)) return cache.get(key);

  const url = 'https://doi.org/' + encodeURI(doi);
  const result = await withRetry(async () => {
    await gate.doi();
    try {
      const res = await fetch(url, { headers: { Accept: ACCEPT[kind] }, redirect: 'follow' });
      return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : '' };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  });
  cache.set(key, result);
  return result;
}

const SELECT = 'DOI,title,subtitle,author,issued,container-title,volume,issue,page,type';

/**
 * 참고문헌 원문을 통째로 넣어 Crossref 서지검색.
 * 실패를 "결과 없음"과 구별하기 위해 ok 를 함께 돌려주고, 실패는 캐시하지 않는다.
 * @returns {Promise<{ok: boolean, status: number, items: object[]}>}
 */
export async function crossrefSearch(entry, { rows = 3, mailto = '' } = {}) {
  const query = entry.replace(/\s+/g, ' ').trim().slice(0, 400);
  const key = `search:${rows}:${query}`;
  if (cache.has(key)) return cache.get(key);

  const params = new URLSearchParams({ 'query.bibliographic': query, rows: String(rows), select: SELECT });
  if (mailto) params.set('mailto', mailto);

  const limit = mailto ? gate.searchPolite : gate.search;
  const res = await withRetry(async () => {
    await limit();
    try {
      const r = await fetch('https://api.crossref.org/works?' + params, {
        headers: { Accept: 'application/json' },
      });
      return { ok: r.ok, status: r.status, body: r.ok ? await r.text() : '' };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  });

  if (!res.ok) return { ok: false, status: res.status, items: [] };
  let items = [];
  try { items = JSON.parse(res.body).message.items || []; }
  catch { return { ok: false, status: -1, items: [] }; }

  const out = { ok: true, status: 200, items };
  cache.set(key, out);
  return out;
}

/** 동시 실행 수를 제한하며 순서대로 결과를 모은다 */
export async function pool(items, limit, worker, onDone) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: String(e) }; }
      onDone?.(++done, items.length);
    }
  });
  await Promise.all(runners);
  return out;
}
