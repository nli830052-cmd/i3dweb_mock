/* ============================================================
 *  src/ai/ragClient.js  —  [AI팀 영역 · RAG 백엔드 클라이언트]
 *  유지보수 매뉴얼 RAG 검색 API(backend/rag_server.py) 호출.
 *  실제 데이터 소스가 브라우저 밖(파이썬+bge-m3)이라 fetch로 연결.
 *
 *  공개 API:
 *    RagClient.search(query, valveType, topK) -> Promise<{hitCount, grounded, hits[...]}>
 *    RagClient.BASE  (기본 http://localhost:8090)
 *
 *  서버 실행:  python backend/rag_server.py
 * ========================================================== */
(function () {
  "use strict";
  // 담당자님(AI팀) 데스크톱 로컬 서버 주소
  const BASE = window.AI_SERVER_BASE_URL || "http://192.168.0.210:8090";

  async function _post(path, query, valveType, topK) {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, valveType: valveType || undefined, topK: topK || 5 })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  // 검색만 (청크 반환)
  function search(query, valveType, topK) { return _post("/api/rag/search", query, valveType, topK); }
  // 검색 + LLM 종합 답변
  function answer(query, valveType, topK) { return _post("/api/rag/answer", query, valveType, topK); }

  // 박람회 상세질문 의도만 LLM이 분류. 답변 내용과 UI는 프런트의 검증된 고정 데이터 사용.
  async function demoIntent(message, sessionId) {
    const res = await fetch(BASE + "/api/ai/demo-intent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, sessionId: sessionId || undefined })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  async function recordContext(sessionId, user, assistant) {
    const res = await fetch(BASE + "/api/ai/context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId, user: user, assistant: assistant })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }
  // LLM action JSON 생성(plan)
  async function plan(query, currentTag, sessionId) {
    const res = await fetch(BASE + "/api/ai/plan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, currentTag: currentTag || undefined, sessionId: sessionId || undefined })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  // 통합 챗 (LLM+RAG+DB) — 5단 구조 답변. intent: plan이 분류한 의도 힌트(재분류 생략용)
  async function chat(message, currentTag, sessionId, intent) {
    const res = await fetch(BASE + "/api/ai/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, currentTag: currentTag || undefined,
        sessionId: sessionId || undefined, intent: intent || undefined })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  // LLM 백엔드 설정 조회 — {provider, model, engine, llmFirst}
  async function llmConfig() {
    const res = await fetch(BASE + "/api/ai/config");
    if (!res.ok) throw { status: res.status };
    return await res.json();
  }

  // [박람회] 점검 브리핑 대본 — {steps:[{say, action}], facts, generation}
  async function briefing(sessionId) {
    const res = await fetch(BASE + "/api/ai/briefing", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId || undefined })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  // [박람회] 사진 진단 — image: dataURL(base64), 진단+매뉴얼 근거 리치 답변
  async function vision(image, message, currentTag) {
    const res = await fetch(BASE + "/api/ai/vision", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: image, message: message || undefined, currentTag: currentTag || undefined })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  window.RagClient = { search, answer, demoIntent, recordContext, plan, chat, llmConfig, briefing, vision, BASE };
})();
