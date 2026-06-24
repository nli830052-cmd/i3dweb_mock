# RAG 챗봇 답변 생성 방법론 — 질문 1~5번 전 과정 해부

> **목적**: 발표용. `docs/시연_시뮬레이션_스크립트.md` Part B의 1~5번 질문에 대해
> **사용자 입력 → 분류 → 데이터(DB/벡터) 조회 → LLM 종합 → 화면 렌더링**까지
> 실제 코드(파일·함수)와 DB(테이블·레코드)를 모두 추적해 "한 줄도 빠짐없이" 정리한 문서입니다.
>
> 다루는 질문(시연 스크립트 Part B 기준):
> 1. **설비 찾기** — 뷰어 조작(`ACTION`)
> 2. **작업 위치 안내** — 뷰어 조작(`ACTION`)
> 3. **정비 이력** — CMMS 정비이력 DB 기반 근거 답변(`ANSWER`, grounded)
> 4. **정비 주기** — CMMS 정비주기 DB + 동적 계산(`ANSWER`, grounded)
> 5. **작업 조건** — Walkinside 공간데이터 기반 근거 답변(`ANSWER`, grounded·솔루션팀)

---

## 0. 전체 아키텍처 — 3계층 + 2팀

```
┌──────────────────────── 브라우저 (Frontend) ─────────────────────────┐
│  index.html                                                          │
│   ├─ src/ui/app.js            진입점·렌더링·API 흐름 패널             │
│   ├─ src/ai/classifier.js     AI 백엔드 stand-in (라우팅 두뇌)        │
│   ├─ src/ai/ragClient.js      RAG 서버 fetch 클라이언트              │
│   ├─ src/ai/maintenanceDb.js  CMMS mock + SQLite 동기화 폴백          │
│   └─ src/viewer/mockViewer.js 뷰어 SDK stand-in (솔루션팀 영역)       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP (fetch, localhost:8090)
┌──────────────────────────────▼──────────────────────────────────────┐
│  backend/rag_server.py  (Python stdlib http.server)                  │
│   ├─ /api/ai/chat    LLM+RAG+DB 통합(5단 구조) ← 질문 3·4·5번         │
│   ├─ /api/rag/answer 매뉴얼 벡터검색 + LLM 종합                       │
│   ├─ /api/ai/plan    규칙 미매칭 시 LLM이 action JSON 생성            │
│   └─ /api/db/*/all   SQLite 덤프(프런트 동기화용)                     │
└───────────┬───────────────────────────────┬──────────────────────────┘
            │                               │
   ┌────────▼─────────┐           ┌─────────▼──────────┐
   │ data/app.db      │           │ data/manual_index  │
   │ (SQLite 정형DB)  │           │ .npy + .meta.json  │
   │ maintenance      │           │ (bge-m3 벡터 100청크)│
   │ spatial          │           └─────────▲──────────┘
   │ workflow         │                     │ Ollama qwen3.5:9b
   └────────▲─────────┘                     │ (로컬 LLM)
            │ build_db.py                    │ ingest_manuals.py
        [오프라인 시드]                  [오프라인 인덱싱]
```

**팀 소유권(흐름 패널에서 색으로 구분)**
- **AI팀**: 질문 분류, 매뉴얼 RAG, CMMS DB(정비이력·주기), 작업오더(WO), LLM 생성
- **솔루션팀**: i3DWEB 뷰어 SDK 조작, Walkinside 공간데이터

---

## 0.1 사전 준비 — 오프라인 파이프라인 (질문 들어오기 전에 끝나 있어야 함)

발표 시 "데이터는 미리 어떻게 준비되는가"를 보여주는 단계입니다.

### (A) 정형 데이터 시드 — `scripts/build_db.py` → `data/app.db`
하드코딩 mock을 SQLite 3개 테이블로 적재합니다.

- `maintenance` (정비이력·주기) — `build_db.py:95`
- `spatial` (공간·고소·추락) — `build_db.py:100`
- `workflow` (작업단계·체크리스트) — `build_db.py:103`

중첩 필드(history/leaks/openPoints 등)는 **JSON 문자열**로 직렬화해 1컬럼에 저장합니다(`build_db.py:84` `J()`).

```python
# build_db.py:108  GV-101A 1행 적재
cur.execute("INSERT INTO maintenance VALUES (?,?,?,...)", (
    tag, r["name"], r["cycleMonths"], r["lastMaintenance"], r["nextDue"],
    r["inspectionResult"], r["recurring"], J(r["history"]), J(r["lastOverhaul"]),
    J(r["bonnetGasket"]), J(r["leaks"]), J(r["openPoints"]), J(r["priorityParts"])))
```

실행: `python scripts/build_db.py` → `maintenance 3 / spatial 4 / workflow 2 rows`

### (B) 매뉴얼 인덱싱 — `ingest_manuals.py` → `search_manuals.py`
RAG 3단계 중 **1단계(파싱·청킹)** 와 **검색 인덱스**를 만듭니다.

1. **파싱·청킹** (`ingest_manuals.py`)
   - PyMuPDF로 PDF 텍스트 추출(`extract_items`, line 68)
   - 번호 체계(`8.1.1`)로 섹션 분리(`HEADING` 정규식, line 24)
   - 섹션 경로(빵부스러기) 부착 + valve_type 메타(line 26)
   - 작은 청크 병합 / 큰 청크 오버랩 분할(MIN 200·MAX 900·OVERLAP 80자, line 20~22)
   - 보충 `.md`(추가지침)는 `#~###` 헤딩 단위로 청킹(`process_md`, line 155)
   - 결과 → `data/manual_chunks.json`
2. **임베딩**: 각 청크를 `BAAI/bge-m3`로 벡터화 → `data/manual_index.npy`(정규화된 벡터) + `.meta.json`(원문·메타)
3. 서버 기동 시 메모리 로드(`rag_server.py:699 _ensure_loaded`) → 콘솔 `준비 완료: 100청크`

> **핵심**: 매뉴얼 답변의 "근거"는 이 인덱스에서만 나옵니다. 발췌에 없으면
> LLM이 "지침서에서 확인되지 않습니다"로 폴백 → **환각 차단**(`rag_server.py:182`).

---

## 0.2 공통 요청 흐름 — 5개 질문 모두 거치는 7단계

세부 질문으로 들어가기 전, **모든 질문이 공유하는 골격**입니다. (코드: `src/ui/app.js`)

