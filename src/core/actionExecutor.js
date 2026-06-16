/* ============================================================
 *  src/core/actionExecutor.js  —  [연결고리 / Frontend]
 *  AI 응답(action.type)과 Viewer SDK 호출을 잇는 번역 레이어.
 *  "JUMP_TO 같은 약속어"를 "jumpToTag 같은 실제 함수"로 매핑한다.
 *
 *  공개 API:
 *    ActionExecutor.executeAction(action) -> { ok, ... }
 *    ActionExecutor.register(type, handler)   // 새 action 타입 등록
 *
 *  ★ 새 Action 타입(HIGHLIGHT, SHOW_POPUP 등) 추가 시: 여기서 register만 하면 됨.
 *    예) ActionExecutor.register("HIGHLIGHT", (a) => ViewerSDK.highlightTag(a.targetValue));
 * ========================================================== */
(function () {
  "use strict";

  const handlers = {};

  function register(type, handler) { handlers[type] = handler; }

  function executeAction(action) {
    const handler = handlers[action.type];
    if (!handler) {
      console.warn("지원하지 않는 action type입니다:", action.type);
      return { ok: false, error: "UNSUPPORTED_ACTION", message: `지원하지 않는 action type: ${action.type}` };
    }
    return handler(action);
  }

  // ── 기본 등록: JUMP_TO → 솔루션팀 ViewerSDK.jumpToTag ──────
  register("JUMP_TO", (action) => ViewerSDK.jumpToTag(action.targetValue, action.params));

  window.ActionExecutor = { register, executeAction };
})();
