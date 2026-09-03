# pdf-doi-checker

논문 PDF의 **참고문헌(References)** 에서 DOI가 붙은 항목을 찾아,
`doi.org`가 돌려주는 **공식 서지정보(BibTeX / CSL-JSON)** 와 대조하고
다른 점만 골라서 알려줍니다.

- **웹**: <https://refs.ysw.kr> — 서버 없이 브라우저에서만 동작
- **CLI**: `python3 doi_check.py paper.pdf`

둘은 같은 판정 로직을 씁니다 (같은 PDF에서 결과가 완전히 일치하는지 검증했습니다).

## 웹 버전 (`docs/`)

GitHub Pages용 정적 페이지입니다. 빌드 단계가 없습니다.

- PDF는 **브라우저 밖으로 나가지 않습니다.** `pdf.js`로 로컬에서 파싱하고,
  네트워크로 나가는 것은 DOI 문자열과 검색어뿐입니다.
- 언어는 브라우저 설정을 따라 영어/한국어가 자동으로 잡히고, 우상단에서 바꿀 수 있습니다.
- 결과는 `[1]`부터 끝까지 한 줄기로 세우고, 손볼 것 없는 구간은 diff처럼
  중략 띠로 접습니다. 요약의 갈래(칩)를 누르면 그 갈래만 걸러 봅니다.
- `pdf.js`는 `docs/vendor/pdfjs/`에 포함돼 있어 CDN 의존성이 없습니다.

### 배포

1. 저장소 Settings → Pages → Source: `main` 브랜치의 `/docs` 폴더
2. 커스텀 도메인은 `docs/CNAME`에 이미 `refs.ysw.kr`이 들어 있습니다.
   DNS에 `refs` → `<사용자명>.github.io` **CNAME 레코드**를 추가하세요.
3. Pages 설정에서 *Enforce HTTPS* 체크

로컬 확인:

```
cd docs && python3 -m http.server 8000
```

`file://`로 직접 열면 doi.org 리다이렉트 단계에서 CORS에 걸릴 수 있으니
http로 띄워서 보세요.

### 왜 서버가 필요 없나

`doi.org`가 브라우저 요청에 CORS 헤더를 돌려줍니다.

```
GET https://doi.org/10.1145/3173574.3174119   (Accept: ...csl+json)
  → 302  access-control-allow-origin: <요청 Origin>
  → 200  access-control-allow-origin: *        (api.crossref.org)
```

`Accept`는 CORS 안전목록 헤더라 프리플라이트도 붙지 않습니다.
Crossref·DataCite 등 등록기관을 가리지 않고 동작합니다.

## CLI

```
python3 doi_check.py paper.pdf
```

## 무엇을 잡아주나

| 항목 | 등급 | 내용 |
|---|---|---|
| `doi` | error | doi.org에서 해석되지 않는 DOI (오타·미등록) |
| `title` | error | 제목 불일치 — DOI가 아예 다른 논문을 가리키는 경우 포함 |
| `authors` | error | 빠진 저자, 저자 수 불일치 |
| `year` | error/warn | 출판 연도 불일치 (±1년은 online-first 가능성이 있어 warn) |
| `venue` | warn | 학회/저널명 불일치 |
| `volume` `issue` `pages` | warn | 권·호·쪽수 불일치 |

제목/저자/게재처 비교는 악센트·구두점·대소문자·하이픈을 정규화한 뒤 비교하므로
`Perspective-Taking` vs `PerspectiveTaking`, `Comput. Surveys` vs `ACM Computing Surveys`
같은 표기 차이는 오탐으로 잡지 않습니다.

## 옵션

```
--all           이상 없는 항목까지 전부 출력
--errors-only   error 등급만 (warn 무시)
--bibtex        문제가 있는 항목의 공식 BibTeX를 함께 출력 (그대로 복붙 가능)
--json FILE     결과를 JSON으로 저장
--suggest       해석 안 되는 DOI를 Crossref 서지검색으로 올바른 후보 제안
--find-missing  DOI가 아예 없는 참고문헌을 Crossref에서 찾아 DOI를 제안
--list-nodoi    DOI가 없어 검사하지 못한 항목 목록
--dump-refs F   파싱된 참고문헌 원문 저장 (파싱이 이상할 때 확인용)
--workers N     동시 요청 수 (기본 6)
--no-cache      캐시 무시하고 다시 요청
```

종료 코드: error가 하나라도 있으면 `1`, 아니면 `0` (CI에 걸기 좋음).

## CLI 요구사항

표준 라이브러리만 사용합니다. 텍스트 추출만 외부 도구가 필요합니다.

```
brew install poppler      # pdftotext — 권장
# 또는
pip install pypdf         # 폴백
```