| 단계 | 위치 | 하는 일 |
|---|---|---|
| ① 입력 캡처 | `app.js:27 onSend()` | 입력창 텍스트 읽고 `addUserMsg`로 사용자 말풍선 렌더 |
| ② 요청 객체 구성 | `app.js:35` | `{sessionId, message, viewerContext:{currentTag}}` |
| ③ 흐름 패널 기록 | `app.js:40 pushFlow` | "AI팀 · 요청 · HTTP POST /api/ai/chat" 타임라인 추가 |
| ④ AI 백엔드 호출 | `app.js:44` | `AiBackend.requestAiResponse(request)` (classifier.js) |
| ⑤ 라우팅·조회 | `classifier.js:355` | 아래 "라우팅 우선순위" 로직으로 응답 JSON 생성 |
| ⑥ 응답 분기 | `app.js:101 handleResponse` | `responseType`에 따라 액션 실행 or 답변만 렌더 |
| ⑦ 렌더링 | `app.js:154 renderChat` | 판정/데이터블록/종합답변/권고/근거칩/매뉴얼발췌 5층 카드 |

### 라우팅 우선순위 (두뇌: `classifier.js:355 requestAiResponse`)
이 순서가 **질문 1~5번이 어디로 갈지** 결정합니다.

```
0. simulateError 옵션? → HTTP 500 던지기 (에러 시연용)
1. isGroundedQuery(text)? ── 이력/주기/공간/단계/매뉴얼 질의
      → RagClient.chat() → 서버 /api/ai/chat (5단 구조 답변)   ★ 질문 3·4·5번
2. isManualQuery(text)?  ── 절차/방법/기준/지침 …
      → RagClient.answer() → 서버 /api/rag/answer (매뉴얼 RAG)
3. classifyRuleBased(request) ── 규칙 기반 빠른 분류           ★ 질문 1·2번
      _fallback 아니면 즉시 반환 (ACTION 등)
4. (규칙도 못 잡음) RagClient.plan() ── LLM이 action JSON 직접 생성
5. 그래도 안 되면 규칙 폴백 결과 반환
```

- 판별 함수: `isGroundedQuery`(line 347) = `isManualQuery ∨ isWorkConditionQuery ∨ isStageQuery ∨ isCycleQuery ∨ isMaintenanceQuery`
- **서버(Ollama)가 꺼져 있으면** 1·2번 try/catch가 실패 → 3번 규칙 기반으로 자동 폴백
  → 질문 3·4·5번도 `buildMaintenanceAnswer` 등 **브라우저 내 mock**으로 똑같이 답변(라이브 리스크 대비).

---

# 질문 1번 — 설비 찾기 (뷰어 조작 · `ACTION`)

🗣️ 사용자: **"터빈 윤활유 펌프 찾아줘"**

### 1단계. 입력·요청 (`app.js:27~40`)
```js
const request = {
  sessionId: "sess-xxxxxx",
  message: "터빈 윤활유 펌프 찾아줘",
  viewerContext: { currentTag: null }   // 아무것도 선택 안 한 상태
};
```

### 2단계. 라우팅 판별 (`classifier.js:355`)
- `isGroundedQuery("터빈 윤활유 펌프 찾아줘")` → **false** (이력/주기/공간/단계/매뉴얼 신호 없음)
- `isManualQuery` → **false** (절차/방법/기준 없음)
- → **3번 경로** `classifyRuleBased(request)` 진입

### 3단계. 규칙 매칭 (`classifier.js:39 classifyRuleBased`)
- `extractTag` → 태그 없음(`null`), `detectType("…펌프…")` → `{code:"PUMP", ko:"펌프"}`
- 규칙 1~5(숨김/표시/격리/필터/회전) 미매칭
- **규칙 6 검색** 매칭 (`classifier.js:79`):
```js
if (has(text, ["찾아", "검색"]) && !tag) {
  const query = text.replace(/(찾아\S*|검색\S*|…|줘|해줘|…)/g, "").trim()
              || (type && type.ko) || text;            // → "터빈 윤활유 펌프"
  return mkAction("SEARCH_EQUIPMENT",
    action({ type: "SEARCH_EQUIPMENT", query: query }),
    `"${query}" 설비를 검색합니다. 가장 가까운 설비로 이동하고 속성정보를 표시합니다.`);
}
```
- `mkAction`(line 157)이 응답 객체를 만듦:
```json
{ "responseType": "ACTION",
  "message": "\"터빈 윤활유 펌프\" 설비를 검색합니다. …",
  "actions": [{ "type": "SEARCH_EQUIPMENT", "query": "터빈 윤활유 펌프", "params": {} }],
  "confidence": 0.93 }
```
- `_fallback` 플래그가 없으므로 `requestAiResponse`가 **즉시 반환**(line 386). LLM·DB 호출 없음.

### 4단계. 응답 분기 → 액션 실행 (`app.js:101 → 119 runActions`)
- `responseType === "ACTION"` → `runActions(res)`
- 각 액션을 **뷰어 SDK 호출 표현**으로 변환(`ActionExecutor.describe`) 후
  흐름 패널에 "솔루션팀 · 요청 · Viewer SDK"로 기록(`app.js:128`)
- `ActionExecutor.executeAction(action)` 실행 → `mockViewer`가 검색/이동/하이라이트 수행
- 콜백 결과를 "솔루션팀 · 응답 · SDK"로 기록(`app.js:138`)

### 5단계. 렌더링 (`app.js:154 renderChat`)
- `categoryOf`(line 173): `responseType==="ACTION"` → `{key:"action", label:"뷰어 조작"}`
- 카드에 `message`와 액션 칩(`detailBlock`, line 236) 표시. (grounded 아님 → 근거칩 없음)

**요약**: 자연어 → 정형 JSON Action → 뷰어 SDK 디스패치. **느슨한 결합**이라 LLM/SDK를 바꿔도 독립적.
> ⚠️ 라이브 주의: `SEARCH_EQUIPMENT`가 반환하는 `TG-LOP-001` 등은 mockViewer에 시드 안 됨 → 동작은 일반 메시지. 시각효과는 `이 장비 뒷면 보여줘`(ROTATE) 류로 시연.

---

# 질문 2번 — 작업 위치 안내 (뷰어 조작 · `ACTION`)

🗣️ 사용자: **"TG-BRG-002 위치로 안내해줘"**

### 1~2단계. 요청·라우팅
- `viewerContext.currentTag` 그대로, `isGroundedQuery` → false, `isManualQuery` → false
- → `classifyRuleBased` 진입

### 3단계. 규칙 매칭 (`classifier.js:31 extractTag` → 규칙 7)
- `TAG_RE`(line 17) 정규식 `\b[A-Z]{1,5}(?:-[A-Z0-9]{1,5}){1,2}\b`로 `"TG-BRG-002"` 추출
- 작업위치 규칙(b~f, line 98~126) 중 "점검 순서/가까운/점검자/이동/경로"는 미매칭
- **규칙 7 이동** 매칭 (`classifier.js:149`):
```js
if (tag && has(text, ["이동","가줘","가자","안내","위치","찾아","보여","데려"])) {
  return mkAction("JUMP_TO",
    action({ type:"JUMP_TO", targetType:"TAG", targetValue:tag }),
    `${tag} 위치를 찾았습니다. 현재 화면을 해당 설비 위치로 이동하고 강조 표시합니다.`);
}
```
응답:
```json
{ "responseType":"ACTION",
  "actions":[{ "type":"JUMP_TO", "targetType":"TAG", "targetValue":"TG-BRG-002", "params":{} }],
  "confidence":0.93 }
```

