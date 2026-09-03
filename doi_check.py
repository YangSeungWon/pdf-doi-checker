#!/usr/bin/env python3
"""
doi_check.py — 논문 PDF의 참고문헌(References)에서 DOI가 달린 항목을 찾아,
doi.org 의 공식 메타데이터(BibTeX / CSL-JSON)와 대조해서 다른 점을 보고합니다.

사용법:
    python3 doi_check.py paper.pdf
    python3 doi_check.py paper.pdf --all            # 이상 없는 항목도 전부 출력
    python3 doi_check.py paper.pdf --json out.json  # 기계가 읽을 결과
    python3 doi_check.py paper.pdf --bibtex         # 문제 항목의 공식 BibTeX 같이 출력

의존성: 없음(표준 라이브러리). 텍스트 추출에 `pdftotext`(poppler)를 쓰고,
없으면 pypdf / pdfminer.six 로 폴백합니다.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------
# 0. 설정
# --------------------------------------------------------------------------

MAILTO = os.environ.get("DOI_CHECK_MAILTO", "")
USER_AGENT = (
    "doi-check/1.0 (https://github.com/; python-urllib)"
    + (f" mailto:{MAILTO}" if MAILTO else "")
)

CACHE_DIR = os.environ.get(
    "DOI_CHECK_CACHE", os.path.join(os.path.expanduser("~"), ".cache", "doi-check")
)

# 필드별 심각도. error = 거의 확실한 오류, warn = 표기 관행 차이일 수 있음
SEVERITY = {
    "doi": "error",
    "title": "error",
    "authors": "error",
    "year": "error",
    "venue": "warn",
    "volume": "warn",
    "issue": "warn",
    "pages": "warn",
}


# --------------------------------------------------------------------------
# 1. PDF -> 텍스트
# --------------------------------------------------------------------------

def extract_text(pdf_path: str, layout: bool = False) -> str:
    """PDF 전체 텍스트. 2단 조판을 읽기 순서대로 풀어주는 도구를 우선 사용."""
    if shutil.which("pdftotext"):
        # -layout 없이 돌리면 poppler 가 단(column) 순서를 잡아주고 하이픈도 붙여줌.
        # 대신 줄바꿈 하이픈이 사라지므로, DOI 복구용으로 -layout 판도 따로 뽑는다.
        cmd = ["pdftotext", "-enc", "UTF-8"] + (["-layout"] if layout else [])
        out = subprocess.run(cmd + [pdf_path, "-"], capture_output=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.decode("utf-8", "replace")
    if layout:
        return ""

    try:
        import pypdf  # type: ignore

        reader = pypdf.PdfReader(pdf_path)
        return "\n".join((p.extract_text() or "") for p in reader.pages)
    except ImportError:
        pass

    try:
        from pdfminer.high_level import extract_text as _pm  # type: ignore

        return _pm(pdf_path)
    except ImportError:
        pass

    sys.exit(
        "PDF 텍스트 추출기를 찾을 수 없습니다.\n"
        "  brew install poppler   (권장)\n"
        "  또는  pip install pypdf"
    )


# --------------------------------------------------------------------------
# 2. References 구간 잘라내기 + 항목 분리
# --------------------------------------------------------------------------

HEADING_RE = re.compile(
    r"^[ \t]*(?:\d+[.\s]*)?(REFERENCES|References|REFERENCE|Bibliography|BIBLIOGRAPHY|"
    r"Works\s+Cited|참고\s*문헌)[ \t]*$",
    re.MULTILINE,
)

# 항목 시작 마커: "[12] " 또는 줄머리의 "12. "
BRACKET_RE = re.compile(r"^\s*\[(\d{1,4})\]\s+", re.MULTILINE)
DOTTED_RE = re.compile(r"^\s*(\d{1,4})\.\s+(?=[A-ZÀ-ɏ\"“])", re.MULTILINE)

# 줄바꿈으로 쪼개진 DOI 복구용: doi: 접두 뒤 '/', '.', '-' 직후의 공백만 제거
DOI_GLUE_RE = re.compile(
    r"(?i)((?:doi:\s*|doi\.org/|DOI\s+)10\.[^\s]*?[/.\-])[ \t]+(?=\S)"
)

DOI_RE = re.compile(
    r"(?i)(?:doi:\s*|https?://(?:dx\.)?doi\.org/|\bdoi\b[\s:]+)"
    r"(10\.\d{4,9}/[^\s,;]+)"
)
BARE_DOI_RE = re.compile(r"(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)")


def strip_running_heads(text: str, min_repeat: int = 4) -> str:
    """페이지마다 반복되는 머리글/바닥글을 지운다.

    2단 조판 논문에서는 이 줄들이 참고문헌 항목 한가운데로 끼어들어
    제목·저자 비교를 망친다.
    """
    import collections

    lines = text.split("\n")
    freq = collections.Counter(l.strip() for l in lines if l.strip())
    heads = {
        l for l, n in freq.items()
        if n >= min_repeat and 8 <= len(l) <= 150 and not l.startswith("[")
    }
    if not heads:
        return text
    return "\n".join(l for l in lines if l.strip() not in heads)


def slice_references(text: str) -> str:
    """가장 그럴듯한 References 구간을 돌려준다(항목이 가장 많이 잡히는 후보)."""
    starts = [m.end() for m in HEADING_RE.finditer(text)]
    if not starts:
        # 헤딩을 못 찾으면 마지막 3분의 1을 통째로 시도
        starts = [len(text) * 2 // 3]

    best, best_n = "", -1
    for s in starts:
        chunk = text[s:]
        n = len(BRACKET_RE.findall(chunk)) + len(DOTTED_RE.findall(chunk))
        if n > best_n:
            best, best_n = chunk, n
    return best


def _join_lines(block: str) -> str:
    """항목 내부 줄바꿈을 공백으로 합치고, 쪼개진 DOI/URL을 복구."""
    s = re.sub(r"[ \t]*\n[ \t]*", " ", block)
    s = s.replace("­", "")                      # soft hyphen
    s = re.sub(r"(https?:)\s+(//)", r"\1\2", s)      # "https: //example" 복구
    prev = None
    while prev != s:                                  # doi 조각 반복 접합
        prev = s
        s = DOI_GLUE_RE.sub(r"\1", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def split_entries(refs_text: str) -> list[tuple[str, str]]:
    """[(라벨, 항목 원문), ...]"""
    for rx in (BRACKET_RE, DOTTED_RE):
        marks = list(rx.finditer(refs_text))
        if len(marks) < 3:
            continue
        # 번호가 대체로 증가해야 진짜 목록
        nums = [int(m.group(1)) for m in marks]
        if sum(b > a for a, b in zip(nums, nums[1:])) < len(nums) * 0.7:
            continue

        entries = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(refs_text)
            body = _join_lines(refs_text[m.end() : end])
            # 부록/다음 섹션이 붙어 들어온 마지막 항목 정리
            if i + 1 == len(marks):
                body = re.split(
                    r"\s(?=(?:[A-Z]\s+)?(?:Appendix|APPENDIX|Appendices|Acknowledg|ACKNOWLEDG"
                    r"|Supplementary|SUPPLEMENTARY)\b)", body)[0]
                body = body[:3000]
            if body:
                entries.append((m.group(1), body))
        if entries:
            return entries

    # 폴백: 빈 줄 기준 문단 분리
    entries = []
    for i, para in enumerate(re.split(r"\n\s*\n", refs_text), 1):
        body = _join_lines(para)
        if len(body) > 40:
            entries.append((str(i), body))
    return entries


# -layout 판에서 "줄 끝이 하이픈인 DOI 조각"을 모아둔다.
# 예: "... doi:10.18653/v1/2021.emnlp-" 로 끝나는 줄
HYPHEN_HINT_RE = re.compile(
    r"(?i)(?:doi:|doi\.org/)\s*(10\.\d{4,9}/\S*?-)(?=[ \t]{2,}|[ \t]*$)",
    re.MULTILINE,
)


def hyphen_hints(layout_text: str) -> list[str]:
    """줄바꿈 하이픈으로 끊긴 DOI 접두어 목록(하이픈 포함)."""
    hints = {m.group(1) for m in HYPHEN_HINT_RE.finditer(layout_text or "")}
    return sorted(hints, key=len, reverse=True)


def repair_doi(doi: str, hints: list[str]) -> str:
    """pdftotext 가 지워버린 줄바꿈 하이픈을 되살린다."""
    for h in hints:
        stem = h[:-1]                       # 하이픈 뗀 접두어
        if doi != h and doi.startswith(stem) and not doi.startswith(h):
            doi = h + doi[len(stem):]
    return doi


def extract_doi(entry: str) -> str | None:
    m = DOI_RE.search(entry)
    if not m:
        m = BARE_DOI_RE.search(entry)
    if not m:
        return None
    doi = m.group(1)
    doi = re.sub(r"[.,;)\]]+$", "", doi)      # 문장 끝 구두점 제거
    doi = doi.rstrip(".")
    return doi


# --------------------------------------------------------------------------
# 3. doi.org 조회
# --------------------------------------------------------------------------

# Crossref 가 응답 헤더로 알려주는 상한 (2026-09 실측):
#   검색  /works?query...        공개 1 req/s · polite(mailto) 3 req/s
#   DOI   /works/{doi}/transform 공개 5 req/s
_RATE_DOI = 5.0
_RATE_SEARCH = 3.0 if MAILTO else 1.0


class _Limiter:
    """초당 n 건을 넘지 않도록 호출 간격을 벌린다 (스레드 공용)."""

    def __init__(self, per_second: float):
        self._gap = 1.0 / per_second
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next)
            self._next = at + self._gap
        if at > now:
            time.sleep(at - now)


_gate_doi = _Limiter(_RATE_DOI)
_gate_search = _Limiter(_RATE_SEARCH)


def _cache_path(doi: str, kind: str) -> str:
    h = hashlib.sha1(f"{kind}:{doi}".encode()).hexdigest()[:20]
    return os.path.join(CACHE_DIR, f"{h}.{kind}")


def _http_get(url: str, accept: str, timeout: float = 30.0) -> tuple[int, str]:
    req = urllib.request.Request(
        url, headers={"Accept": accept, "User-Agent": USER_AGENT}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:500]
    except Exception as e:                                    # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def fetch(doi: str, kind: str, use_cache: bool = True) -> tuple[int, str]:
    """kind: 'csl' | 'bib'"""
    accept = {
        "csl": "application/vnd.citationstyles.csl+json",
        "bib": "application/x-bibtex",
    }[kind]
    path = _cache_path(doi, kind)
    if use_cache and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return 200, f.read()

    url = "https://doi.org/" + urllib.parse.quote(doi, safe="/:")
    for attempt in range(4):
        _gate_doi.wait()
        status, body = _http_get(url, accept)
        if status == 200:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            return status, body
        if status in (429, 500, 502, 503, 504, 0) and attempt < 3:
            time.sleep(1.5 * (attempt + 1))
            continue
        return status, body
    return status, body


# --------------------------------------------------------------------------
# 4. 정규화 & 비교
# --------------------------------------------------------------------------

DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")
QUOTES = {
    ord("‘"): "'", ord("’"): "'", ord("ʼ"): "'",
    ord("“"): '"', ord("”"): '"',
}


def clean(s: str) -> str:
    """사람이 읽는 표시용 정리."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s))
    s = s.translate(DASHES).translate(QUOTES)
    s = re.sub(r"<[^>]+>", "", s)              # Crossref 제목의 <i> 등
    return re.sub(r"\s+", " ", s).strip()


