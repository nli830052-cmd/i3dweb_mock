# i3DWEB 정비 어시스턴트 — 대화형 AI 고도화 로드맵

> 현재 상태: **키워드 substring 라우터 + 템플릿 답변 + RAG(단일 벡터검색)** 데모.
> 목표: **패러프레이즈·멀티턴·다단계 행동**이 되는 진짜 대화형 어시스턴트.
> 근거 코드: `src/ai/classifier.js`, `backend/rag_server.py`, `scripts/*`.

---

## 0. 핵심 진단 — "리치 답변이 키워드로 게이트되어 있다"

지금 5단 구조(headline·blocks·근거)의 좋은 답변은 **키워드가 맞아야만** 들어갑니다.

```
"발판/고소/2m" 키워드 매칭     → /api/ai/chat → make_chat → build_blocks(5단 리치) ✅
같은 뜻 다른 표현("높은 데서 작업?") → 키워드 전부 빗나감
       → classifyRuleBased _fallback → /api/ai/plan(LLM) → executePlan
       → buildWorkConditionAnswer(클라 mock, 빈약) ⚠️  ← 의도는 맞아도 빈약한 답
```

**그래서 Phase 1의 목표는 "분류를 키워드+LLM 하이브리드로 바꿔, 패러프레이즈도 리치 경로로 수렴"** 입니다.

---

## 1. 전체 로드맵 (Phase 1~6)

| Phase | 주제 | 현재 | 목표 | 임팩트/난이도 |
|---|---|---|---|---|
| **1** | 의도/엔티티 인식 | `_any()` 키워드 substring | LLM 구조화 추출 + 키워드 빠른길 + 신뢰도/되묻기 | ★★★ / 中 |
| 2 | 멀티턴 대화관리 | `_SESSIONS`(plan만 사용) | 상태추적 + 대용어 해소 + 슬롯필링 | ★★★ / 中 |
| 3 | RAG 검색 품질 | 단일 벡터 top_k, min_score 컷 | 하이브리드(BM25+dense)+리랭커+쿼리재작성+인용검증 | ★★★ / 中 |
| 4 | 에이전트화 | 단발 액션(`executePlan`) | tool-calling 다단계 루프 | ★★ / 上 |
| 5 | 평가·관측 | 없음 | 골든셋 + Recall@k/RAGAS + 트레이싱 + 피드백 | ★★★ / 中 |
| 6 | 실데이터·안전·운영 | mock SQLite·일괄응답 | 실연동 + 스트리밍 + 가드레일 + 감사 | ★★ / 上 |

> 권장 순서: **5(평가셋 먼저 작게) → 1 → 3 → 2 → 4 → 6**.
> *측정 수단을 먼저 만들고, 한 번에 하나만 바꿔 점수 변화를 본다.*

---

## 2. Phase 1 상세 설계 — 키워드+LLM 하이브리드 의도분류

### 2.1 설계 원칙
1. **키워드 빠른길 유지**: 확신 가능한 문장(데이터 키워드 명확)은 LLM 호출 없이 즉시 분류(빠르고 결정적, 비용 0).
2. **LLM 폴백**: 키워드가 데이터 카테고리에 안 걸리고 "매뉴얼 신호"도 약하면 → LLM이 `{category, sub, tag, valveType, confidence}`를 **구조화 출력**.
3. **같은 택소노미로 수렴**: LLM 결과도 기존 `category·sub` 체계에 매핑 → **리치 경로(`make_chat`)로 진입**.
4. **저신뢰 → 되묻기**: confidence가 낮거나 모호하면 단정 대신 **clarification** 반환.

### 2.2 서버 변경 (`backend/rag_server.py`)

#### (a) 택소노미 + sub별 매뉴얼 검색어 상수
지금 `classify_question` 안에 흩어진 `manual_query` 문자열을 표로 추출합니다.