### 4~5단계. 액션 실행·렌더
- `runActions` → `JUMP_TO` → mockViewer 카메라 이동 + 하이라이트
- `TG-BRG-002`는 **KNOWN_TAGS에 시드되어 있어** 라이브에서 실제 이동까지 보임(질문리스트 Tier 3 ✅).

> **변형 시연**: "이 설비 점검 위치로 이동해줘"(태그 없음) → 규칙 (e) `MOVE_TO_INSPECTION`(line 113).
> "오늘 점검 순서대로" → 규칙 (b) `SHOW_INSPECTION_ROUTE`. "비상 탈출 경로" → 규칙 (f) `SHOW_PATH{target:"EMERGENCY_EXIT"}`.

**질문 1·2번 공통 결론**: DB·LLM을 거치지 않는 **규칙 기반 즉답**. responseType=`ACTION`. 답변 텍스트는 규칙이 생성, 실제 동작은 솔루션팀 뷰어 SDK가 수행.

---

# 질문 3번 — 정비 이력 (CMMS DB 근거 답변 · `ANSWER` grounded)

🗣️ 사용자: **"이 밸브의 최근 정비 이력 보여줘"** (대상: GV-101A)

여기서부터 **RAG 5단 구조**(판정→데이터→종합→권고→근거)가 발동합니다.

### 1단계. 요청 (`app.js:35`)
```js
{ sessionId:"sess-xxxxx", message:"이 밸브의 최근 정비 이력 보여줘",
  viewerContext:{ currentTag:null } }   // 미선택 → 뒤에서 GV-101A 기본값
```

### 2단계. 라우팅 → 통합 챗 (`classifier.js:362`)
- `isMaintenanceQuery`(line 162): `text.includes("이력")` → **true** → `isGroundedQuery` true
```js
if (isGroundedQuery(request.message)) {
  const ctx = request.viewerContext && request.viewerContext.currentTag;   // null
  const r = await window.RagClient.chat(request.message, ctx, request.sessionId);
  if (r && (r.grounded || r.category === "manual")) return adaptChat(r);
}
```
- `RagClient.chat`(`ragClient.js:41`) → `POST http://localhost:8090/api/ai/chat`
  body `{message, currentTag:undefined, sessionId}`

### 3단계. 서버 분류 (`rag_server.py:763 → 570 make_chat`)
- `tag = currentTag or "GV-101A"`(line 571) → **GV-101A** (미선택 시 기본 대상)
- `classify_question`(line 199) 실행:
  - "이력" 포함 → `category="maintenance"`(line 231)
  - 세부 분기: 가스켓?no 반복?no 점검결과?no openpoint?no 누설?no 분해/마지막?no
    → **`sub="history"`**, `manual_query="정비기록 작성 항목"`, `valve="globe"`(line 244)

### 4단계. DB 사실 조회 (`rag_server.py:599 chat_db_facts → 658 db_maintenance_all`)
```python
def db_maintenance_all():            # SQLite 직접 조회
    for r in _db_rows("maintenance"):    # SELECT * FROM maintenance
        out[r["tag"]] = {
            "history": _jl(r["history"]),         # JSON 문자열 → 객체 역직렬화
            "lastOverhaul": _jl(r["last_overhaul"]),
            "leaks": _jl(r["leaks"]), "openPoints": _jl(r["open_points"]),
            "recurring": r["recurring"], "inspectionResult": r["inspection_result"],
            ... }
```
→ GV-101A 레코드(실데이터, `build_db.py:16`에서 시드):
```json
{ "tag":"GV-101A", "name":"글로브 밸브",
  "history":[
    {"date":"2025-11-14","wo":"WO-2025-1114","type":"그랜드패킹부 재점검","result":"조건부 정상","note":"패킹부 미세 비침 관찰"},
    {"date":"2025-08-02","wo":"WO-2025-0802","type":"그랜드패킹부 누설 점검","result":"추적 관찰 필요", ...},
    {"date":"2025-03-21","wo":"WO-2025-0321","type":"분해정비","result":"정상", ...} ],
  "leaks":[{"date":"2025-08-02","part":"그랜드패킹",...}],
  "openPoints":[{"id":"OP-2025-114","due":"2026-06-26","linkedWo":"WO-2026-0612",...}],
  "recurring":"그랜드패킹부 누설 (최근 12개월 내 동일 부위 2회 …)", ... }
```

### 5단계. 매뉴얼 RAG 검색 — 근거 확보 (`rag_server.py:600~603`)
```python
vecs, meta = _ensure_loaded()                         # bge-m3 벡터 인덱스
hits = sm.search(manual_query, vecs, meta, valve_type="globe", top_k=10, min_score=0.30)
rag_hits = [h for h in hits if h[1]["doc"] == RAG_DOC] # 보충본(추가지침)만
hits = (rag_hits or hits)[:1]                          # 근거 매뉴얼 1개만 인용
```
- `search_manuals.py:32`: 쿼리("정비기록 작성 항목")를 bge-m3로 임베딩 →
  `sims = vecs @ q`(정규화돼 있어 내적=코사인) → 내림차순 정렬 → `min_score 0.30` 게이트 → 상위 청크
- 결과로 `절차-표준-018 추가지침 §20(정비기록 작성)` 류 청크 1개를 근거로 확보

### 6단계. 답변 종합 — 템플릿 + LLM (`rag_server.py:611~623`)
1. **결정적 폴백 먼저**(`chat_template`, line 285): DB 사실로 headline/answer/recommendation 생성
   - maintenance·history → "최근 1년 내 그랜드패킹부 누설·재점검 반복… 조건부 관리 대상"(line 320)
2. **구조화 블록**(`build_blocks`, line 381): 화면 표/리스트용
   - history → "최근 정비 이력(최신순)" ordered 리스트, 각 항목 date·wo·작업내용·판정·확인(line 443)
3. **LLM 종합 시도**(line 614): Ollama qwen3.5:9b에 `build_chat_synthesis_prompt`(line 559)
   - 프롬프트 핵심: *"[설비 데이터]와 [매뉴얼 발췌]만 근거로, 데이터 나열 금지·해석/판단 위주, JSON 1개만 출력"*
   - 성공 시 `headline/answer/recommendation`를 LLM 결과로 덮어씀(`used_llm=True`)
   - 실패(Ollama 미가동) 시 **템플릿 값 유지** → 발표 안정성 확보

