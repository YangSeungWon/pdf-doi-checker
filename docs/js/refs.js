// References 구간 자르기 · 항목 분리 · DOI 추출

const HEADING_RE =
  /^[ \t]*(?:\d+[.\s]*)?(REFERENCES|References|REFERENCE|Bibliography|BIBLIOGRAPHY|Works\s+Cited|참고\s*문헌)[ \t]*$/gm;

const BRACKET_RE = /^\s*\[(\d{1,4})\]\s+/gm;
const DOTTED_RE = /^\s*(\d{1,4})\.\s+(?=[A-ZÀ-ɏ"“])/gm;

const DOI_RE =
  /(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/|\bdoi\b[\s:]+)(10\.\d{4,9}\/[^\s,;]+)/i;
const BARE_DOI_RE = /(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/;

function countMatches(re, s) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s) !== null) n++;
  re.lastIndex = 0;
  return n;
}

/** 가장 그럴듯한 References 구간 (항목이 가장 많이 잡히는 후보) */
export function sliceReferences(text) {
  HEADING_RE.lastIndex = 0;
  const starts = [];
  let m;
  while ((m = HEADING_RE.exec(text)) !== null) starts.push(m.index + m[0].length);
  if (!starts.length) starts.push(Math.floor((text.length * 2) / 3));

  let best = '', bestN = -1;
  for (const s of starts) {
    const chunk = text.slice(s);
    const n = countMatches(BRACKET_RE, chunk) + countMatches(DOTTED_RE, chunk);
    if (n > bestN) { best = chunk; bestN = n; }
  }
  return best;
}

/**
 * 항목 안의 줄바꿈을 합친다.
 * 하이픈은 원칙적으로 살려두되(=DOI 보호), 평범한 단어 분철이면 지운다.
 */
function joinLines(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  let s = '';
  for (const line of lines) {
    if (!s) { s = line; continue; }
    if (/[-‐‑]$/.test(s)) {
      const head = s.slice(0, -1);
      const lastWord = (head.match(/\S+$/) || [''])[0];
      const nextWord = (line.match(/^\S+/) || [''])[0];
      const isIdent = /(?:doi[:.]|https?:|10\.\d{4}|\/)/i.test(lastWord);
      // DOI/URL 이거나 고유명사·숫자로 이어지면 하이픈을 남긴다 (Human-Computer)
      s = (isIdent || /^[A-Z0-9]/.test(nextWord)) ? s + line : head + line;
    } else if (/\/$/.test(s) || /^https?:$/i.test((s.match(/\S+$/) || [''])[0]) || /^\/\//.test(line)) {
      s += line;
    } else {
      s += ' ' + line;
    }
  }
  s = s.replace(/(https?:)\s+(\/\/)/gi, '$1$2');
  // 방어적으로 한 번 더: doi: 뒤 '/', '.', '-' 직후의 공백 제거
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/((?:doi:|doi\.org\/)\s*10\.[^\s]*?[/.\-])[ \t]+(?=\S)/gi, '$1');
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** @returns {{label: string, entry: string}[]} */
export function splitEntries(refsText) {
  for (const re of [BRACKET_RE, DOTTED_RE]) {
    re.lastIndex = 0;
    const marks = [];
    let m;
    while ((m = re.exec(refsText)) !== null) {
      marks.push({ num: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    re.lastIndex = 0;
    if (marks.length < 3) continue;

    // 번호가 대체로 증가해야 진짜 목록
    let inc = 0;
    for (let i = 1; i < marks.length; i++) if (marks[i].num > marks[i - 1].num) inc++;
    if (inc < marks.length * 0.7) continue;

    const entries = [];
    for (let i = 0; i < marks.length; i++) {
      const stop = i + 1 < marks.length ? marks[i + 1].start : refsText.length;
      let body = joinLines(refsText.slice(marks[i].end, stop));
      if (i + 1 === marks.length) {
        body = body.split(/\s(?=[A-Z]\s+(?:Appendix|APPENDIX)\b)/)[0].slice(0, 3000);
      }
      if (body) entries.push({ label: String(marks[i].num), entry: body });
    }
    if (entries.length) return entries;
  }

  // 폴백: 빈 줄 기준 문단 분리
  const entries = [];
  refsText.split(/\n\s*\n/).forEach((para, i) => {
    const body = joinLines(para);
    if (body.length > 40) entries.push({ label: String(i + 1), entry: body });
  });
  return entries;
}

export function extractDoi(entry) {
  const m = DOI_RE.exec(entry) || BARE_DOI_RE.exec(entry);
  if (!m) return null;
  return m[1].replace(/[.,;)\]]+$/, '').replace(/\.+$/, '');
}