`pdftotext`는 2단 조판을 읽기 순서대로 풀어주는 기본 모드와, 줄바꿈 하이픈이
보존되는 `-layout` 모드를 **둘 다** 돌려서, 하이픈이 지워져 깨진 DOI
(`10.1007/s10869-0149384-3` → `10.1007/s10869-014-9384-3`)를 복원합니다.

웹 버전은 `pdf.js`에서 글자 좌표를 직접 받아 단 분리와 하이픈 처리를 직접 하므로
이 복원 과정 자체가 필요 없습니다.

## 캐시 / 매너

- 응답은 `~/.cache/doi-check/`에 캐시됩니다 (`DOI_CHECK_CACHE`로 변경).
- `DOI_CHECK_MAILTO=you@example.com`을 설정하면 User-Agent에 연락처가 붙어
  Crossref의 polite pool을 쓰게 됩니다. 대량으로 돌릴 때 권장.

## DOI가 없는 참고문헌 (`--find-missing`)

세 곳을 순서대로 훑습니다. 앞에서 찾으면 뒤는 건너뜁니다.

1. **Crossref** — 참고문헌 원문을 통째로 `query.bibliographic`에 넣어 검색
2. **arXiv** — 원문에 `arXiv:1706.03762` 같은 ID가 적혀 있으면 검색할 것 없이
   `10.48550/arXiv.<id>`를 직접 만들어 확인. 정식 출판본이 있으면 그쪽이 나으므로
   Crossref를 먼저 봅니다
3. **OpenAlex** — Crossref 색인에 없는 학술서 챕터 등을 덮습니다.
   OpenAlex는 **doi.org에 등록되지 않은 DOI도 들고 있어서**(출판사 사이트에는
   그 경로로 글이 있지만 DOI 등록은 안 된 경우) 해석되는 것만 채택하고
   공식 기록으로 다시 채점합니다

어느 쪽이든 결과를 그대로 믿지 않고 **제목 유사도 · 저자 일치율 · 연도**로
다시 채점해 확신도를 나눕니다.

- `확실` — 제목 0.90 이상 + 저자 절반 이상 일치 + 연도 어긋나지 않음
- `추정` — 그보다 약함. **연도만 다른 경우**(프리프린트가 나중에 학회에 실림),
  **저자만 어긋나는 경우**(공식 BibTeX가 저자를 기관명으로 적는 경우)가 여기 걸립니다
- 나머지는 보고하지 않음. `Retrieved ... from http...` 형태의 웹페이지 인용은
  애초에 DOI가 없으므로 검색을 건너뜁니다

Crossref 기록에 **저자가 아예 없는 경우**(학술서 챕터에 흔합니다)는 감점하지 않고
중립으로 두되, 대신 제목·연도 기준을 올립니다.

확신도 근거(유사도 수치)를 항상 같이 출력하니 눈으로 확인하고 넣으세요.

### 브라우저에서 쓸 수 있는 소스

정적 페이지라 CORS가 열린 곳만 쓸 수 있습니다.

| | CORS | 비고 |
|---|---|---|
| doi.org / Crossref | ✓ | 기본 |
| OpenAlex | ✓ | 3차 폴백. `search=`는 전문 검색이라 `title.search`를 씁니다 |
| DBLP | ✓ | 커버리지가 겹쳐 보류 |
| DataCite | ✗ | arXiv·Zenodo는 doi.org로 이미 커버됩니다 |
| Semantic Scholar | ✗ | |

## 요청 빈도

Crossref가 응답 헤더로 알려주는 상한(2026-09 실측)에 맞춰 간격을 벌립니다.

| | 공개 풀 | polite (`mailto`) |
|---|---|---|
| 검색 `/works?query...` | 1 req/s | 3 req/s |
| DOI `/works/{doi}/transform` | 5 req/s | |

이 헤더는 `access-control-expose-headers`에 없어 브라우저가 읽을 수 없으므로
값을 코드에 박아 두었습니다. 웹 버전은 공개 풀 기준으로 돕니다
(실측: 원고 두 편에서 26초 · 163초). CLI는 `DOI_CHECK_MAILTO`를 설정하면
검색이 3 req/s로 올라갑니다.

## 페이지 머리글 제거

2단 조판 논문은 `CHI '25, April 26–May 01, 2025, Yokohama, Japan` 같은 러닝헤드가
참고문헌 항목 한가운데로 끼어듭니다. 문서 전체에서 4번 이상 반복되는 줄을
머리글/바닥글로 보고 제거한 뒤 파싱합니다.

## 참고문헌 형식

`[12] ...` 대괄호 번호, `12. ...` 점 번호, 그리고 빈 줄 구분 문단을 지원합니다.
저자/연도/제목 분해는 `저자들. 연도. 제목. 게재처 ...` (ACM/APA 계열) 기준입니다.
다른 형식이면 제목·저자 비교 정확도가 떨어질 수 있으니 `--dump-refs`로 먼저 확인하세요.
