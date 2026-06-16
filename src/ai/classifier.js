/* ============================================================
 *  src/ai/classifier.js  —  [AI팀 영역]
 *  AI 백엔드 stand-in. POST /api/ai/chat 의 처리부를 흉내낸다.
 *
 *  공개 API:
 *    AiBackend.requestAiResponse(request, opts)  -> Promise<응답 JSON>
 *      - 성공: { responseType, message, answer, actions, confidence }
 *      - 실패: throw { status: 500, body: { error, message, requestId } }
 *
 *  ★ 새 기능(고도화)은 전부 이 파일에서:
 *    - 실제 LLM 호출   : classifyRuleBased() → fetch('/api/ai/chat') 또는 LLM SDK 호출로 교체
 *    - responseType 추가: RESPONSE_TYPES + classify 로직에 분기 추가
 *    - 설비정보(RAG)    : buildAnswer()에서 외부 조회 결과를 합성
 *  ↑ UI/Viewer/ActionExecutor는 건드릴 필요 없음 (인터페이스만 유지).
 * ========================================================== */
(function () {
  "use strict";

  // ── 분류용 사전(규칙기반 mock) ───────────────────────────
  const TAG_RE = /[A-Z]{2,}-[A-Z]{2,}-\d{1,}/i;            // 예: TG-BRG-002
  const ACTION_WORDS = ["이동", "가줘", "가자", "찾아", "보여", "선택", "위치로", "이동해", "데려"];
  const ANSWER_WORDS = ["뭐", "어떤", "무엇", "알려", "설명", "절차", "방법", "의미", "원인", "왜", "어떻게", "인지", "정보", "스펙", "사양"];

  const RESPONSE_TYPES = ["ANSWER", "ACTION", "ANSWER_WITH_ACTION"]; // 확장 시 여기에 추가

  /**
   * 자연어 → 응답 JSON (현재: 규칙기반 mock).
   * 추후 실제 LLM으로 교체할 지점. request.viewerContext 등 맥락 활용 가능.
   */
  function classifyRuleBased(request) {
    const text = request.message || "";
    const tagMatch = text.match(TAG_RE);
    const targetValue = tagMatch ? tagMatch[0].toUpperCase() : null;

    const hasAction = ACTION_WORDS.some((w) => text.includes(w)) && !!targetValue;
    const hasAnswer = ANSWER_WORDS.some((w) => text.includes(w));

    let responseType;
    if (hasAction && hasAnswer) responseType = "ANSWER_WITH_ACTION";
    else if (hasAction) responseType = "ACTION";
    else responseType = "ANSWER";

    const actions = [];
    if (responseType === "ACTION" || responseType === "ANSWER_WITH_ACTION") {
      actions.push({ type: "JUMP_TO", targetType: "TAG", targetValue: targetValue, params: {} });
    }

    let message, answer = null, confidence;
    switch (responseType) {
      case "ACTION":
        message = `${targetValue} 위치로 이동합니다.`;
        confidence = 0.95;
        break;
      case "ANSWER":
        message = targetValue ? `${targetValue} 정보를 조회합니다.` : "질문에 답변합니다.";
        answer = buildAnswer(targetValue, text);
        confidence = 0.82;
        break;
      case "ANSWER_WITH_ACTION":
        message = `${targetValue} 위치로 이동하고 관련 정보를 안내합니다.`;
        answer = buildAnswer(targetValue, text);
        confidence = 0.88;
        break;
    }
    return { responseType, message, answer, actions, confidence };
  }

  /** 답변 본문 생성 (현재: mock. 추후 RAG/설비DB 결과 합성 지점). */
  function buildAnswer(tag, text) {
    if (!tag) {
      return "요청을 정확히 이해하지 못했습니다. 대상 설비 Tag(예: TG-BRG-002)를 포함해 다시 질문해 주세요.";
    }
    if (text.includes("절차") || text.includes("점검") || text.includes("방법")) {
      return `${tag} 점검 시에는 먼저 설비 상태를 확인하고, 윤활 상태 → 진동 이상 여부 → 온도 상승 여부 순으로 점검합니다. (mock 답변 · 실제 절차는 정비 지침서 연계 후 제공)`;
    }
    return `${tag}는 해당 계통과 관련된 설비로 추정됩니다. (mock 답변 · 정확한 정보는 설비 마스터 데이터 연계 후 확인 필요)`;
  }

  /**
   * AI 백엔드 호출 진입점 (HTTP POST /api/ai/chat 흉내).
   * @param {object} request  { sessionId, message, viewerContext }
   * @param {object} [opts]   { simulateError?: boolean }
   * @returns {Promise<object>} 응답 JSON
   *
   * 실제 연동 시 이 본문을:
   *   const r = await fetch('/api/ai/chat', { method:'POST', body: JSON.stringify(request) });
   *   if (!r.ok) throw { status: r.status, body: await r.json() };
   *   return await r.json();
   * 로 교체.
   */
  async function requestAiResponse(request, opts) {
    opts = opts || {};
    if (opts.simulateError) {
      throw {
        status: 500,
        body: {
          error: "INTERNAL_ERROR",
          message: "AI 응답 생성 중 오류가 발생했습니다.",
          requestId: (request.sessionId || "sess") + "-" + Date.now()
        }
      };
    }
    return classifyRuleBased(request);
  }

  window.AiBackend = { requestAiResponse, RESPONSE_TYPES };
})();