### 7단계. 서버 응답 객체 (`rag_server.py:635`)
```json
{ "responseType":"ANSWER", "category":"maintenance", "grounded":true,
  "headline":"최근 정비 이력 3건",
  "answer":"최근 1년 내 그랜드패킹부 누설·재점검이 반복 확인되어 … 조건부 관리 대상으로 보는 것이 적절합니다.",
  "recommendation":"다음 정비 시 그랜드패킹부를 최우선으로 확인하세요.",
  "blocks":[ {"kind":"list","intro":"최근 정비 이력 (최신순):","items":[…]} ],
  "data":{…GV-101A 레코드…},
  "sources":[
    {"type":"maintenance","label":"CMMS 정비이력","detail":"GV-101A"},
    {"type":"manual","label":"(절차-표준-018) Globe Valve 정비","detail":"…§20…"} ],
  "manualExcerpt":{"doc":"…","sectionPath":"…","page":…,"text":"…"},
  "retrieval":{"source":"CMMS·정비이력 DB","query":"tag=GV-101A","hitCount":1,"owner":"ai","data":{…}},
  "generation":{"model":"qwen3.5:9b","engine":"Ollama (로컬)","chunks":1} }
```

### 8단계. 프런트 렌더 (`app.js:96 → 154 renderChat`)
흐름 패널에 단계별 기록 후(retrieval=`app.js:73`, generation=`app.js:84`) 5층 카드 렌더:
1. **카테고리 칩**: `categoryOf`(line 175) `source.includes("정비이력")` → "정비이력"
2. **headline** = 판정 한 줄 (`app.js:161`)
3. **구조화 블록** = `renderBlocks`(line 249) 이력 리스트 (`blocks` 우선, 없으면 `detailBlock`)
4. **answer** = LLM/템플릿 종합 해석 (`app.js:164`)
5. **recommendation** = "▸ 권고" (`app.js:165`)
6. **근거칩** = CMMS + 매뉴얼 (`sourceBlock`, line 288)
7. **매뉴얼 발췌(접이식)** = `excerptBlock`(line 310) — RAG 근거 실재 증명

### 폴백 경로 (서버 꺼짐)
2단계 `try/catch` 실패 → `classifier.js:385 classifyRuleBased` → `isMaintenanceQuery` → `buildMaintenanceAnswer`(line 168):
```js
const rec = window.MaintenanceDB.query(tag);   // maintenanceDb.js 하드코딩(또는 /api/db로 동기화된 값)
// "이력" 기본 분기 → rec.history 나열
answer = `${rec.name}(${tag})의 최근 정비 이력은 ${rec.history.map(h=>`${h.date} ${h.type}`).join(", ")}입니다.`;
```
→ **출처·근거 동일**, 문장만 결정적. (`maintenanceDb.js:63 hydrate`가 `/api/db/maintenance/all`로 SQLite와 동기화 시도, 실패 시 line 15 하드코딩 폴백)

---

# 질문 4번 — 정비 주기 (CMMS DB + 동적 계산 · `ANSWER` grounded)

🗣️ 사용자: **"이 밸브의 정비 주기 지났어?"** (대상: GV-101A, 오늘 = 2026-06-24)

핵심 차별점: **날짜를 DB에 박아두지 않고 매 호출마다 계산**합니다.

### 1~3단계. 요청·라우팅·분류
- `isCycleQuery`(`classifier.js:209`): `has(text,["주기",...])` → true → `isGroundedQuery` true → `/api/ai/chat`
- 서버 `classify_question`(line 222): "주기" → `category="cycle"`; 부품?no 교체?no 예정일?no
  → **`sub="overdue"`**, `manual_query="정비주기 등급별 12개월 만료"`(line 229)

### 4단계. DB 사실 (`rag_server.py:273~276 chat_db_facts`)
```python
if category == "cycle":
    return {k: rec[k] for k in ("cycleMonths","lastMaintenance","nextDue","priorityParts")}, rec
```
→ GV-101A: `cycleMonths=12, lastMaintenance="2025-03-21", nextDue="2026-06-26"`

### 5단계. ★ 주기 초과 동적 계산 (`rag_server.py:250 _overdue`)
```python
def _overdue(last_iso, months):       # ("2025-03-21", 12)
    y, m, d = 2025, 3, 21
    idx = (m-1) + months              # 2 + 12 = 14
    ey, em = y + idx//12, idx%12 + 1  # 2026, 3  → 만료 = 2026-03-21
    ed = min(d, calendar.monthrange(ey,em)[1])
    due = date(2026, 3, 21)
    return (date.today() - due).days, due.isoformat()
# 오늘 2026-06-24 − 2026-03-21 = +95일  → (95, "2026-03-21")
```
→ `od=95 > 0` → **주기 초과**. (스크립트 작성 시점 2026-06-23 기준 94일, 오늘 기준 약 95일)

### 6단계. 템플릿/블록 (`chat_template` line 326, `build_blocks` line 455)
- headline: `"정비 주기 초과 (약 95일)"`
- answer(line 330): `"마지막 분해정비 2025-03-21 + 주기 12개월 → 만료 2026-03-21. 오늘 기준 약 95일 초과된 점검 대상입니다."`
- recommendation: `"최근 누설 이력까지 고려해 우선순위를 높게 두고 분해정비로 주기 초과와 Open Point를 함께 해소하세요."`
- 블록(kv, line 456): 등급 `A (핵심)`(`{12:"A …"}` 매핑 line 454), 마지막정비일·주기·만료일·기준일(오늘)·**초과 기간 warn 강조**

### 7~8단계. 응답·렌더
```json
{ "category":"cycle", "grounded":true, "headline":"정비 주기 초과 (약 95일)",
  "retrieval":{"source":"CMMS·정비주기 DB","query":"tag=GV-101A","owner":"ai", ...} }
```
- 카드 카테고리: `categoryOf` `source.includes("정비주기")` → "정비주기"(`app.js:176`)
- 폴백 시 `buildCycleAnswer`(`classifier.js:223`)가 동일하게 `addMonths`+`new Date()` 비교(line 242)로 초과 판정

> **발표 포인트**: "오늘 날짜"가 바뀌면 답도 바뀐다 = 정적 mock이 아니라 **규칙 엔진**임을 증명.

---

# 질문 5번 — 작업 조건 (Walkinside 공간데이터 · `ANSWER` grounded · 솔루션팀)

🗣️ 사용자: **"이 Globe Valve 주변 작업 공간 충분해?"** (대상: GV-101A)

핵심 차별점: 데이터 **소유 팀이 솔루션팀(`owner:"sol"`)** — 흐름 패널 색이 달라집니다.