def norm(s: str) -> str:
    """비교용 강한 정규화: 악센트/구두점/공백 제거 + 소문자."""
    s = clean(s).lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    for a, b in (("ß", "ss"), ("æ", "ae"), ("ø", "o"), ("œ", "oe"), ("đ", "d"), ("ł", "l")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "", s)


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio() if a and b else 0.0


def word_diff(pdf_s: str, doi_s: str) -> str:
    """두 문자열의 단어 단위 차이를 짧게 요약."""
    a, b = clean(pdf_s).split(), clean(doi_s).split()
    sm = difflib.SequenceMatcher(None, [w.lower() for w in a], [w.lower() for w in b])
    bits = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        left, right = " ".join(a[i1:i2]), " ".join(b[j1:j2])
        if tag == "replace":
            bits.append(f"{left!r} → {right!r}")
        elif tag == "delete":
            bits.append(f"PDF에만: {left!r}")
        elif tag == "insert":
            bits.append(f"DOI에만: {right!r}")
    return "; ".join(bits[:6])


# ---- 참고문헌 원문에서 필드 뽑아내기 ------------------------------------

YEAR_RE = re.compile(r"(?<![0-9])((?:19|20)\d{2})(?![0-9])")
# ACM/APA 계열: "저자들. 2019. 제목. 학회/저널 ..."
AUTHORS_YEAR_RE = re.compile(r"^(.{0,600}?)[.,]\s*\[?((?:19|20)\d{2}|n\.\s*d\.)\]?[a-z]?\.\s")


