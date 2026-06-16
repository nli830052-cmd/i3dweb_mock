/* ============================================================
 *  src/core/actionExecutor.js  —  [연결고리 / Frontend]
 *  AI 응답(action.type)을 Viewer SDK 호출로 번역하는 레이어.
 *  레지스트리에 타입별로 { method, summary, args, call } 을 등록한다.
 *    - method  : 실제 SDK 함수명 (흐름 패널 표기용)
 *    - summary : 흐름 패널 endpoint 괄호 안 요약
 *    - args    : 흐름 패널 payload.args
 *    - call    : 실제 실행 → ViewerSDK 호출
 *
 *  공개 API:
 *    ActionExecutor.executeAction(action) -> { ok, ... }
 *    ActionExecutor.describe(action)      -> { endpoint, payload }  (흐름 패널용)
 *    ActionExecutor.register(type, spec)
 *
 *  ★ 새 Action 타입 추가 = 여기서 register 한 줄.
 * ========================================================== */
(function () {
  "use strict";

  const registry = {};
  function register(type, spec) { registry[type] = spec; }

  function executeAction(action) {
    const spec = registry[action.type];
    if (!spec) {
      console.warn("지원하지 않는 action type입니다:", action.type);
      return { ok: false, error: "UNSUPPORTED_ACTION", message: `지원하지 않는 action type: ${action.type}` };
    }
    return spec.call(action);
  }

  function describe(action) {
    const spec = registry[action.type];
    if (!spec) return { endpoint: `i3dwebViewer.<unknown>(${action.type})`, payload: { method: null, args: action } };
    const summary = spec.summary ? spec.summary(action) : "";
    const args = spec.args ? spec.args(action) : {};
    return { endpoint: `i3dwebViewer.${spec.method}(${summary})`, payload: { method: spec.method, args } };
  }

  const q = (s) => `"${s}"`;

  // ── 기본 등록: 솔루션팀 ViewerSDK 매핑 ───────────────────
  register("JUMP_TO", {
    method: "jumpToTag",
    summary: (a) => q(a.targetValue),
    args: (a) => ({ targetType: a.targetType, targetValue: a.targetValue, params: a.params }),
    call: (a) => ViewerSDK.jumpToTag(a.targetValue, a.params)
  });
  register("SEARCH_EQUIPMENT", {
    method: "searchEquipment",
    summary: (a) => q(a.query),
    args: (a) => ({ query: a.query }),
    call: (a) => ViewerSDK.searchEquipment(a.query)
  });
  register("ROTATE_VIEW", {
    method: "rotateView",
    summary: (a) => `${q((a.params && a.params.direction) || "back")}, ${(a.params && a.params.angle) || 180}`,
    args: (a) => ({ direction: (a.params && a.params.direction) || "back", angle: (a.params && a.params.angle) || 180 }),
    call: (a) => ViewerSDK.rotateView((a.params && a.params.direction) || "back", (a.params && a.params.angle) || 180)
  });
  register("HIDE_OBJECT", {
    method: "hide",
    summary: (a) => `${a.targetType}:${q(a.targetValue)}`,
    args: (a) => ({ by: a.targetType, value: a.targetValue }),
    call: (a) => ViewerSDK.hide({ by: a.targetType, value: a.targetValue })
  });
  register("SHOW_OBJECT", {
    method: "show",
    summary: (a) => `${a.targetType}:${q(a.targetValue)}`,
    args: (a) => ({ by: a.targetType, value: a.targetValue }),
    call: (a) => ViewerSDK.show({ by: a.targetType, value: a.targetValue })
  });
  register("ISOLATE_SYSTEM", {
    method: "isolateSystem",
    summary: (a) => q(a.targetValue || "현재 계통"),
    args: (a) => ({ system: a.targetValue }),
    call: (a) => ViewerSDK.isolateSystem(a.targetValue)
  });
  register("FILTER_BY_TYPE", {
    method: "filterByType",
    summary: (a) => q(a.targetValue),
    args: (a) => ({ type: a.targetValue }),
    call: (a) => ViewerSDK.filterByType(a.targetValue)
  });

  window.ActionExecutor = { register, executeAction, describe };
})();
