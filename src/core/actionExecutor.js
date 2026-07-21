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

  // ── 2차: 작업 위치 안내 ──────────────────────────────────
  register("MOVE_TO_INSPECTION", {
    method: "moveToInspection",
    summary: (a) => q(a.targetValue || "선택"),
    args: (a) => ({ targetValue: a.targetValue }),
    call: (a) => ViewerSDK.moveToInspection(a.targetValue)
  });
  register("SHOW_PATH", {
    method: "showPath",
    summary: (a) => q(a.target),
    args: (a) => ({ target: a.target }),
    call: (a) => ViewerSDK.showPath(a.target)
  });
  register("SHOW_INSPECTION_ROUTE", {
    method: "showInspectionRoute",
    summary: () => "",
    args: () => ({}),
    call: () => ViewerSDK.showInspectionRoute()
  });
  register("FIND_NEAREST", {
    method: "findNearest",
    summary: () => q("inspection"),
    args: () => ({ filter: "inspection" }),
    call: () => ViewerSDK.findNearest()
  });
  register("SHOW_WORKER_POSITION", {
    method: "showWorkerPosition",
    summary: (a) => q(a.targetValue || "선택"),
    args: (a) => ({ targetValue: a.targetValue }),
    call: (a) => ViewerSDK.showWorkerPosition(a.targetValue)
  });

  // ── 3차(작업 조건): 정비 작업 구역 표시 ──────────────────
  register("SHOW_WORK_ZONE", {
    method: "showWorkZone",
    summary: (a) => q(a.targetValue || "선택"),
    args: (a) => ({ targetValue: a.targetValue }),
    call: (a) => ViewerSDK.showWorkZone(a.targetValue)
  });

  // ── [도면] 연관 P&ID 도면 표시 ───────────────────────────
  register("SHOW_PID", {
    method: "showPID",
    summary: (a) => q(a.targetValue || "선택"),
    args: (a) => ({ targetValue: a.targetValue }),
    call: (a) => ViewerSDK.showPID(a.targetValue)
  });

  // ══ 솔루션팀 액션 인터페이스 (docs/AI 채팅 구현.xlsx) ══════
  // ON/OFF는 params.on(true/false). 생략 시 켜기(true)로 간주.
  const onOf = (a) => !(a.params && a.params.on === false);

  // 뷰 프리셋 4종 → presetView(kind, tag)
  [["TOP_VIEW", "top", "topView"], ["FRONT_VIEW", "front", "frontView"],
   ["SIDE_VIEW", "side", "sideView"], ["ISO_VIEW", "iso", "isoView"]].forEach(([type, kind, method]) => {
    register(type, {
      method: method,
      summary: (a) => q(a.targetValue || "선택"),
      args: (a) => ({ targetType: a.targetType, targetValue: a.targetValue }),
      call: (a) => ViewerSDK.presetView(kind, a.targetValue)
    });
  });
  register("HOME", {
    method: "home", summary: () => "", args: () => ({}),
    call: () => ViewerSDK.home()
  });

  // 단면(클리핑)
  register("CLIP", {
    method: "clip",
    summary: (a) => `${q(a.targetValue || "선택")}, ${onOf(a) ? "ON" : "OFF"}`,
    args: (a) => ({ targetValue: a.targetValue, on: onOf(a) }),
    call: (a) => ViewerSDK.clip(a.targetValue, onOf(a))
  });
  register("CLIP_AXIS", {
    method: "clipAxis", summary: (a) => q(a.targetValue),
    args: (a) => ({ axis: a.targetValue }),
    call: (a) => ViewerSDK.clipAxis(a.targetValue)
  });
  register("CLIP_FLIP", {
    method: "clipFlip", summary: () => "", args: () => ({}),
    call: () => ViewerSDK.clipFlip()
  });
  register("CLIP_SIZE", {
    method: "clipSize", summary: (a) => String(a.targetValue),
    args: (a) => ({ size: a.targetValue }),
    call: (a) => ViewerSDK.clipSize(a.targetValue)
  });

  // 표시/숨김/선택
  register("SHOW_ONLY", {
    method: "showOnly",
    summary: (a) => `${a.targetType || "TAG"}:${q(a.targetValue)}`,
    args: (a) => ({ by: a.targetType || "TAG", value: a.targetValue }),
    call: (a) => ViewerSDK.showOnly({ by: a.targetType || "TAG", value: a.targetValue })
  });
  register("HIDE", {
    method: "hide",
    summary: (a) => `${a.targetType || "TAG"}:${q(a.targetValue)}`,
    args: (a) => ({ by: a.targetType || "TAG", value: a.targetValue }),
    call: (a) => ViewerSDK.hide({ by: a.targetType || "TAG", value: a.targetValue })
  });
  register("HIDE_ALL", {
    method: "hideAll", summary: () => "", args: () => ({}),
    call: () => ViewerSDK.hideAll()
  });
  register("SHOW_ALL", {
    method: "showAll", summary: () => "", args: () => ({}),
    call: () => ViewerSDK.show({ value: "ALL" })
  });
  register("UNSELECT_ALL", {
    method: "unselectAll", summary: () => "", args: () => ({}),
    call: () => ViewerSDK.unselectAll()
  });

  // 화면 요소
  register("AVATAR", {
    method: "avatar", summary: (a) => (onOf(a) ? "ON" : "OFF"),
    args: (a) => ({ on: onOf(a) }),
    call: (a) => ViewerSDK.avatar(onOf(a))
  });
  register("KEY_MAP", {
    method: "keyMap", summary: (a) => (onOf(a) ? "ON" : "OFF"),
    args: (a) => ({ on: onOf(a) }),
    call: (a) => ViewerSDK.keyMap(onOf(a))
  });

  // 연계 화면
  register("PID", {
    method: "showPID",
    summary: (a) => `${q(a.targetValue || "선택")}, ${onOf(a) ? "ON" : "OFF"}`,
    args: (a) => ({ targetValue: a.targetValue, on: onOf(a) }),
    call: (a) => onOf(a)
      ? ViewerSDK.showPID(a.targetValue)
      : (ViewerSDK.hidePID(), { ok: true, message: "P&ID 도면 닫힘" })
  });
  register("MONITORING", {
    method: "monitoring",
    summary: (a) => `${q(a.targetValue || "선택")}, ${onOf(a) ? "ON" : "OFF"}`,
    args: (a) => ({ targetValue: a.targetValue, on: onOf(a) }),
    call: (a) => ViewerSDK.monitoring(a.targetValue, onOf(a))
  });
  register("SEARCH", {
    method: "search",
    summary: (a) => q(a.targetValue),
    args: (a) => ({ query: a.targetValue }),
    call: (a) => ViewerSDK.searchEquipment(a.targetValue)
  });

  window.ActionExecutor = { register, executeAction, describe };
})();
