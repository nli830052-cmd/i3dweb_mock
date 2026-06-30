# JS ↔ Python 통신(API) 전체 코드 정리

이 문서는 `i3dweb_mock` 프로젝트에서 프론트엔드(자바스크립트)와 백엔드(파이썬)가 서로 통신하는 **모든 API 엔드포인트와 해당 코드**를 정리한 내용입니다.

통신은 크게 **1. DB 데이터 조회(GET)**와 **2. AI 및 검색 처리(POST)** 두 가지로 나뉩니다.

---

## 1. 데이터베이스(DB) 정보 가져오기 (GET 방식)
화면 초기화 시 백엔드의 데이터를 프론트엔드로 로드하는 통신입니다.

### 1-1. 정비 이력 (Maintenance DB)
- **주소**: `/api/db/maintenance/all`
- **목적**: SQLite에 저장된 밸브 정비 이력 및 상태 정보 가져오기

**[프론트엔드 JS]** `src/ai/maintenanceDb.js`
```javascript
function hydrate() {
  const base = (window.RagClient && window.RagClient.BASE) || "http://localhost:8090";
  // GET 요청으로 백엔드의 데이터를 가져옴
  fetch(base + "/api/db/maintenance/all")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { 
      if (d) { 
        Object.keys(RECORDS).forEach((k) => delete RECORDS[k]); 
        Object.assign(RECORDS, d); 
      } 
    })
    .catch(() => {});
}
```

**[백엔드 Python]** `backend/rag_server.py`
```python
def do_GET(self):
    path = self.path.split("?")[0]
    
    # DB 조회 요청 처리 매핑 
    _DB_ALL = {
        "/api/db/maintenance/all": db_maintenance_all,
        # ...
    }
    
    if path in _DB_ALL:
        try:
            # db_maintenance_all() 함수를 실행해 딕셔너리를 가져오고 JSON으로 반환
            return self._json(200, _DB_ALL[path]())
        except Exception as e:
            return self._json(500, {"error": "DB_ERROR", "message": str(e)})
```

*(참고: `workflowDb.js`의 `/api/db/workflow/all`과 `spatialDb.js`의 `/api/db/spatial/all`도 이와 100% 동일한 구조로 GET 통신을 수행합니다.)*

---

## 2. AI 챗봇 및 매뉴얼 RAG 검색 (POST 방식)
사용자의 질문이나 액션을 AI가 분석하고 매뉴얼을 검색하는 통신입니다.

### 2-1. 통합 AI 채팅
- **주소**: `/api/ai/chat`
- **목적**: 사용자의 질문을 분석하여 텍스트 답변과 3D 화면 조작 명령(Action)을 한 번에 반환

**[프론트엔드 JS]** `src/ai/ragClient.js`
```javascript
async function chat(message, currentTag, sessionId) {
  const res = await fetch(BASE + "/api/ai/chat", {
    method: "POST", 
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: message, currentTag: currentTag, sessionId: sessionId })
  });
  if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
  return await res.json();
}
```

**[백엔드 Python]** `backend/rag_server.py`
```python
def do_POST(self):
    path = self.path.split("?")[0]
    # JSON 본문 파싱
    n = int(self.headers.get("Content-Length", 0))
    req = json.loads(self.rfile.read(n) or b"{}")

    if path == "/api/ai/chat":
        message = (req.get("message") or "").strip()
        sid = req.get("sessionId")
        
        # 의도 분류, RAG 검색, LLM 생성을 모두 거쳐 결과물 생성
        out = make_chat(message, req.get("currentTag"), _get_history(sid))
        
        return self._json(200, out) # JSON 응답 반환
```

### 2-2. 화면 제어 Action 전용
- **주소**: `/api/ai/plan`
- **목적**: 챗봇의 긴 대답 없이, 3D 뷰어를 움직일 계획(Action JSON)만 필요할 때 사용

**[프론트엔드 JS]** `src/ai/ragClient.js`
```javascript
async function plan(query, currentTag) {
  const res = await fetch(BASE + "/api/ai/plan", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query, currentTag: currentTag })
  });
  // ... 생략
  return await res.json();
}
```

**[백엔드 Python]** `backend/rag_server.py`
```python
if path == "/api/ai/plan":
    sid = req.get("sessionId")
    # 매뉴얼 검색 없이 LLM에게 3D 화면 제어용 Action JSON만 만들도록 지시
    plan = make_plan(query, req.get("currentTag"), _get_history(sid))
    return self._json(200, plan)
```

### 2-3. 매뉴얼 RAG 검색 (검색 전용 / 답변 포함)
- **주소**: `/api/rag/search` (원문 검색만) / `/api/rag/answer` (AI 답변까지)
- **목적**: 매뉴얼 데이터 인덱스를 벡터 검색하여 관련된 조각을 찾음

**[프론트엔드 JS]** `src/ai/ragClient.js`
```javascript
async function _post(path, query, valveType, topK) {
  const res = await fetch(BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query, valveType: valveType, topK: topK })
  });
  return await res.json();
}

function search(query, valveType, topK) { return _post("/api/rag/search", query, valveType, topK); }
function answer(query, valveType, topK) { return _post("/api/rag/answer", query, valveType, topK); }
```

**[백엔드 Python]** `backend/rag_server.py`
```python
# 공통: 벡터 인덱스를 검색하여 관련 매뉴얼 청크(hits) 확보
vecs, meta = _ensure_loaded()
hits = sm.search(query, vecs, meta, valve_type=valve, top_k=top_k, min_score=min_score)

# /api/rag/search 처리: 찾은 원문만 반환
if path == "/api/rag/search":
    return self._json(200, { "hitCount": len(hits), "hits": [_to_camel(s, m) for s, m in hits] })

# /api/rag/answer 처리: 찾은 원문을 프롬프트에 넣고 LLM으로 답변을 생성하여 반환
answer = ollama_generate(build_answer_prompt(query, hits))
return self._json(200, { "answer": answer, "hits": [_to_camel(s, m) for s, m in hits] })
```