```python
# ── 의도 택소노미 (LLM 출력 검증용) ──────────────────────
CATEGORY_SUBS = {
    "maintenance": ["history", "overhaul", "gasket", "leak", "recurring", "result", "openpoint"],
    "cycle":       ["overdue", "nextdue", "parts", "replace"],
    "spatial":     ["clearance", "height", "fall"],
    "workflow":    ["current", "next", "checklist", "prep", "missing"],
    "manual":      ["rag"],
}

# (category, sub) → 매뉴얼 벡터검색어 (기존 classify_question 값과 동일)
SUB_MANUAL_QUERY = {
    ("spatial", "clearance"): "작업 공간 작업 반경 적정성 간섭",
    ("spatial", "height"):    "고소작업 2m 작업발판 안전대 안전조치",
    ("spatial", "fall"):      "개구부 추락 위험 안전조치 안전난간",
    ("cycle", "overdue"):     "정비주기 등급별 12개월 만료",
    ("cycle", "nextdue"):     "특별점검 착수 기준 우선 점검",
    ("cycle", "parts"):       "분해 시 우선 점검 순서 부품",
    ("cycle", "replace"):     "그랜드패킹 교체 판단 기준 분해 후 실측",
    ("maintenance", "result"):    "분해 후 점검 판정 등급 조건부 정상",
    ("maintenance", "openpoint"): "Open Point 미조치 관리 기준",
    ("maintenance", "recurring"): "반복 고장 분류 12개월 2회 우선 점검",
    ("maintenance", "gasket"):    "보닛 가스켓 재사용 금지 교체",
    ("maintenance", "leak"):      "그랜드패킹부 누설 조치",
    ("maintenance", "overhaul"):  "스템 점검 디스크 시트 Blue Check",
    ("maintenance", "history"):   "정비기록 작성 항목",
}
```

#### (b) LLM 의도분류기 (구조화 출력)
기존 `ollama_generate` + `_extract_json`을 그대로 재사용합니다.

```python
INTENT_PROMPT = (
    "당신은 설비 정비 어시스턴트의 의도 분류기입니다.\n"
    "사용자 문장을 아래 택소노미 중 하나로 분류해 JSON만 출력하세요. 설명 금지.\n\n"
    '형식: {"category":"...","sub":"...","tag":"<태그 또는 null>",'
    '"valveType":"gate|globe|null","confidence":0.0~1.0}\n\n'
    "category·sub 목록:\n"
    "- maintenance: history(이력) overhaul(마지막분해정비) gasket(가스켓) leak(누설) "
    "recurring(반복고장) result(점검결과) openpoint(미조치)\n"
    "- cycle: overdue(주기초과) nextdue(다음예정일) parts(우선부품) replace(부품교체판단)\n"
    "- spatial: clearance(작업공간) height(고소작업/발판) fall(추락/개구부)\n"
    "- workflow: current(현재단계) next(다음단계) checklist(체크리스트) prep(준비미완료) missing(조립누락)\n"
    "- manual: rag(절차/방법/기준 등 매뉴얼 일반)\n\n"
    "규칙:\n"
    "- '교체해야/교체 검토' 같은 미래 판단은 cycle.replace, '교체 이력' 같은 과거 사실은 maintenance.gasket.\n"
    "- '높은 곳/사다리/올라가서' 처럼 표현이 달라도 의미가 고소작업이면 spatial.height.\n"
    "- 문장에 태그 없으면 현재 선택 태그 사용. 현재 선택 태그: %s\n"
    "- 의미가 모호하면 confidence를 0.5 이하로.\n/no_think\n\n"
    '문장: "%s"\n출력:'
)

def classify_intent_llm(message, tag, history=None):
    """LLM 의도분류 → {category, sub, tag, valveType, confidence} 또는 None."""
    out = ollama_generate(INTENT_PROMPT % (tag or "없음", message), num_predict=120)
    obj = _extract_json(out)
    if not isinstance(obj, dict):
        return None
    cat, sub = obj.get("category"), obj.get("sub")
    if cat not in CATEGORY_SUBS or sub not in CATEGORY_SUBS[cat]:
        return None                      # 택소노미 밖이면 폐기(환각 방지)
    try:
        obj["confidence"] = float(obj.get("confidence", 0))
    except Exception:
        obj["confidence"] = 0.0
    return obj
```

#### (c) 하이브리드 resolver — 키워드 먼저, 안 걸리면 LLM
`classify_question`은 그대로 두고(빠른길), 그 위에 얇은 게이트를 얹습니다.