### 1~3단계. 요청·라우팅·분류
- `isWorkConditionQuery`(`classifier.js:344`): `has(text,["작업 공간",...])` → true → `/api/ai/chat`
- 서버 `classify_question`(line 204): "작업 공간" → `category="spatial"`;
  추락/개구부?no, 발판/고소?no → **`sub="clearance"`**, `manual_query="작업 공간 작업 반경 적정성 간섭"`(line 209)

### 4단계. DB 사실 (`rag_server.py:277 → 671 db_spatial_all`)
```python
def db_spatial_all():
    for r in _db_rows("spatial"):     # SELECT * FROM spatial
        out[r["tag"]] = {
            "clearance": {"front": r["clearance_front"], "right": r["clearance_right"]},
            "height": r["height"], "fallHazard": _jl(r["fall_hazard"]) }
```
→ GV-101A(`build_db.py:57` 시드): `clearance={front:1.2, right:0.8}, height:2.3, fallHazard={exists:true, dir:"좌측", distM:2, type:"개구부 위험 구역"}`

### 5단계. 판정 로직 (`chat_template` line 355)
```python
narrow = (cl.get("right") or 9) < 1     # 0.8 < 1 → True (우측 협소)
headline = "작업 공간 부족(우측 협소)"
answer = ("작업 가능 공간은 전면 약 1.2m, 우측 약 0.8m입니다. "
          "매뉴얼 권장 작업 반경(설비 중심 약 2m)과 비교하면 "
          "우측이 부족해 공구 사용·보닛 분해 시 인접 배관과 간섭이 우려됩니다.")
recommendation = "우측 인접 배관 보호·작업구역 표시·공구 동선 확보를 권장합니다."
```
- 블록(kv, line 510): 전면/우측(warn)/권장반경/조작부높이(2.3m warn)/좌측위험요소(개구부 warn)

### 6단계. 매뉴얼 근거 + owner 표시 (`rag_server.py:625`)
```python
owner = "sol" if category == "spatial" else "ai"     # ★ 솔루션팀
src_label = {"spatial":"Walkinside 공간측정", ...}[category]
sources = [{"type":"spatial","label":"Walkinside 공간측정","detail":"GV-101A"}]
# + 매뉴얼 hit 1개(절차-표준-018 §19 작업구역) 추가 → manualExcerpt
```

### 7~8단계. 응답·렌더
```json
{ "category":"spatial", "grounded":true, "headline":"작업 공간 부족(우측 협소)",
  "sources":[{"type":"spatial","label":"Walkinside 공간측정",…},{"type":"manual",…}],
  "retrieval":{"source":"Walkinside 공간 데이터","query":"tag=GV-101A","owner":"sol", …} }
```
- 카드 카테고리: `categoryOf` `source.includes("Walkinside")` → "작업조건"(`app.js:177`)
- 흐름 패널(`app.js:74`): `res.retrieval.owner==="sol"` → "솔루션팀 · DATA" 로 표기 → **두 팀 데이터가 한 답변에 결합됨을 시각화**
- 폴백 시 `buildWorkConditionAnswer`(`classifier.js:297`): `window.SpatialDB.query(tag)` → 동일 판정

> **변형 시연**:
> - "작업발판 필요해? / 2m 이상 고소작업?" → `sub="height"`(line 208): `height 2.3 ≥ 2` → "고소작업 해당" + 안전조치 리스트(line 499)
> - "추락 위험·개구부 있어?" → `sub="fall"`(line 205): `fallHazard.exists` → "좌측 2m 지점 개구부 위험"(line 350)

---

# 질문 6번 — 작업발판/고소작업 (Walkinside 공간데이터 · `ANSWER` grounded · 솔루션팀)

🗣️ 사용자: **"이 밸브 정비할 때 작업발판이 필요해? 2m 이상 고소작업에 해당돼?"** (대상: GV-101A)

5번과 **같은 `spatial` 카테고리지만 세부 분기(`sub`)가 달라** 다른 판정·블록·매뉴얼이 붙는 사례입니다.

### 1~3단계. 요청·라우팅·분류
- `isWorkConditionQuery`(`classifier.js:344`): 텍스트에 `"작업발판"·"고소작업"·"2m 이상"` 포함 → true → `isGroundedQuery` true → `/api/ai/chat`
- 서버 `classify_question`(`rag_server.py:204`): spatial 키워드 매칭 →
  - 추락/개구부? **no**
  - `_any(t, ["발판","고소작업","2m 이상","사다리"])` → **yes** (line 208)
  - → **`sub="height"`**, `manual_query="고소작업 2m 작업발판 안전대 안전조치"`, `valve="globe"`

### 4단계. DB 사실 (`rag_server.py:671 db_spatial_all`)
→ GV-101A(`build_db.py:57` 시드): `clearance={front:1.2, right:0.8}, **height:2.3**, fallHazard={exists:true,…}`

### 5단계. 고소작업 판정 (`chat_template` line 344~348)
```python
if sub == "height":
    high = (h or 0) >= 2          # 2.3 >= 2 → True
    headline = "고소작업 해당 (높이 2.3m)"
    answer   = ("조작부 높이는 약 2.3m로, 매뉴얼상 2m 이상 = 고소작업에 해당합니다. "
                "작업발판·안전난간·안전대 착용이 필요합니다.")
    recommendation = "우측 공간이 좁으면 작업발판 설치 시 인접 배관 간섭을 먼저 확인하세요."
```
> 만약 `height < 2`였다면 같은 코드가 "고소작업 미해당"으로 분기(`else`, line 347). → **데이터값에 따라 판정이 갈리는 규칙 엔진**.

### 6단계. 구조화 블록 (`build_blocks` line 493~500)
- kv "고소작업 판정 근거": 조작부 높이 `약 2.3m`(warn) · 고소작업 기준 `2m 이상` · 판정 `고소작업 해당`(warn)
- `hi=True`이므로 **필요 안전조치 리스트**(line 499): `작업발판 설치 및 고정 상태 확인 / 안전난간 설치 / 안전대 착용 / 하부 출입 통제 / 추락 위험 구역 표시 / 개구부 덮개 또는 안전난간`

### 7단계. 매뉴얼 근거 + owner (`rag_server.py:601, 625`)
- 벡터검색(`고소작업 2m 작업발판…`, globe) → `절차-표준-018 추가지침 §19.2(고소작업 판단 기준)` 청크 1개
- `owner="sol"`(공간데이터=솔루션팀), `sources=[{type:"spatial","Walkinside 공간측정"}, {type:"manual", §19.2}]`

