// pdf.js 로 PDF → 줄 단위 텍스트.
//
// pdftotext 와 달리 글자 좌표를 직접 받으므로 두 가지를 우리가 제어한다:
//   1) 2단 조판을 단별로 나눈 뒤 읽기 순서대로 이어붙인다
//   2) 줄바꿈 하이픈을 마음대로 지우지 않는다 → DOI 가 깨지지 않는다
//      (pdftotext 는 이걸 지워버려서 -layout 판을 따로 돌려 복원해야 했다)

const GUTTER_BINS = 120;

function itemsOfPage(textContent) {
  const out = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;
    out.push({
      str: it.str,
      x: t[4],
      y: t[5],
      w: it.width || 0,
      h: it.height || Math.abs(t[3]) || 10,
    });
  }
  return out;
}

/** 페이지 가운데의 빈 세로띠(gutter)를 찾아 단 경계 x 좌표를 돌려준다 */
function detectGutter(items, pageWidth) {
  if (items.length < 40) return null;
  const hist = new Array(GUTTER_BINS).fill(0);
  for (const it of items) {
    const a = Math.max(0, Math.floor((it.x / pageWidth) * GUTTER_BINS));
    const b = Math.min(GUTTER_BINS - 1, Math.floor(((it.x + it.w) / pageWidth) * GUTTER_BINS));
    for (let i = a; i <= b; i++) hist[i]++;
  }
  // 머리글처럼 가운데를 살짝 침범하는 줄이 있으므로 완전한 0 대신 여유를 둔다
  const slack = Math.max(0, Math.floor(items.length * 0.005));
  const lo = Math.floor(GUTTER_BINS * 0.32);
  const hi = Math.floor(GUTTER_BINS * 0.68);

  let best = null, run = null;
  for (let i = lo; i <= hi; i++) {
    if (hist[i] <= slack) {
      run = run ? { s: run.s, e: i } : { s: i, e: i };
      if (!best || run.e - run.s > best.e - best.s) best = { ...run };
    } else run = null;
  }
  if (!best || best.e - best.s < 2) return null;

  const cut = (((best.s + best.e + 1) / 2) / GUTTER_BINS) * pageWidth;
  const left = items.filter(it => it.x + it.w / 2 < cut).length;
  if (left < items.length * 0.2 || left > items.length * 0.8) return null;
  return cut;
}

/** 같은 y 에 있는 조각들을 한 줄로 묶고, 조각 사이 간격을 보고 공백을 넣는다 */
function buildLines(items) {
  if (!items.length) return [];
  const heights = items.map(i => i.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 10;
  const tol = Math.max(2, medH * 0.5);

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || Math.abs(it.y - cur.y) > tol) {
      cur = { y: it.y, items: [it] };
      lines.push(cur);
    } else {
      cur.items.push(it);
      cur.y = (cur.y * (cur.items.length - 1) + it.y) / cur.items.length;
    }
  }

  const out = [];
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let s = '';
    let prev = null;
    for (const it of ln.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > prev.h * 0.18 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
      }
      s += it.str;
      prev = it;
    }
    s = s.replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
  }
  return out;
}

/** 페이지마다 반복되는 머리글/바닥글 제거 (참고문헌 한가운데로 끼어든다) */
export function stripRunningHeads(lines, minRepeat = 4) {
  const freq = new Map();
  for (const l of lines) {
    const k = l.trim();
    if (k) freq.set(k, (freq.get(k) || 0) + 1);
  }
  const heads = new Set();
  for (const [l, n] of freq) {
    if (n >= minRepeat && l.length >= 8 && l.length <= 150 && !l.startsWith('[')) heads.add(l);
  }
  if (!heads.size) return { lines, removed: [] };
  return {
    lines: lines.filter(l => !heads.has(l.trim())),
    removed: [...heads],
  };
}

/**
 * @returns {Promise<{text: string, pages: number, columns: number[], removedHeads: string[]}>}
 */
export async function extractText(pdfjsLib, arrayBuffer, onProgress) {
  const task = pdfjsLib.getDocument({
    data: arrayBuffer,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const numPages = doc.numPages;

  const allLines = [];
  const columns = [];
  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const items = itemsOfPage(await page.getTextContent());
    const cut = detectGutter(items, viewport.width);
    columns.push(cut ? 2 : 1);

    if (cut === null) {
      allLines.push(...buildLines(items));
    } else {
      const left = [], right = [];
      for (const it of items) (it.x + it.w / 2 < cut ? left : right).push(it);
      allLines.push(...buildLines(left), ...buildLines(right));
    }
    page.cleanup();
    onProgress?.(p, numPages);
  }
  await task.destroy();

  const { lines, removed } = stripRunningHeads(allLines);
  return {
    text: lines.join('\n'),
    pages: numPages,
    columns,
    removedHeads: removed,
  };
}