def split_ref(entry: str) -> tuple[str, str | None, str]:
    """(저자부, 연도, 나머지). 형식을 못 알아보면 (\"\", None, 원문)."""
    m = AUTHORS_YEAR_RE.match(entry)
    if m:
        year = m.group(2) if m.group(2)[:2] in ("19", "20") else None
        return m.group(1), year, entry[m.end():]
    m = YEAR_RE.search(entry)
    return "", (m.group(1) if m else None), entry


def guess_title(rest: str, official_title: str) -> str:
    """제목 뒤 문장부터 잘라, 공식 제목과 가장 비슷해지는 지점까지를 제목으로 본다."""
    parts = re.split(r"(?<=[.?!])\s+", rest)
    tgt = norm(official_title)
    best, best_r = parts[0] if parts else rest, 0.0
    acc = ""
    for p in parts[:6]:
        acc = (acc + " " + p).strip()
        r = ratio(norm(acc), tgt)
        if r > best_r:
            best, best_r = acc, r
    return best.rstrip(" .")


def csl_authors(csl: dict) -> list[str]:
    out = []
    for a in csl.get("author") or []:
        if a.get("literal"):
            out.append(clean(a["literal"]))
        else:
            fam, giv = clean(a.get("family", "")), clean(a.get("given", ""))
            out.append((giv + " " + fam).strip() if fam else giv)
    return [a for a in out if a]