### 8단계. 응답·렌더
```json
{ "category":"spatial", "sub(내부)":"height", "grounded":true,
  "headline":"고소작업 해당 (높이 2.3m)",
  "answer":"조작부 높이는 약 2.3m로 … 작업발판·안전난간·안전대 착용이 필요합니다.",
  "retrieval":{"source":"Walkinside 공간 데이터","query":"tag=GV-101A","owner":"sol", …} }
```
- 카드 카테고리 "작업조건"(`app.js:177`), `detailBlock` spatial(line 208)이 `height 2.3 ≥ 2`를 **warn 강조**
- 폴백(`buildWorkConditionAnswer` `classifier.js:310`): `has(text,["발판","고소작업","2m 이상","사다리"])` → `rec.height>=2` → "작업 위치 높이는 약 2.3m입니다. 2m 이상 고소작업 기준에 해당하므로 작업발판 또는 안전대 등 안전조치가 필요합니다."

> **5번 vs 6번 비교(발표 포인트)**: 같은 GV-101A·같은 `spatial` 테이블 1행이지만,
> 질문 문구의 키워드(`공간` vs `발판/고소`)로 `sub`가 `clearance`↔`height`로 갈리고
> → headline·answer·블록·인용 매뉴얼(§17 작업구역 ↔ §19.2 고소작업)이 모두 달라집니다.

---

# 질문 7번 — 그랜드패킹 교체 판단 (CMMS · `ANSWER` grounded) ★ 라우팅 우선순위 사례

🗣️ 사용자: **"최근 누설 이력을 고려하면 그랜드패킹을 교체해야 해?"** (대상: GV-101A)

이 질문의 핵심은 **"누설"·"이력" 단어가 있는데도 정비이력(maintenance)이 아니라 정비주기(cycle)로 간다**는 점입니다. → 분류 **순서**가 답을 바꾸는 대표 예시.

### 1단계. 프런트 라우팅 (`classifier.js`)
- `isManualQuery` → false ("교체 기준"이 아니라 "교체해야")
- `isCycleQuery`(line 209): 첫 조건 `["주기","예정일","다음 정비","부품"]` 미매칭이지만
  두 번째 조건 **`text.includes("교체") && has(text,["해야","할까","검토","필요"])`** → "교체"+"해야" → **true**
- → `isGroundedQuery` true → `/api/ai/chat`
  (주의: `isMaintenanceQuery`도 "누설/이력"으로 true지만, 프런트는 grounded 여부만 보고 서버로 넘김 — **실제 카테고리는 서버가 결정**)

### 2단계. ★ 서버 분류 우선순위 (`rag_server.py:199 classify_question`)
서버 분기 순서는 **공간 → 작업단계 → 교체/주기 → 정비이력** 입니다.
```python
# line 222 (cycle) 가 line 231 (maintenance) 보다 먼저!
if _any(t, ["주기","예정일","다음 정비","부품"]) or ("교체" in t and _any(t, ["해야","할까","검토","필요"])):
    if "교체" in t:
        return "cycle", "replace", "그랜드패킹 교체 판단 기준 분해 후 실측", "globe"   # ← 여기서 반환
# (아래 maintenance 분기 line 231은 도달조차 안 함)
```
→ `category="cycle"`, **`sub="replace"`**. ("누설/이력"이 있어도 `교체…해야`가 먼저 가로챔.)
> 이 우선순위는 `classifier.js:135` 주석 *"(cat3보다 앞: 교체해야?·주기·예정일·부품을 이력 질의와 구분)"* 과 정렬되어 있습니다.

### 3단계. DB 사실 (`rag_server.py:273 chat_db_facts` — cycle)
- `data = {cycleMonths:12, lastMaintenance:"2025-03-21", nextDue:"2026-06-26", priorityParts:[…]}`
- `rec`(전체)에는 **leaks·openPoints·recurring**도 포함 → 교체 사유 근거로 사용

### 4단계. 판단 답변 (`chat_template` line 338~341 — replace)
```python
headline = "그랜드패킹 교체 검토 대상"
answer = ("반복 누설 이력으로 그랜드패킹은 교체 검토 대상입니다. "
          "단 최종 교체는 분해 후 패킹 경화·마모·고착, 스터핑박스 내면 긁힘, "
          "스템 접촉부 손상을 실측해 확정합니다.")
recommendation = "4산 구성이면 교체 시 이음부를 90° 엇갈림으로 배열하세요(§15.3)."
```
> **"무조건 교체"라고 단정하지 않음** — 추가지침 §21(AI 답변 기준)의 "최종 교체 여부는 분해 후 실측·정비책임자 확인" 원칙을 코드로 구현.

### 5단계. 구조화 블록 (`build_blocks` line 476~487 — replace)
- **교체 검토 사유**(DB 실데이터에서 동적 생성):
  - `rec.leaks` 있음 → "2025-08-02 그랜드패킹부 누설 발생"
  - "2025-11-14 동일 부위 미세 비침 재확인"
  - "최근 12개월 내 동일 부위 2회 → 반복 고장"
  - `rec.openPoints` 있음 → "Open Point **OP-2025-114** 재확인 항목 잔존"
  - "A등급 설비·정비 주기 초과 상태"
- **분해 후 아래 중 하나라도 확인되면 신품 교체**(ordered): 패킹 경화 / 마모·찢김 / 고착 / 스터핑박스 내면 긁힘 / 스템 패킹 접촉부 손상 / 그랜드부 편마모 / 패킹 압축 여유 부족

### 6단계. 매뉴얼 근거 (`rag_server.py:601`)
- 벡터검색(`그랜드패킹 교체 판단 기준 분해 후 실측`, globe) → `절차-표준-018 추가지침 §11.2(그랜드패킹 교체 판단 기준)` / `§15.3(이음부 배열각)` 청크
- `owner="ai"`, `retrieval.source="CMMS·정비주기 DB"`

### 7~8단계. 응답·렌더
```json
{ "category":"cycle", "grounded":true, "headline":"그랜드패킹 교체 검토 대상",
  "blocks":[{"…교체 검토 사유…"},{"…분해 후 신품 교체 조건…"}],
  "sources":[{"type":"cycle","label":"CMMS 정비주기"},{"type":"manual","detail":"…§11.2…"}],
  "retrieval":{"source":"CMMS·정비주기 DB","owner":"ai", …} }
```
- 카드 카테고리: `source.includes("정비주기")` → "정비주기"(`app.js:176`)
- 폴백(`buildCycleAnswer` `classifier.js:235`): `text.includes("교체")` → `rec.leaks.length` 있음 →
  "최근 누설 이력이 있고 그랜드패킹 부위 점검 이력이 반복되어 교체 검토가 필요합니다. 단, 최종 교체 여부는 분해 후 패킹 상태와 스터핑박스 손상 여부 확인 후 결정해야 합니다."

