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
// OpenAlex 는 10 req/s · 10만/일 을 허용하지만 넉넉히 잡아 둔다.
const RATE = { doi: 5, search: 1, searchPolite: 3, openalex: 2 };

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
  openalex: limiter(RATE.openalex),
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

const OA_SELECT = 'id,doi,title,publication_year,authorships,primary_location';

/**
 * OpenAlex 검색. Crossref 가 못 찾는 것 (학술서 챕터, 일부 저널) 을 덮는다.
 * @returns {Promise<{ok: boolean, items: object[]}>}
 */
export async function openAlexSearch(title, { rows = 3, mailto = '' } = {}) {
  const q = title.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q) return { ok: true, items: [] };
  const key = `oa:${rows}:${q}`;
  if (cache.has(key)) return cache.get(key);

  // search= 는 전문(full-text) 검색이라 엉뚱한 걸 물어온다. 제목 인덱스를 쓴다.
  const params = new URLSearchParams({
    filter: 'title.search:' + q, per_page: String(rows), select: OA_SELECT,
  });
  if (mailto) params.set('mailto', mailto);

  const res = await withRetry(async () => {
    await gate.openalex();
    try {
      const r = await fetch('https://api.openalex.org/works?' + params, {
        headers: { Accept: 'application/json' },
      });
      return { ok: r.ok, status: r.status, body: r.ok ? await r.text() : '' };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  });

  if (!res.ok) return { ok: false, items: [] };
  let items = [];
  try { items = JSON.parse(res.body).results || []; }
  catch { return { ok: false, items: [] }; }

  const out = { ok: true, items };
  cache.set(key, out);
  return out;
}

// 저장소 인용은 본문 URL 로는 확인할 수 없다 (github.com·huggingface.co 둘 다
// CORS 를 열지 않아 fetch 가 막히고, no-cors 응답은 200 과 404 를 구분할 수 없다).
// 대신 두 곳 모두 API 는 CORS 를 열어 두었고 없는 것에 404/401 을 준다.
const REPO_API = [
  [/github\.com\/([^/\s#?]+)\/([^/\s#?)\]]+)/i,
    (m) => ({ url: `https://api.github.com/repos/${m[1]}/${trimGit(m[2])}`, host: 'github' })],
  [/huggingface\.co\/(datasets|spaces)\/([^\s#?)\]]+)/i,
    (m) => ({ url: `https://huggingface.co/api/${m[1]}/${clip(m[2])}`, host: 'hf' })],
  [/huggingface\.co\/([^/\s#?]+\/[^\s#?)\]]+)/i,
    (m) => ({ url: `https://huggingface.co/api/models/${clip(m[1])}`, host: 'hf' })],
];

const trimGit = (x) => x.replace(/\.git$/, '').replace(/[.,;]+$/, '');
const clip = (x) => x.split(/[/]/).slice(0, 2).join('/').replace(/[.,;]+$/, '');

/**
 * 저장소·모델이 실제로 있는지 확인한다.
 * @returns {Promise<{state: 'alive'|'dead'|'unknown', name?: string, note?: string}>}
 */
export async function checkRepo(entry) {
  for (const [re, build] of REPO_API) {
    const m = re.exec(entry);
    if (!m) continue;
    const { url, host } = build(m);
    const key = `repo:${url}`;
    if (cache.has(key)) return cache.get(key);

    let out = { state: 'unknown' };
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        out = {
          state: 'alive',
          name: host === 'github' ? d.full_name : d.id,
          note: host === 'github' && d.archived ? 'archived' : '',
        };
      } else if (r.status === 404 || r.status === 401) {
        out = { state: 'dead' };
      }
      // 403/429 (요청 한도) 등은 unknown 으로 두고 넘어간다
    } catch { /* 네트워크 문제도 unknown */ }
    cache.set(key, out);
    return out;
  }
  return { state: 'unknown' };
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

/**
 * 웹페이지 인용에 아카이브 사본이 있는지 본다.
 *
 * 페이지가 지금도 살아 있는지는 브라우저에서 확인할 수 없다. 대상 사이트가
 * CORS 를 안 열어 주므로 mode:'cors' 는 항상 실패하고, mode:'no-cors' 는
 * 200 과 404 를 똑같이 opaque(status 0) 로 준다. 도메인이 죽으면 예외가 나서
 * 그것만은 구분되는 듯했지만, 실측에서 살아 있는 사이트(Tumblr 호스팅)도
 * 예외를 냈다. 살아 있는 인용을 죽었다고 하는 건 아무 말 안 하느니만 못하므로
 * 생사 판정은 하지 않는다.
 *
 * 대신 아카이브 사본을 알려준다. 인용 링크가 썩었을 때 실제로 필요한 것이다.
 *
 * @returns {Promise<{url: string, archive: object|null}|null>}
 */
export async function checkWeb(entry) {
  const m = URL_RE.exec(entry);
  if (!m) return null;
  const url = m[0].replace(/[.,;]+$/, '');
  const key = `web:${url}`;
  if (cache.has(key)) return cache.get(key);

  let archive = null;
  try {
    await gate.openalex();   // 아카이브도 같은 정도로 아껴 쓴다
    const r = await fetch('https://archive.org/wayback/available?url='
      + encodeURIComponent(url.replace(/^https?:\/\//i, '')));
    if (r.ok) {
      const snap = (await r.json())?.archived_snapshots?.closest;
      if (snap?.available) {
        archive = { url: snap.url, timestamp: snap.timestamp, status: snap.status };
      }
    }
  } catch { /* 아카이브 조회 실패는 그냥 없음으로 */ }

  const out = { url, archive };
  cache.set(key, out);
  return out;
}

/**
 * 철회·정정 여부를 한꺼번에 조회한다.
 * Crossref 는 Retraction Watch 데이터를 updated-by 로 노출한다.
 * doi.org 의 CSL-JSON 에는 이 정보가 없어 별도로 물어봐야 하지만,
 * filter=doi:A,doi:B 로 묶을 수 있어 요청 수는 얼마 안 든다.
 * @returns {Promise<Map<string, object[]>>} 소문자 DOI → updated-by 목록
 */
export async function crossrefUpdates(dois, { mailto = '' } = {}) {
  const out = new Map();
  const list = [...new Set(dois.map(d => d.toLowerCase()))].filter(d => d && !d.includes(','));
  const BATCH = 20;

  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const params = new URLSearchParams({
      filter: chunk.map(d => 'doi:' + d).join(','),
      select: 'DOI,updated-by',
      rows: String(chunk.length),
    });
    if (mailto) params.set('mailto', mailto);

    const res = await withRetry(async () => {
      await (mailto ? gate.searchPolite : gate.search)();
      try {
        const r = await fetch('https://api.crossref.org/works?' + params,
          { headers: { Accept: 'application/json' } });
        return { ok: r.ok, status: r.status, body: r.ok ? await r.text() : '' };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    });
    if (!res.ok) continue;
    try {
      for (const it of JSON.parse(res.body).message.items || []) {
        const ub = it['updated-by'] || [];
        if (ub.length) out.set(String(it.DOI).toLowerCase(), ub);
      }
    } catch { /* 무시 */ }
  }
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