def csl_year(csl: dict) -> str | None:
    for key in ("issued", "published-print", "published-online", "published"):
        dp = (csl.get(key) or {}).get("date-parts") or []
        if dp and dp[0] and dp[0][0]:
            return str(dp[0][0])
    raw = (csl.get("issued") or {}).get("raw", "")
    m = YEAR_RE.search(raw)
    return m.group(1) if m else None


def csl_title(csl: dict) -> str:
    t = csl.get("title")
    if isinstance(t, list):
        t = t[0] if t else ""
    sub = csl.get("subtitle")
    if isinstance(sub, list):
        sub = sub[0] if sub else ""
    t = clean(t)
    sub = clean(sub)
    if sub and norm(sub) not in norm(t):
        t = f"{t}: {sub}"
    return t


def csl_container(csl: dict) -> str:
    for key in ("container-title", "event-title", "event", "publisher"):
        v = csl.get(key)
        if isinstance(v, list):
            v = v[0] if v else ""
        if v:
            return clean(v)
    return ""


def compare(entry: str, csl: dict) -> list[dict]:
    """참고문헌 원문 vs 공식 메타데이터 → 차이 목록."""
    issues: list[dict] = []
    flat = norm(entry)
    authors_part, ref_year, rest = split_ref(entry)

    def add(field, pdf_v, doi_v, note=""):
        issues.append({
            "field": field,
            "severity": SEVERITY.get(field, "warn"),
            "pdf": clean(pdf_v),
            "doi": clean(doi_v),
            "note": note,
        })

    # --- 제목 ---------------------------------------------------------
    otitle = csl_title(csl)
    if otitle:
        ntitle = norm(otitle)
        if ntitle and ntitle not in flat:
            guess = guess_title(rest, otitle)
            r = ratio(norm(guess), ntitle)
            if r < 0.93:
                add("title", guess, otitle, word_diff(guess, otitle))

    # --- 저자 ---------------------------------------------------------
    off_authors = csl_authors(csl)
    if off_authors:
        scope = norm(authors_part) or flat
        etal = bool(re.search(r"\bet\s*al\b", authors_part or entry, re.I))
        missing = []
        for a in off_authors:
            fam = a.split()[-1] if a.split() else a
            if len(norm(fam)) >= 3 and norm(fam) not in scope:
                missing.append(a)
        if missing and not (etal and len(missing) < len(off_authors)):
            add(
                "authors",
                authors_part or "(저자부 인식 실패)",
                "; ".join(off_authors),
                "PDF에 없는 저자: " + ", ".join(missing[:6])
                + (f" 외 {len(missing) - 6}명" if len(missing) > 6 else ""),
            )
        elif not etal and authors_part:
            n_ref = len([x for x in re.split(r",| and |;", authors_part) if x.strip()])
            if n_ref and abs(n_ref - len(off_authors)) >= 2:
                add("authors", authors_part, "; ".join(off_authors),
                    f"저자 수 차이: PDF≈{n_ref}명 vs DOI {len(off_authors)}명")

    # --- 연도 ---------------------------------------------------------
    oyear = csl_year(csl)
    if oyear and ref_year and oyear != ref_year:
        # online-first / print 연도 차이는 ±1년까지 경고로 낮춤
        sev = "warn" if abs(int(oyear) - int(ref_year)) <= 1 else "error"
        issues.append({
            "field": "year", "severity": sev,
            "pdf": ref_year, "doi": oyear,
            "note": "출판 연도 불일치" + (" (온라인/인쇄 시점 차이일 수 있음)" if sev == "warn" else ""),
        })

    # --- 게재처 -------------------------------------------------------
    venue = csl_container(csl)
    if venue and len(norm(venue)) > 8 and not venue_matches(entry, venue):
        add("venue", venue_guess(rest, venue), venue,
            "축약 표기까지 감안해도 일치하지 않음")

    # --- 권/호/쪽 -----------------------------------------------------
    vol = clean(csl.get("volume", ""))
    if vol and re.fullmatch(r"\d+", vol) and not re.search(rf"(?<!\d){vol}(?!\d)", clean(rest)):
        add("volume", "(없음/다름)", vol)

    iss = clean(csl.get("issue", ""))
    if iss and re.fullmatch(r"\d+", iss) and vol and not re.search(rf"(?<!\d){iss}(?!\d)", clean(rest)):
        add("issue", "(없음/다름)", iss)

    pages = clean(csl.get("page", "")).replace("--", "-")
    if pages and not pages_match(rest, pages):
        add("pages", pages_guess(rest), pages)

    return issues