```python
MANUAL_SIGNALS = ["절차", "방법", "어떻게", "교체 기준", "보수 기준", "점검 기준",
                  "토크", "예비품", "특별점검", "매뉴얼", "지침", "조치 기준", "이상징후"]
INTENT_CONF_MIN = 0.6

def resolve_intent(message, tag, history=None):
    """(category, sub, manual_query, valveType, via, confidence)."""
    cat, sub, mq, valve = classify_question(message, tag)   # 1) 키워드 빠른길

    # 데이터 카테고리에 명확히 걸렸으면 그대로 사용
    if cat != "manual":
        return cat, sub, mq, valve, "keyword", 1.0
    # 진짜 매뉴얼 신호(절차/방법/기준)면 manual 유지
    if _any(message, MANUAL_SIGNALS):
        return cat, sub, mq, valve, "keyword", 1.0

    # 2) 키워드가 못 잡음 → LLM 분류 시도 (패러프레이즈 구제)
    try:
        llm = classify_intent_llm(message, tag, history)
    except Exception:
        llm = None
    if llm and llm["confidence"] >= INTENT_CONF_MIN:
        c, s = llm["category"], llm["sub"]
        mq2 = SUB_MANUAL_QUERY.get((c, s), message)
        return c, s, mq2, (llm.get("valveType") or "globe"), "llm", llm["confidence"]

    # 3) 저신뢰 → 되묻기 신호 (호출부에서 clarify 응답 생성)
    if llm:
        return llm["category"], llm["sub"], mq, valve, "low_conf", llm["confidence"]
    return "manual", "rag", message, "globe", "fallback", 0.0
```

#### (d) `make_chat` 연결 + 되묻기
`make_chat`(line 570)의 첫 줄만 교체하고, 저신뢰면 clarify를 반환합니다.

```python
def make_chat(message, tag, history=None):
    tag = tag or "GV-101A"
    category, sub, manual_query, valve, via, conf = resolve_intent(message, tag, history)

    # 저신뢰·모호 → 단정 대신 되묻기
    if via == "low_conf":
        return {"responseType": "ANSWER", "category": "clarify", "grounded": False,
                "clarify": True,
                "headline": "질문을 조금 더 구체화해 주세요",
                "answer": "혹시 '%s' 관련 질문일까요? 작업 공간/높이/추락 중 무엇이 궁금하신지 알려주시면 정확히 답하겠습니다." % category,
                "recommendation": "", "data": None, "sources": [], "manualExcerpt": None,
                "retrieval": {"source": "의도분류(LLM)", "query": message, "hitCount": 0, "owner": "ai"}}
    # ... 이하 기존 make_chat 본문(분류 결과를 그대로 사용) ...
    # (기존: category, sub, manual_query, valve = classify_question(message, tag)  ← 이 줄 삭제)

    # 디버깅/흐름 패널용으로 분류 출처를 응답에 실어두면 발표에 유용
    # out["intent"] = {"category": category, "sub": sub, "via": via, "confidence": conf}
```

### 2.3 클라이언트 변경 (`src/ai/classifier.js`)
지금 `isGroundedQuery` 키워드 게이트가 **패러프레이즈를 chat 진입 전에 차단**합니다. 게이트를 넓혀 **뷰어 조작이 아니면 일단 chat에 보내고, 분류는 서버가** 하게 합니다.

```js
async function requestAiResponse(request, opts) {
  opts = opts || {};
  if (opts.simulateError) { throw { status: 500, body: { error: "INTERNAL_ERROR", ... } }; }
  const text = request.message || "";

  // 1) 뷰어 조작(회전/숨김/이동 등)은 규칙으로 즉답 — 빠르고 결정적
  const ruleRes = classifyRuleBased(request);
  const isViewerAction = ruleRes.responseType === "ACTION" && !ruleRes._fallback;
  if (isViewerAction && !isGroundedQuery(text)) return ruleRes;

  // 2) 그 외는 통합 챗으로 — 키워드 미스(패러프레이즈)도 서버가 LLM으로 분류
  try {
    const ctx = request.viewerContext && request.viewerContext.currentTag;
    const r = await window.RagClient.chat(text, ctx, request.sessionId);
    if (r && (r.grounded || r.category === "manual" || r.clarify)) return adaptChat(r);
  } catch (e) { /* 서버/Ollama 미가동 → 아래 폴백 */ }

  // 3) (기존) 매뉴얼 직답 → 규칙 폴백 → LLM plan
  if (isManualQuery(text)) { /* ...기존... */ }
  if (!ruleRes._fallback) return ruleRes;
  try { /* ...기존 plan... */ } catch (e) {}
  return ruleRes;
}
```

> 핵심 효과: **"높은 데서 작업하나?"** 같은 문장이 이제
> 키워드 미스 → chat → 서버 `resolve_intent` → LLM이 `spatial·height`로 분류
> → **5단 리치 경로(`build_blocks`)로 진입**. (지금은 빈약한 plan 경로로 샜음)

### 2.4 검증용 미니 평가셋 (Phase 5의 씨앗)
바꾸기 **전에** 이 표부터 만들어 회귀를 막습니다. `docs/eval_intent.csv` 예:

```
message,expected_category,expected_sub
이 밸브 정비할 때 작업발판 필요해? 2m 이상 고소작업?,spatial,height
높은 데서 하는 작업이라 뭐 준비해야 하나?,spatial,height
사다리 타고 올라가서 해야 돼?,spatial,height
최근 누설 이력 고려하면 그랜드패킹 교체해야 해?,cycle,replace
그랜드패킹 교체한 적 있어?,maintenance,gasket
이 밸브 주변 좁지 않아?,spatial,clearance
정비 주기 지났나?,cycle,overdue
지금 몇 단계까지 했어?,workflow,current
```

간단 채점 스크립트(개념):
```python
# for each row: cat, sub, *_ = resolve_intent(msg, "GV-101A")
# accuracy = mean(cat==exp_cat and sub==exp_sub)
# 키워드 only vs 하이브리드 정확도를 비교 → 개선폭 수치화
```

### 2.5 적용 순서 & 리스크
1. (a)(b)(c) 추가 — `classify_question`은 **그대로 유지**(빠른길). → 기존 동작 불변.
2. (d) `make_chat` 첫 줄 교체 + clarify 분기.
3. 미니 평가셋으로 키워드-only ↔ 하이브리드 정확도 비교.
4. 클라 `requestAiResponse` 게이트 확장은 **마지막**(시연 영향 큼 → 평가 통과 후).
- 리스크: LLM 분류 지연(문장당 수백 ms~수 초) → 키워드 빠른길이 대부분 흡수하므로 LLM은 "키워드 미스"에만 호출. `num_predict=120`으로 짧게.
- 리스크: LLM 환각 카테고리 → `CATEGORY_SUBS` 화이트리스트로 폐기.
- 발표 안정성: Ollama 꺼지면 `resolve_intent`가 `fallback`(manual/rag) → 기존과 동일하게 동작.

---

## 3. Phase 2~6 한 단계 미리보기 (다음 작업 후보)

- **Phase 2 멀티턴**: `make_chat`/`resolve_intent`에 `history` 전달은 이미 시그니처에 있음. `_format_history`를 INTENT_PROMPT에 주입해 "그거/아까 그 밸브" 대용어 해소. 대화 상태 객체(`{tag, lastCategory, pendingSlot}`)를 세션에 저장.
- **Phase 3 RAG**: `search_manuals.search`에 BM25 결합(rank fusion) + `bge-reranker`로 재정렬. 쿼리 재작성(직전 맥락 합쳐 검색어 생성). 답변 문장↔청크 인용 매칭 검증.
- **Phase 4 에이전트**: `executePlan`을 관측→사고→행동 루프로. `QUERY_*` 결과를 LLM이 받아 다음 도구 선택("주기 초과 확인 → 작업오더 생성 제안").
- **Phase 5 평가**: 골든셋 확장(검색 Recall@k, 답변 faithfulness=RAGAS/LLM-judge), Langfuse 트레이싱, 👍/👎 수집.
- **Phase 6 운영**: 실 CMMS/Walkinside 어댑터(`db_*_all` 교체), SSE 스트리밍 응답, 안전 가드레일·감사 로그.

---

## 4. 공부 체크리스트 (이 로드맵 수행에 필요한 순서)

- [ ] **RAG 심화** — 청킹/임베딩/벡터DB(pgvector·FAISS)/**하이브리드 검색**/**리랭킹**/쿼리재작성, 평가(RAGAS·Recall@k·MRR)
- [ ] **Function calling·구조화 출력** — JSON schema 강제, **ReAct**, 에이전트 루프
- [ ] **대화 관리** — 의도분류/슬롯필링/**대화상태추적(DST)**/대용어 해소
- [ ] **LLMOps/평가** — 오프라인 평가셋, **LLM-as-judge**, 환각/충실도 측정, **트레이싱**(Langfuse)
- [ ] **LLM 기초** — 임베딩·어텐션 직관, 프롬프트 엔지니어링, 디코딩 파라미터/컨텍스트
- [ ] **서빙** — Ollama vs **vLLM**, 양자화, **스트리밍**, 캐싱, 지연 관리
- [ ] **도메인 모델링** — 설비 **온톨로지/지식그래프**(태그·계통·부품), CMMS 데이터 모델
- [ ] **백엔드** — 비동기 API, **SSE/WebSocket** 스트리밍, 인증·권한, 감사 로그

> 한 줄 원칙: **"평가셋을 먼저, 한 번에 하나만 바꿔, 점수로 확인."**
