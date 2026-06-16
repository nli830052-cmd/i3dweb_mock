/* ============================================================
 *  src/ai/classifier.js  —  [AI팀 영역]
 *  AI 백엔드 stand-in. 자연어 → responseType + actions JSON.
 *  현재: 규칙기반 mock. 추후 requestAiResponse() 본문을 실제 LLM 호출로 교체.
 *
 *  지원 의도(1차: 설비 찾기/조작):
 *    JUMP_TO · SEARCH_EQUIPMENT · ROTATE_VIEW
 *    HIDE_OBJECT · SHOW_OBJECT · ISOLATE_SYSTEM · FILTER_BY_TYPE
 *  그 외는 ANSWER(설명/목록/연결계통 등 mock 답변).
 *
 *  ★ 고도화 지점: 실제 LLM/RAG는 모두 이 파일에서.
 * ========================================================== */
(function () {
  "use strict";

  // 태그: TG-BRG-002, GV-101A, TGLOP-001, HX-301 등
  const TAG_RE = /\b[A-Z]{1,5}(?:-[A-Z0-9]{1,5}){1,2}\b/i;
  const TYPE_KO = { "펌프": "PUMP", "밸브": "VALVE", "모터": "MOTOR", "베어링": "BEARING", "열교환기": "HEATEX", "탱크": "TANK" };
  const RESPONSE_TYPES = ["ANSWER", "ACTION", "ANSWER_WITH_ACTION"];

  function detectType(text) {
    for (const ko in TYPE_KO) if (text.includes(ko)) return { code: TYPE_KO[ko], ko: ko };
    return null;
  }
  function detectSystem(text) {
    if (text.includes("터빈 윤활유") || text.includes("윤활유")) return "터빈 윤활유 계통";
    if (text.includes("냉각수")) return "냉각수 계통";
    if (text.includes("터빈")) return "터빈 계통";
    return null;
  }
  function extractTag(text) {
    const m = text.toUpperCase().match(TAG_RE);
    return m ? m[0] : null;
  }
  const has = (text, words) => words.some((w) => text.includes(w));
  const action = (a) => Object.assign({ params: {} }, a);

  /** 자연어 → 응답 JSON (규칙기반 mock) */
  function classifyRuleBased(request) {
    const text = request.message || "";
    const tag = extractTag(text);
    const type = detectType(text);

    // 1) 숨김
    if (has(text, ["숨겨", "숨김", "안 보이게", "안보이게", "꺼줘", "끄기", "가려"]) && !has(text, ["다시"])) {
      const sel = tag ? { targetType: "TAG", targetValue: tag } : (type ? { targetType: "TYPE", targetValue: type.code } : null);
      if (sel) return mkAction("HIDE_OBJECT", action(Object.assign({ type: "HIDE_OBJECT" }, sel)),
        `${tag || (type && type.ko) || "선택"} 객체를 숨김 처리합니다. 다시 보려면 "다시 보여줘"라고 입력하세요.`);
    }
    // 2) 다시 표시
    if (has(text, ["다시 보여", "다시 표시", "다시 켜", "보이게 해", "켜줘"])) {
      let sel;
      if (has(text, ["전체", "모두", "다 보여", "전부"])) sel = { targetType: "ALL", targetValue: "ALL" };
      else if (type) sel = { targetType: "TYPE", targetValue: type.code };
      else if (tag) sel = { targetType: "TAG", targetValue: tag };
      else sel = { targetType: "ALL", targetValue: "ALL" };
      return mkAction("SHOW_OBJECT", action(Object.assign({ type: "SHOW_OBJECT" }, sel)),
        `${type ? type.ko : (tag || "전체")} 객체를 다시 표시합니다.`);
    }
    // 3) 계통만 보기 (격리)
    if (text.includes("계통") && has(text, ["만", "위주", "따로"])) {
      const sys = detectSystem(text);
      return mkAction("ISOLATE_SYSTEM", action({ type: "ISOLATE_SYSTEM", targetValue: sys }),
        "선택한 계통의 설비만 표시합니다. 다른 계통의 배관·밸브·장비는 임시 숨김 처리합니다.");
    }
    // 4) 타입만 보기 (필터)
    if (type && has(text, ["만 보여", "만 표시", "만 봐", "만 남겨", "만 켜"])) {
      return mkAction("FILTER_BY_TYPE", action({ type: "FILTER_BY_TYPE", targetValue: type.code }),
        `${type.ko} 객체만 표시합니다. 나머지 설비는 숨김 처리합니다.`);
    }
    // 5) 시점 회전
    if (has(text, ["뒷면", "후면", "뒤에서", "뒤쪽", "뒤집", "돌려", "회전", "측면", "옆면", "옆에서"])) {
      const dir = has(text, ["측면", "옆면", "옆에서"]) ? "left" : "back";
      const angle = dir === "back" ? 180 : 90;
      return mkAction("ROTATE_VIEW", action({ type: "ROTATE_VIEW", params: { direction: dir, angle: angle } }),
        `선택한 장비의 ${dir === "back" ? "후면" : "측면"} 방향으로 View를 전환합니다. 장비 중심 기준 ${angle}도 회전합니다.`);
    }
    // 6) 검색 (태그 없이 이름/타입으로 찾기)
    if (has(text, ["찾아", "검색", "어디"]) && !tag) {
      const query = text.replace(/(찾아\S*|검색\S*|어디\S*|보여\S*|줘|해줘|알려\S*|있어\S*)/g, "").trim() || (type && type.ko) || text;
      return mkAction("SEARCH_EQUIPMENT", action({ type: "SEARCH_EQUIPMENT", query: query }),
        `"${query}" 설비를 검색합니다. 가장 가까운 설비로 이동하고 속성정보를 표시합니다.`);
    }
    // 7) 이동 (태그 기반)
    if (tag && has(text, ["이동", "가줘", "가자", "안내", "위치", "찾아", "보여", "데려"])) {
      return mkAction("JUMP_TO", action({ type: "JUMP_TO", targetType: "TAG", targetValue: tag }),
        `${tag} 위치를 찾았습니다. 현재 화면을 해당 설비 위치로 이동하고 강조 표시합니다.`);
    }
    // 8) 그 외 → ANSWER (설명/목록/연결계통 등)
    return mkAnswer(tag, type, text);
  }

  function mkAction(_label, act, message) {
    return { responseType: "ACTION", message: message, answer: null, actions: [act], confidence: 0.93 };
  }

  function mkAnswer(tag, type, text) {
    let answer;
    if (text.includes("연결") && text.includes("계통")) {
      answer = `선택한 설비는 터빈 윤활유 계통에 연결되어 있습니다. 관련 P&ID와 상·하류 연결 설비도 확인할 수 있습니다. (mock · 실제는 토폴로지 DB 연계)`;
    } else if (text.includes("목록") || text.includes("리스트")) {
      answer = `현재 구역의 주요 설비는 펌프 3개, 밸브 3개, 열교환기 1개, 모터 1개, 탱크 1개입니다. 목록에서 설비를 선택하면 해당 위치로 이동할 수 있습니다. (mock)`;
    } else if (tag || type) {
      answer = `${tag || (type && type.ko)}에 대한 정보입니다. 해당 계통과 관련된 설비로 추정됩니다. (mock · 정확한 정보는 설비 마스터/RAG 연계 후 확인 필요)`;
    } else {
      answer = "요청을 정확히 이해하지 못했습니다. 설비 Tag(예: TG-BRG-002)나 '펌프 찾아줘'처럼 다시 입력해 주세요.";
    }
    return { responseType: "ANSWER", message: "요청을 처리합니다.", answer: answer, actions: [], confidence: 0.8 };
  }

  /**
   * AI 백엔드 호출 진입점 (HTTP POST /api/ai/chat 흉내).
   * 실제 연동 시 fetch('/api/ai/chat')로 교체.
   */
  async function requestAiResponse(request, opts) {
    opts = opts || {};
    if (opts.simulateError) {
      throw { status: 500, body: { error: "INTERNAL_ERROR", message: "AI 응답 생성 중 오류가 발생했습니다.", requestId: (request.sessionId || "sess") + "-" + Date.now() } };
    }
    return classifyRuleBased(request);
  }

  window.AiBackend = { requestAiResponse, RESPONSE_TYPES };
})();