def norm_words(s: str) -> list[str]:
    s = clean(s).lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9]+", s)


VENUE_STOP = {
    "the", "of", "on", "in", "and", "for", "a", "an", "at", "to",
    "proceedings", "conference", "international", "journal", "annual",
}


def venue_matches(entry: str, official: str) -> bool:
    """게재처 일치 판정. 'Comput. Surveys' 처럼 단어를 잘라 쓴 약어도 통과시킨다."""
    off = [w for w in norm_words(official) if w not in VENUE_STOP and len(w) > 2]
    if not off:
        return True
    ref = set(norm_words(entry))
    ref_pref = [w for w in ref if len(w) >= 4]
    hit = 0
    flat = norm(entry)
    for o in off:
        if (o in ref
                or any(o.startswith(r) for r in ref_pref)   # 'Comput.' → Computing
                or (len(o) >= 5 and o in flat)):            # 'HumanComputer' 처럼 붙은 경우
            hit += 1
    return hit / len(off) >= 0.6


def pages_match(rest: str, official: str) -> bool:
    """쪽수 일치 판정. ACM 저널의 'Article 83 ... 21 pages' 표기도 통과시킨다."""
    txt = clean(rest).translate(DASHES)
    digits = re.sub(r"[^0-9\-]", "", txt)
    off = re.sub(r"[^0-9\-]", "", official)
    if off and off in digits:
        return True
    m = re.fullmatch(r"(\d+)-(\d+)", off)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        count = b - a + 1
        # "21 pages" / "21 p." 같은 분량 표기
        for n in re.findall(r"(\d+)\s*(?:pages|pp\.?|p\.)", txt, re.I):
            if int(n) == count:
                return True
        # 시작쪽만 적은 경우
        if re.search(rf"(?<!\d){a}(?!\d)", txt):
            return True
    elif off and re.search(rf"(?<!\d){re.escape(off)}(?!\d)", txt):
        return True
    return False


def pages_guess(rest: str) -> str:
    txt = clean(rest).translate(DASHES)
    m = re.search(r"(\d+\s*-\s*\d+|\d+\s*pages)", txt, re.I)
    return m.group(1) if m else "(없음)"


def venue_guess(rest: str, official: str) -> str:
    parts = re.split(r"(?<=[.?!])\s+", rest)
    if not parts:
        return "(확인 못함)"
    best, best_r = "(확인 못함)", 0.0
    for p in parts[:8]:
        r = ratio(norm(p), norm(official))
        if r > best_r:
            best, best_r = p.rstrip(" ."), r
    return best if best_r > 0.3 else "(확인 못함)"


# --------------------------------------------------------------------------
# 5. 실행 & 출력
# --------------------------------------------------------------------------

class C:
    def __init__(self, on: bool):
        self.R = "\033[31m" if on else ""
        self.Y = "\033[33m" if on else ""
        self.G = "\033[32m" if on else ""
        self.B = "\033[1m" if on else ""
        self.D = "\033[2m" if on else ""
        self.X = "\033[0m" if on else ""


def suggest_doi(entry: str) -> dict | None:
    """Crossref 서지 검색으로 올바른 DOI 후보 1건을 찾아본다."""
    q = urllib.parse.urlencode({
        "query.bibliographic": clean(entry)[:400], "rows": "1",
        "select": "DOI,title,author,issued,container-title",
        **({"mailto": MAILTO} if MAILTO else {}),
    })
    _gate_search.wait()
    status, body = _http_get("https://api.crossref.org/works?" + q, "application/json")
    if status != 200:
        return None
    try:
        items = json.loads(body)["message"]["items"]
    except (json.JSONDecodeError, KeyError, IndexError):
        return None
    if not items:
        return None

    it = items[0]
    title = it.get("title") or [""]
    return {"doi": it.get("DOI", ""), "title": clean(title[0] if title else "")}


# 웹페이지/보고서처럼 애초에 DOI가 없을 항목은 검색을 건너뛴다
WEBISH_RE = re.compile(
    r"(?i)\bretrieved\b.{0,40}\bfrom\b\s*https?://|^\s*https?://|\baccessed\b.{0,20}\d{4}"
)


