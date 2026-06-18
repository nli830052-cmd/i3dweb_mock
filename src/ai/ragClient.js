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
  const BASE = "http://localhost:8090";

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
  // LLM 의도 분류
  function route(query) { return _post("/api/ai/route", query); }
  // LLM action JSON 생성(plan)
  async function plan(query, currentTag) {
    const res = await fetch(BASE + "/api/ai/plan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, currentTag: currentTag || undefined })
    });
    if (!res.ok) throw { status: res.status, body: await res.json().catch(() => ({})) };
    return await res.json();
  }

  window.RagClient = { search, answer, route, plan, BASE };
})();
