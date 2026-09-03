// 문자열 정규화 · 유사도 · 단어 단위 diff
// 파이썬판 doi_check.py 의 clean/norm/ratio/word_diff 를 그대로 옮긴 것.

const DASHES = /[‐‑‒–—―−]/g;
const SQUOTES = /[‘’ʼ]/g;
const DQUOTES = /[“”]/g;

/** 사람이 읽는 표시용 정리 */
export function clean(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).normalize('NFKC');
  t = t.replace(DASHES, '-').replace(SQUOTES, "'").replace(DQUOTES, '"');
  t = t.replace(/<[^>]+>/g, '');          // Crossref 제목의 <i>, <sub> 등
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return t.replace(/\s+/g, ' ').trim();
}

const FOLD = [['ß', 'ss'], ['æ', 'ae'], ['ø', 'o'], ['œ', 'oe'], ['đ', 'd'], ['ł', 'l']];

function fold(s) {
  let t = clean(s).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  for (const [a, b] of FOLD) t = t.split(a).join(b);
  return t;
}

/** 비교용 강한 정규화: 악센트·구두점·공백 제거 + 소문자 */
export function norm(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '');
}

/** 비교용 단어 배열 */
export function normWords(s) {
  return fold(s).match(/[a-z0-9]+/g) || [];
}

export function shorten(s, n) {
  const t = clean(s);
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------
// difflib.SequenceMatcher 이식 (autojunk 없음)
// ---------------------------------------------------------------------------

function buildB2J(b) {
  const m = new Map();
  for (let j = 0; j < b.length; j++) {
    const k = b[j];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(j);
  }
  return m;
}

function longestMatch(a, b, alo, ahi, blo, bhi, b2j) {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const js = b2j.get(a[i]);
    if (js) {
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

/** 일치 블록 목록 (i, j, size), i·j 오름차순 */
export function matchingBlocks(a, b) {
  const b2j = buildB2J(b);
  const queue = [[0, a.length, 0, b.length]];
  const out = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi, b2j);
    if (!k) continue;
    out.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return out;
}

/** difflib 의 ratio(): 2 * 일치 길이 / 전체 길이 */
export function ratio(a, b) {
  if (!a || !b) return 0;
  // 아주 긴 문자열은 앞부분만 비교 (O(n·m) 방어)
  const A = a.length > 600 ? a.slice(0, 600) : a;
  const B = b.length > 600 ? b.slice(0, 600) : b;
  let m = 0;
  for (const [, , k] of matchingBlocks([...A], [...B])) m += k;
  return (2 * m) / (A.length + B.length);
}

function opcodes(a, b) {
  const blocks = matchingBlocks(a, b);
  const ops = [];
  let i = 0, j = 0;
  for (const [bi, bj, size] of blocks) {
    if (i < bi && j < bj) ops.push(['replace', i, bi, j, bj]);
    else if (i < bi) ops.push(['delete', i, bi, j, bj]);
    else if (j < bj) ops.push(['insert', i, bi, j, bj]);
    if (size) ops.push(['equal', bi, bi + size, bj, bj + size]);
    i = bi + size;
    j = bj + size;
  }
  if (i < a.length && j < b.length) ops.push(['replace', i, a.length, j, b.length]);
  else if (i < a.length) ops.push(['delete', i, a.length, j, b.length]);
  else if (j < b.length) ops.push(['insert', i, a.length, j, b.length]);
  return ops;
}

/**
 * 두 문자열을 나란히 보여주기 위한 단어 조각.
 * x:true 인 조각이 서로 다른 부분이다.
 * @returns {{left: {t: string, x?: boolean}[], right: {t: string, x?: boolean}[]}}
 */
export function wordSpans(a, b) {
  const A = clean(a).split(/\s+/).filter(Boolean);
  const B = clean(b).split(/\s+/).filter(Boolean);
  const left = [], right = [];
  for (const [tag, i1, i2, j1, j2] of
    opcodes(A.map(w => w.toLowerCase()), B.map(w => w.toLowerCase()))) {
    const l = A.slice(i1, i2).join(' ');
    const r = B.slice(j1, j2).join(' ');
    const changed = tag !== 'equal';
    if (l) left.push(changed ? { t: l, x: true } : { t: l });
    if (r) right.push(changed ? { t: r, x: true } : { t: r });
  }
  return { left, right };
}

/** 두 문자열의 단어 단위 차이. 표시 문구는 UI 에서 붙인다(다국어). */
export function wordDiff(pdfStr, doiStr) {
  const a = clean(pdfStr).split(/\s+/).filter(Boolean);
  const b = clean(doiStr).split(/\s+/).filter(Boolean);
  const ops = [];
  for (const [tag, i1, i2, j1, j2] of opcodes(a.map(w => w.toLowerCase()), b.map(w => w.toLowerCase()))) {
    if (tag === 'equal') continue;
    ops.push({ tag, left: a.slice(i1, i2).join(' '), right: b.slice(j1, j2).join(' ') });
    if (ops.length >= 6) break;
  }
  return ops;
}