> **발표 포인트**: 같은 설비라도 **질문 동사**("교체 이력 있어?" vs "교체해야 해?")로
> `maintenance/gasket`(과거 사실 나열) ↔ `cycle/replace`(미래 판단)로 갈립니다.
> 분류 규칙의 **순서**가 곧 의도 해석이라는 점을 보여주는 핵심 사례.

---

## 그림. 질문 5 · 6 · 7 처리 흐름도

> 세 질문 모두 **`/api/ai/chat` 5단 구조**를 타지만, **갈라지는 분기점**이 서로 다릅니다.
> 5·6번은 *같은 `spatial` 행에서 `sub`만* 갈리고, 7번은 *분류 순서*가 카테고리를 가릅니다.

### 질문 5번 — 작업 공간 (spatial · clearance)
```
🗣️ "이 Globe Valve 주변 작업 공간 충분해?"
 │
 ▼ [Frontend] app.js:onSend → request{message, currentTag:null}
 │   classifier.js:isWorkConditionQuery() = TRUE → isGroundedQuery
 ▼ [ragClient.js] RagClient.chat() ──HTTP POST──▶ localhost:8090/api/ai/chat
 │
 ▼ [rag_server.py] make_chat(tag = currentTag or "GV-101A")
 │   classify_question():  "작업 공간" 매칭
 │        ├ 추락/개구부?      no
 │        ├ 발판/고소/2m?     no
 │        └ ▶▶ sub = "clearance"   ◀── ★ 분기점
 │
 ├─────────────────┬────────────────────────┐
 ▼                 ▼                        ▼
DB 사실           매뉴얼 벡터검색           LLM 종합(선택)
db_spatial_all    sm.search(bge-m3,globe)  build_chat_synthesis
SELECT * spatial  → §17 작업구역 청크 1개   → Ollama qwen3.5:9b
front 1.2/right 0.8/h 2.3                  (실패 시 템플릿 유지)
 │
 ▼ chat_template(sub=clearance):  right 0.8 < 1 → narrow = TRUE
   headline "작업 공간 부족(우측 협소)" / 전면1.2·우측0.8·권장2m kv블록
 │
 ▼ 응답 JSON { category:"spatial", owner:"sol", source:"Walkinside 공간 데이터" }
 │  ◀──HTTP 200
 ▼ [Frontend] renderChat → 카드 "작업조건"
   ① 판정  ② kv블록  ③ 종합  ④ 권고  ⑤ 근거칩[Walkinside + §17]  ⑤ 발췌
```

### 질문 6번 — 작업발판/고소작업 (spatial · height)
```
🗣️ "이 밸브 정비할 때 작업발판 필요해? 2m 이상 고소작업?"
 │
 ▼ [Frontend] classifier.js:isWorkConditionQuery() = TRUE ("작업발판","고소작업","2m 이상")
 ▼ RagClient.chat() ──HTTP POST──▶ /api/ai/chat
 │
 ▼ [rag_server.py] make_chat(tag="GV-101A")
 │   classify_question():  "작업 공간"군 매칭
 │        ├ 추락/개구부?      no
 │        └ 발판/고소/2m?     YES ──▶▶ sub = "height"   ◀── ★ 5번과 갈리는 지점
 │
 ├─────────────────┬────────────────────────┐
 ▼                 ▼                        ▼
DB 사실           매뉴얼 벡터검색           LLM 종합(선택)
db_spatial_all    sm.search(globe)         (동일)
height = 2.3      → §19.2 고소작업 청크 ◀── 5번(§17)과 다른 근거
 │
 ▼ chat_template(sub=height):  high = (2.3 >= 2) → TRUE
   headline "고소작업 해당 (높이 2.3m)"
   build_blocks → 판정 kv + [작업발판·안전난간·안전대·출입통제·구역표시·개구부덮개]
 │
 ▼ 응답 JSON { category:"spatial", owner:"sol" }
 ▼ [Frontend] 카드 "작업조건" — 높이 2.3 ≥ 2 → warn 강조

   ┌─────────────────────────────────────────────────────────┐
   │ ★ 5 vs 6 : 같은 GV-101A·같은 spatial 1행                  │
   │   키워드만 다름 →  sub: clearance ↔ height                │
   │   → 판정·블록·인용매뉴얼(§17 ↔ §19.2) 전부 달라짐         │
   └─────────────────────────────────────────────────────────┘
```

### 질문 7번 — 그랜드패킹 교체 판단 (cycle · replace) ★ 라우팅 순서가 가르는 사례
```
🗣️ "최근 누설 이력을 고려하면 그랜드패킹을 교체해야 해?"
 │   ("누설"·"이력" 단어 → maintenance처럼 보이지만…)
 │
 ▼ [Frontend] classifier.js
 │   isManualQuery?         no ("교체 기준" 아님)
 │   isCycleQuery?          YES  ← "교체" + "해야"  (line 212)
 │   → isGroundedQuery → RagClient.chat() ──HTTP POST──▶ /api/ai/chat
 │
 ▼ [rag_server.py] classify_question()  ─ 분기는 위에서 아래로 순차 평가 ─
 │   ① spatial?              no
 │   ② workflow?             no
 │   ③ cycle?  ("교체" and "해야")  ══▶ YES  ◀── ★ 여기서 가로챔(먼저 매칭)
 │        └ "교체" 포함 → sub = "replace"
 │   ④ maintenance?  (누설·이력)  ✗ 도달조차 안 함 (③에서 return)
 │
 ├─────────────────┬────────────────────────┐
 ▼                 ▼                        ▼
DB 사실(전체 rec) 매뉴얼 벡터검색           LLM 종합(선택)
db_maintenance_all → §11.2 교체 판단 청크   build_chat_synthesis
leaks·openPoints·recurring 포함            (실패 시 템플릿)
 │
 ▼ chat_template(sub=replace) + build_blocks
   headline "그랜드패킹 교체 검토 대상"
   [교체 검토 사유] ← DB 실데이터로 동적 생성
        · 2025-08-02 누설(leaks)  · 2025-11-14 재확인
        · 12개월 내 2회 → 반복고장  · Open Point OP-2025-114
        · A등급·주기 초과
   [분해 후 하나라도 확인 시 신품 교체] 경화/마모/고착/긁힘/손상…
   "무조건 교체" 아님 → 분해 후 실측 확정 (추가지침 §21 구현)
 │
 ▼ 응답 JSON { category:"cycle", owner:"ai", source:"CMMS·정비주기 DB" }
 ▼ [Frontend] 카드 "정비주기"

   ┌─────────────────────────────────────────────────────────┐
   │ ★ 7번 교훈 : 분류는 "위→아래 순서"로 평가                 │
   │   cycle("교체+해야")가 maintenance("누설·이력")보다 먼저  │
   │   → 같은 밸브라도 동사가 카테고리를 결정                  │
   │   "교체 이력 있어?" → maintenance/gasket (과거 사실)      │
   │   "교체해야 해?"   → cycle/replace      (미래 판단)       │
   └─────────────────────────────────────────────────────────┘
```