def crossref_search(entry: str, rows: int = 3, use_cache: bool = True) -> tuple[list[dict], bool]:
    """참고문헌 원문을 통째로 넣어 Crossref 서지검색.

    실패(네트워크·429 등)를 '결과 없음'과 구별해야 하므로 (items, ok) 를 돌려주고,
    실패한 응답은 캐시하지 않는다.
    """
    query = clean(entry)[:400]
    key = hashlib.sha1(f"{rows}:{query}".encode()).hexdigest()[:20]
    path = os.path.join(CACHE_DIR, f"{key}.search")
    if use_cache and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f), True

    params = {
        "query.bibliographic": query,
        "rows": str(rows),
        "select": "DOI,title,subtitle,author,issued,container-title,volume,issue,page,type",
    }
    if MAILTO:
        params["mailto"] = MAILTO
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode(params)

    for attempt in range(4):
        _gate_search.wait()
        status, body = _http_get(url, "application/json")
        if status == 200:
            try:
                items = json.loads(body)["message"]["items"]
            except (json.JSONDecodeError, KeyError, TypeError):
                return [], False
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(items, f)
            return items, True
        if status in (429, 500, 502, 503, 504, 0) and attempt < 3:
            time.sleep(2.0 * (attempt + 1))
            continue
        break
    return [], False


def score_candidate(entry: str, cand: dict) -> dict:
    """참고문헌 원문과 Crossref 후보가 같은 문헌인지 채점."""
    authors_part, ref_year, rest = split_ref(entry)
    flat = norm(entry)

    title = csl_title(cand)
    if not title:
        return {"level": "none", "title_ratio": 0.0, "author_hit": 0.0, "year": "?"}
    nt = norm(title)
    t_ratio = 1.0 if (nt and nt in flat) else ratio(norm(guess_title(rest, title)), nt)

    fams = [a.split()[-1] for a in csl_authors(cand) if a.split()]
    scope = norm(authors_part) or flat
    checkable = [f for f in fams if len(norm(f)) >= 3]
    a_hit = (sum(norm(f) in scope for f in checkable) / len(checkable)) if checkable else 0.0

    cy = csl_year(cand)
    if not cy or not ref_year:
        y = "unknown"
    elif cy == ref_year:
        y = "match"
    elif abs(int(cy) - int(ref_year)) <= 1:
        y = "near"
    else:
        y = "mismatch"

    if t_ratio >= 0.90 and a_hit >= 0.5 and y != "mismatch":
        level = "high"
    elif t_ratio >= 0.90 and a_hit >= 0.5:
        level = "medium"          # 제목·저자는 맞는데 연도가 다름 (선공개판일 수 있음)
    elif t_ratio >= 0.78 and a_hit >= 0.34 and y in ("match", "near", "unknown"):
        level = "medium"
    else:
        level = "none"
    return {"level": level, "title_ratio": round(t_ratio, 3),
            "author_hit": round(a_hit, 3), "year": y,
            "n_authors": len(checkable)}


def find_one(item: dict, use_cache: bool) -> dict:
    entry = item["entry"]
    if WEBISH_RE.search(entry):
        item["found"] = None
        item["skipped"] = "web"          # 웹페이지 인용 — 애초에 DOI가 없다
        return item

    cands, ok = crossref_search(entry, 3, use_cache)
    if not ok:
        item["found"] = None
        item["skipped"] = "error"        # 일시적 실패 — '못 찾음'과 구별
        return item

    best = None
    for cand in cands:
        sc = score_candidate(entry, cand)
        if sc["level"] == "none":
            continue
        if best is None or sc["title_ratio"] > best["score"]["title_ratio"]:
            best = {
                "doi": cand.get("DOI", ""),
                "title": csl_title(cand),
                "authors": csl_authors(cand),
                "year": csl_year(cand),
                "container": csl_container(cand),
                "score": sc,
            }
        if sc["level"] == "high":
            break
    item["found"] = best
    return item


def check_one(item: dict, want_bib: bool, use_cache: bool, want_suggest: bool = False) -> dict:
    doi = item["doi"]
    status, body = fetch(doi, "csl", use_cache)
    if status != 200:
        item["status"] = status
        note = ("doi.org에서 해석되지 않음 (오타이거나 등록되지 않은 DOI)"
                if status == 404 else "메타데이터를 가져오지 못함")
        if status == 404 and want_suggest:
            sg = suggest_doi(item["entry"])
            if sg and sg["doi"]:
                item["suggestion"] = sg
                note += f"  ▸ 후보: {sg['doi']} — {sg['title'][:90]}"
        item["issues"] = [{
            "field": "doi", "severity": "error", "pdf": doi,
            "doi": f"HTTP {status}", "note": note,
        }]
        return item
    try:
        csl = json.loads(body)
    except json.JSONDecodeError:
        item["status"] = status
        item["issues"] = [{"field": "doi", "severity": "error", "pdf": doi,
                           "doi": "(파싱 실패)", "note": body[:120]}]
        return item

    item["status"] = 200
    item["csl"] = {
        "title": csl_title(csl), "authors": csl_authors(csl), "year": csl_year(csl),
        "container": csl_container(csl), "volume": clean(csl.get("volume", "")),
        "issue": clean(csl.get("issue", "")), "pages": clean(csl.get("page", "")),
        "type": csl.get("type", ""),
    }
    item["issues"] = compare(item["entry"], csl)
    if want_bib and item["issues"]:
        s, b = fetch(doi, "bib", use_cache)
        item["bibtex"] = b.strip() if s == 200 else None
    return item


def main() -> int:
    ap = argparse.ArgumentParser(
        description="논문 PDF의 참고문헌 DOI를 doi.org 공식 메타데이터와 대조합니다."
    )
    ap.add_argument("pdf", help="검사할 PDF 경로")
    ap.add_argument("--all", action="store_true", help="이상 없는 항목도 모두 출력")
    ap.add_argument("--bibtex", action="store_true", help="문제 항목의 공식 BibTeX 출력")
    ap.add_argument("--json", metavar="FILE", help="결과를 JSON으로 저장")
    ap.add_argument("--workers", type=int, default=6, help="동시 요청 수 (기본 6)")
    ap.add_argument("--errors-only", action="store_true", help="error 등급만 보고")
    ap.add_argument("--no-cache", action="store_true", help="캐시 무시하고 새로 요청")
    ap.add_argument("--suggest", action="store_true",
                    help="해석 안 되는 DOI는 Crossref 검색으로 올바른 DOI 후보를 제안")
    ap.add_argument("--find-missing", action="store_true",
                    help="DOI가 없는 참고문헌을 Crossref 서지검색으로 찾아 DOI를 제안")
    ap.add_argument("--list-nodoi", action="store_true", help="DOI 없는 참고문헌 목록도 출력")
    ap.add_argument("--dump-refs", metavar="FILE", help="파싱된 참고문헌 원문을 저장(디버깅)")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    c = C(sys.stdout.isatty() and not args.no_color)

    if not os.path.exists(args.pdf):
        print(f"파일을 찾을 수 없습니다: {args.pdf}", file=sys.stderr)
        return 2

    text = strip_running_heads(extract_text(args.pdf))
    hints = hyphen_hints(slice_references(extract_text(args.pdf, layout=True)))
    refs_text = slice_references(text)
    entries = split_entries(refs_text)

    if args.dump_refs:
        with open(args.dump_refs, "w", encoding="utf-8") as f:
            for label, body in entries:
                f.write(f"[{label}] {body}\n\n")

    if not entries:
        print("참고문헌 항목을 찾지 못했습니다. --dump-refs 로 추출 결과를 확인해 보세요.",
              file=sys.stderr)
        return 2

    with_doi, without_doi = [], []
    for label, body in entries:
        doi = extract_doi(body)
        if doi:
            fixed = repair_doi(doi, hints)
            item = {"label": label, "doi": fixed, "entry": body}
            if fixed != doi:
                # 추출 과정에서 깨졌던 DOI — 원문에는 하이픈이 살아 있음
                item["doi_as_extracted"] = doi
            with_doi.append(item)
        else:
            without_doi.append({"label": label, "doi": None, "entry": body})

    print(f"{c.B}{os.path.basename(args.pdf)}{c.X}  "
          f"참고문헌 {len(entries)}건 · DOI 있음 {len(with_doi)}건 · "
          f"DOI 없음 {len(without_doi)}건")
    if not with_doi:
        print("DOI가 달린 참고문헌이 없습니다.")
        return 0
    print(f"{c.D}doi.org 조회 중...{c.X}", file=sys.stderr)

    results = []
    with futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        fs = {ex.submit(check_one, it, args.bibtex, not args.no_cache, args.suggest): it
              for it in with_doi}
        for fut in futures.as_completed(fs):
            results.append(fut.result())
    results.sort(key=lambda r: (len(r["label"]), r["label"]))

    n_bad = n_err = 0
    for r in results:
        issues = r.get("issues", [])
        if args.errors_only:
            issues = [i for i in issues if i["severity"] == "error"]
        has_err = any(i["severity"] == "error" for i in issues)
        n_err += has_err
        if issues:
            n_bad += 1
        elif not args.all:
            continue

        mark = f"{c.R}✗{c.X}" if has_err else (f"{c.Y}⚠{c.X}" if issues else f"{c.G}✓{c.X}")
        rep = (f" {c.D}(추출된 문자열 {r['doi_as_extracted']} → 줄바꿈 하이픈 복원){c.X}"
               if r.get("doi_as_extracted") else "")
        print(f"\n{mark} {c.B}[{r['label']}]{c.X} {c.D}{r['doi']}{c.X}{rep}")
        print(f"   {c.D}PDF:{c.X} {shorten(r['entry'], 300)}")
        for i in issues:
            col = c.R if i["severity"] == "error" else c.Y
            print(f"   {col}• {i['field']}{c.X}")
            print(f"       PDF : {shorten(i['pdf'], 220) or '(없음)'}")
            print(f"       DOI : {shorten(i['doi'], 220)}")
            if i["note"]:
                print(f"       {c.D}{shorten(i['note'], 260)}{c.X}")
        if args.bibtex and r.get("bibtex"):
            print(f"   {c.D}공식 BibTeX:{c.X}")
            for line in r["bibtex"].splitlines():
                print("       " + line)

    print(f"\n{c.B}요약{c.X}: 검사 {len(results)}건 · 문제 {n_bad}건 "
          f"({c.R}error {n_err}{c.X} / {c.Y}warn {n_bad - n_err}{c.X}) · "
          f"이상 없음 {len(results) - n_bad}건")

    found_results = []
    if args.find_missing and without_doi:
        print(f"\n{c.D}DOI 없는 {len(without_doi)}건을 Crossref에서 검색 중...{c.X}",
              file=sys.stderr)
        # 검색은 요청 수가 많아 동시 실행을 더 낮춘다 (429 방지)
        with futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 4))) as ex:
            fs = [ex.submit(find_one, it, not args.no_cache) for it in without_doi]
            for fut in futures.as_completed(fs):
                found_results.append(fut.result())
        found_results.sort(key=lambda r: (len(r["label"]), r["label"]))

        hi = [r for r in found_results if r.get("found") and r["found"]["score"]["level"] == "high"]
        mid = [r for r in found_results if r.get("found") and r["found"]["score"]["level"] == "medium"]
        web = [r for r in found_results if r.get("skipped") == "web"]
        failed = [r for r in found_results if r.get("skipped") == "error"]

        print(f"\n{c.B}DOI 없는 항목 {len(without_doi)}건 검색 결과{c.X}: "
              f"{c.G}확실 {len(hi)}{c.X} / {c.Y}추정 {len(mid)}{c.X} / "
              f"못 찾음 {len(found_results) - len(hi) - len(mid) - len(web) - len(failed)} / "
              f"{c.D}웹페이지라 건너뜀 {len(web)}{c.X}"
              + (f" / {c.R}검색 실패 {len(failed)}{c.X}" if failed else ""))
        if failed:
            print(f"   {c.R}Crossref 검색이 실패한 항목{c.X} (일시적일 수 있으니 --workers 를 줄여 다시 시도): "
                  + " ".join(f"[{r['label']}]" for r in failed))

        for r in hi + mid:
            f = r["found"]
            sc = f["score"]
            col = c.G if sc["level"] == "high" else c.Y
            tag = "확실" if sc["level"] == "high" else "추정"
            print(f"\n{col}＋{c.X} {c.B}[{r['label']}]{c.X} {col}{f['doi']}{c.X} {c.D}({tag}){c.X}")
            print(f"   {c.D}PDF     :{c.X} {shorten(r['entry'], 220)}")
            byline = ", ".join(f["authors"][:4]) + (" 외" if len(f["authors"]) > 4 else "")
            print(f"   {c.D}Crossref:{c.X} {shorten(f['title'], 200)}")
            print(f"             {shorten(byline, 120)} · {f['container'] or '?'} · {f['year'] or '?'}")
            print(f"   {c.D}근거: 제목 유사도 {sc['title_ratio']} · "
                  f"저자 일치 {int(sc['author_hit'] * 100)}% ({sc['n_authors']}명 기준) · "
                  f"연도 {sc['year']}{c.X}")

    if args.list_nodoi and without_doi:
        print(f"\n{c.B}DOI가 없어 검사하지 못한 항목 {len(without_doi)}건{c.X}")
        for it in without_doi:
            print(f"   [{it['label']}] {shorten(it['entry'], 160)}")

    if args.json:
        payload = {
            "pdf": os.path.abspath(args.pdf),
            "total_references": len(entries),
            "checked": [
                {k: v for k, v in r.items() if k != "entry"} | {"entry": r["entry"]}
                for r in results
            ],
            "without_doi": found_results or without_doi,
        }
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"{c.D}JSON 저장: {args.json}{c.X}")

    return 1 if n_err else 0


def shorten(s: str, n: int) -> str:
    s = clean(s)
    return s if len(s) <= n else s[: n - 1] + "…"


if __name__ == "__main__":
    sys.exit(main())