### 세 흐름 겹쳐 보기 (분기점만)
```
                 ┌────────────────────────── /api/ai/chat (5단 구조) 공통 ─────────────────────────┐
질문 →  classify_question()                                                                        │
        │                                                                                          │
        ├─ spatial ─┬─ "발판/고소/2m"? ─ no → sub=clearance ─▶ [Q5] §17  · owner sol               │
        │           └───────────────── yes → sub=height    ─▶ [Q6] §19.2 · owner sol               │
        │                                                                                          │
        └─ cycle ──── "교체"+"해야"   ───────── sub=replace  ─▶ [Q7] §11.2 · owner ai (maintenance 차단) │
                 └──────────────────────────────────────────────────────────────────────────────┘
   공통 후단:  DB 사실  +  매뉴얼 벡터검색(1청크)  +  LLM 종합(폴백 템플릿)  →  JSON  →  renderChat 5층 카드
```

---

## 부록 A. 질문 1~7번 처리 경로 한눈에 비교

| # | 질문 유형 | 라우팅 판별 | 서버 category·sub | 데이터 소스 | responseType | owner |
|---|---|---|---|---|---|---|
| 1 | 설비 찾기 | (grounded·manual 아님) | 규칙 `SEARCH_EQUIPMENT` | 없음(뷰어) | `ACTION` | 솔루션팀 |
| 2 | 작업 위치 | (grounded·manual 아님) | 규칙 `JUMP_TO` | 없음(뷰어) | `ACTION` | 솔루션팀 |
| 3 | 정비 이력 | `isMaintenanceQuery` | `maintenance·history` | SQLite `maintenance` + 벡터 | `ANSWER` grounded | AI팀 |
| 4 | 정비 주기 | `isCycleQuery` | `cycle·overdue` (동적계산) | SQLite `maintenance` + 동적계산 | `ANSWER` grounded | AI팀 |
| 5 | 작업 공간 | `isWorkConditionQuery` | `spatial·clearance` | SQLite `spatial` + 벡터 | `ANSWER` grounded | **솔루션팀** |
| 6 | 작업발판/고소 | `isWorkConditionQuery` | `spatial·height` | SQLite `spatial` + 벡터(§19.2) | `ANSWER` grounded | **솔루션팀** |
| 7 | 그랜드패킹 교체 | `isCycleQuery`("교체+해야") | `cycle·replace` | SQLite `maintenance` 전체 + 벡터(§11.2) | `ANSWER` grounded | AI팀 |

> **5·6번**: 같은 테이블·같은 행, `sub`만 다름(clearance↔height) → 판정·블록·인용 매뉴얼이 갈림.
> **7번**: "누설/이력"이 있어도 분류 **순서상 cycle이 먼저** → maintenance로 안 감. 의도=동사+순서.

## 부록 B. "환각 방지" 3중 장치 (발표 강조점)

1. **사실은 DB에서만** — 날짜·수치·판정은 `app.db`/동적계산. LLM은 "지어내기" 금지, 해석만(`build_chat_synthesis_prompt` line 562).
2. **근거는 벡터검색 청크에서만** — `min_score 0.30` 미달 시 폴백 "지침서에서 확인되지 않습니다"(`rag_server.py:182, 581`).
3. **LLM 실패해도 답이 나옴** — 모든 카테고리에 결정적 템플릿(`chat_template`)이 있어 Ollama가 꺼져도 동일 사실로 응답 → 시연 안정성.

## 부록 C. 데이터 계보 (이 답변들이 어디서 왔나)

```
정비이력/주기/공간   →  build_db.py(소스코드 시드)  →  data/app.db(SQLite)
                                                       ↓ db_*_all()
                                                    rag_server.make_chat
                                                       ↑ sm.search()
매뉴얼 PDF/추가지침  →  ingest_manuals.py(청킹)  →  manual_chunks.json
                     →  (bge-m3 임베딩)         →  manual_index.npy + .meta.json
LLM 문장 종합        →  Ollama qwen3.5:9b (로컬, Apache-2.0)
```

> 한 줄 요약: **"정형 사실은 SQLite, 근거 문장은 벡터검색, 표현만 로컬 LLM."**
> 셋을 분리했기 때문에 모델·DB·뷰어를 각각 독립적으로 교체할 수 있습니다.

---

## 부록 D. 대화 문맥(Context) 파악 및 메모리 관리 기법

로컬 LLM(`qwen3.5:9b`)이 대화의 흐름과 맥락을 이해하고 후속 질문(예: "그거", "그 밸브", "옆에서")에 대응할 수 있도록 백엔드에서 제공하는 대화 이력 및 컨텍스트 관리 방식입니다.

### 1. 슬라이딩 윈도우 기반 대화 이력 (`MAX_TURNS = 6`)
* **이력 누적**: 서버는 `sessionId`를 키로 세션별 대화 기록을 메모리(`_SESSIONS`)에 누적 보관합니다.
* **최근 6턴 제한**: 무제한으로 대화를 기억하면 프롬프트가 너무 길어져 LLM 추론 속도가 느려집니다. 따라서 가장 최근의 대화 **최대 6턴(질문 및 답변 쌍)**만 슬라이딩 윈도우 방식으로 프롬프트에 실어 보냅니다.
* **프롬프트 포맷팅**: `_format_history(history)`를 통해 `[이전 대화]` 섹션에 `"사용자: ... 어시스턴트: ..."` 형식으로 조립되어 입력됩니다.

### 2. 3D 뷰어 상태 컨텍스트 (Viewer Context) 연계
* 사용자가 대명사(예: "이거", "그 밸브")로 질문하는 상황에 대비하여, 프론트엔드가 보낸 현재 선택된 설비 태그(`currentTag`)를 항상 시스템 프롬프트에 주입합니다.
* 예: `"문장에 태그가 없으면 현재 선택 태그를 targetValue로 사용. 현재 선택 태그: GV-101A"`

### 3. 로컬 LLM의 컨텍스트 처리 범위 및 최적화
* 사용 중인 로컬 LLM인 **`qwen3.5:9b`** 모델은 기본적으로 최대 **32,000 토큰**의 넓은 컨텍스트 윈도우를 지원합니다.
* 하지만 빠른 실시간 응답을 위해, 백엔드 서버([rag_server.py](file:///C:/lyn/i3dweb_mock/backend/rag_server.py#L90-L97))에서 Ollama 호출 시 출력 토큰 제한(`num_predict`)을 `120~320` 수준으로 제한하여 빠른 연산 속도를 보장합니다.

