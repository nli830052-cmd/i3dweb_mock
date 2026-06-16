/* ============================================================
 *  src/viewer/mockViewer.js  —  [솔루션팀 영역]
 *  i3DWEB Viewer SDK stand-in. 씬(scene)과 가시성/시점 상태를 들고,
 *  jumpToTag 외에 검색·숨김·격리·회전 등을 mock으로 수행한다.
 *  실제 SDK 수령 시 이 파일을 어댑터로 교체 (공개 API 시그니처 유지).
 *
 *  공개 API (모두 { ok, ... } 반환):
 *    ViewerSDK.jumpToTag(tag, params)
 *    ViewerSDK.searchEquipment(query)
 *    ViewerSDK.rotateView(direction, angle)
 *    ViewerSDK.hide(selector)        selector: { by:"TYPE"|"TAG", value }
 *    ViewerSDK.show(selector)        value === "ALL" 이면 전체 표시
 *    ViewerSDK.isolateSystem(system) system 생략 시 현재 선택 객체의 계통
 *    ViewerSDK.filterByType(type)
 *    ViewerSDK.KNOWN_TAGS
 * ========================================================== */
(function () {
  "use strict";

  // ── 씬: Viewer가 로드한 것으로 간주하는 객체들 ────────────
  // (실제 SDK에선 Viewer가 보유. 여기선 mock 데이터)
  // dist: 현재 위치 기준 mock 거리(m), inspect: 오늘 점검 대상 여부, height: 작업 위치 높이(m)
  const SCENE = [
    { tag: "TG-BRG-002", type: "BEARING", name: "터빈 베어링",     system: "터빈 계통",       dist: 9.0,  inspect: false, height: 1.2 },
    { tag: "TG-MOT-310", type: "MOTOR",   name: "구동 모터",       system: "터빈 계통",       dist: 11.0, inspect: false, height: 1.0 },
    { tag: "TGLOP-001",  type: "PUMP",    name: "터빈 윤활유 펌프", system: "터빈 윤활유 계통", dist: 6.0,  inspect: false, height: 1.1 },
    { tag: "TG-PMP-101", type: "PUMP",    name: "터빈 윤활유 펌프", system: "터빈 윤활유 계통", dist: 7.2,  inspect: true,  height: 1.1 },
    { tag: "TG-PMP-102", type: "PUMP",    name: "터빈 윤활유 펌프", system: "터빈 윤활유 계통", dist: 14.0, inspect: false, height: 1.1 },
    { tag: "TG-VLV-205", type: "VALVE",   name: "제어 밸브",       system: "터빈 윤활유 계통", dist: 8.5,  inspect: false, height: 1.6 },
    { tag: "TG-TNK-007", type: "TANK",    name: "윤활유 탱크",     system: "터빈 윤활유 계통", dist: 16.0, inspect: false, height: 0.5 },
    { tag: "GV-101A",    type: "VALVE",   name: "글로브 밸브",     system: "냉각수 계통",     dist: 4.8,  inspect: true,  height: 2.3 },
    { tag: "GV-102A",    type: "VALVE",   name: "게이트 밸브",     system: "냉각수 계통",     dist: 12.5, inspect: true,  height: 0.9 },
    { tag: "HX-301",     type: "HEATEX",  name: "열교환기",        system: "냉각수 계통",     dist: 20.1, inspect: true,  height: 3.0 }
  ];

  const TYPE_KO = { PUMP: "펌프", VALVE: "밸브", MOTOR: "모터", BEARING: "베어링", HEATEX: "열교환기", TANK: "탱크" };
  const TYPE_ICON = { PUMP: "⚙️", VALVE: "🔧", MOTOR: "🔌", BEARING: "🛞", HEATEX: "♨️", TANK: "🛢️" };

  const KNOWN_TAGS = new Set(SCENE.map((o) => o.tag));

  // ── 상태 ─────────────────────────────────────────────────
  const state = {
    visible: new Set(SCENE.map((o) => o.tag)), // 보이는 태그
    selected: null,                            // 현재 선택/이동 태그
    viewDir: "front",                          // 시점 방향
    filterLabel: "",                           // 화면 상단 필터 설명
    info: ""                                   // 하단 안내(경로/거리/순서) HTML
  };

  const byTag = (tag) => SCENE.find((o) => o.tag === tag);

  /* ── 이동 ────────────────────────────────────────────── */
  function jumpToTag(tag, params) {
    log("jumpToTag", tag, params); state.info = "";
    if (!KNOWN_TAGS.has(tag)) { render("error"); state.selected = tag; renderTag(tag, "JUMP_TO failed · TAG_NOT_FOUND", true);
      return { ok: false, error: "TAG_NOT_FOUND", message: `${tag} 태그를 Viewer에서 찾을 수 없습니다.` }; }
    state.selected = tag;
    state.visible.add(tag); // 숨겨져 있었어도 이동 시 표시
    renderTag(tag, "JUMP_TO executed · moved", false);
    render("moved");
    return { ok: true, movedTo: tag, status: "moved", message: `${tag} 위치로 이동 처리 완료` };
  }

  /* ── 검색 ────────────────────────────────────────────── */
  function searchEquipment(query) {
    log("searchEquipment", query); state.info = "";
    const matches = matchObjects(query);
    if (matches.length === 0) {
      return { ok: false, error: "NO_MATCH", message: `"${query}"에 해당하는 설비를 찾지 못했습니다.` };
    }
    const nearest = matches[0]; // mock: 첫 매치를 "가장 가까운"으로 간주
    state.selected = nearest.tag;
    matches.forEach((m) => state.visible.add(m.tag));
    state.filterLabel = `검색: "${query}"`;
    renderTag(nearest.tag, `SEARCH · ${matches.length}건`, false);
    render("moved", new Set(matches.map((m) => m.tag)));
    return {
      ok: true, count: matches.length,
      matches: matches.map((m) => m.tag),
      nearest: nearest.tag,
      message: `${matches.length}건 검색됨 · 가장 가까운 설비 ${nearest.tag}(으)로 이동`
    };
  }

  /* ── 시점 회전 ───────────────────────────────────────── */
  function rotateView(direction, angle) {
    log("rotateView", direction, angle); state.info = "";
    state.viewDir = direction || "back";
    renderTopbar();
    render();
    return { ok: true, viewDir: state.viewDir, angle: angle || 180, message: `${dirKo(state.viewDir)} 방향으로 시점 전환 (${angle || 180}°)` };
  }

  /* ── 숨김 / 표시 ─────────────────────────────────────── */
  function hide(selector) {
    log("hide", selector); state.info = "";
    const targets = selectObjects(selector);
    targets.forEach((o) => state.visible.delete(o.tag));
    state.filterLabel = `${describeSel(selector)} 숨김`;
    render();
    return { ok: true, hiddenCount: targets.length, message: `${describeSel(selector)} ${targets.length}개 숨김 처리` };
  }

  function show(selector) {
    log("show", selector); state.info = "";
    let targets;
    if (!selector || selector.value === "ALL") {
      targets = SCENE; state.filterLabel = "";
    } else {
      targets = selectObjects(selector); state.filterLabel = "";
    }
    targets.forEach((o) => state.visible.add(o.tag));
    render();
    return { ok: true, shownCount: targets.length, message: `${selector && selector.value !== "ALL" ? describeSel(selector) : "전체"} ${targets.length}개 다시 표시` };
  }

  /* ── 계통 격리 ───────────────────────────────────────── */
  function isolateSystem(system) {
    log("isolateSystem", system); state.info = "";
    const sel = state.selected && byTag(state.selected);
    const sys = system || (sel && sel.system) || "터빈 윤활유 계통"; // mock: 선택 없으면 기본 계통
    const keep = SCENE.filter((o) => o.system === sys);
    state.visible = new Set(keep.map((o) => o.tag));
    state.filterLabel = `계통: ${sys}만 표시`;
    render();
    return { ok: true, system: sys, shownCount: keep.length, hiddenCount: SCENE.length - keep.length, message: `${sys}만 표시 (${keep.length}개), 나머지 ${SCENE.length - keep.length}개 숨김` };
  }

  /* ── 타입 필터 ───────────────────────────────────────── */
  function filterByType(type) {
    log("filterByType", type); state.info = "";
    const keep = SCENE.filter((o) => o.type === type);
    if (keep.length === 0) return { ok: false, error: "NO_MATCH", message: `${TYPE_KO[type] || type} 타입 객체가 없습니다.` };
    state.visible = new Set(keep.map((o) => o.tag));
    state.filterLabel = `${TYPE_KO[type] || type}만 표시`;
    render();
    return { ok: true, type: type, shownCount: keep.length, message: `${TYPE_KO[type] || type} ${keep.length}개만 표시, 나머지 숨김` };
  }

  /* ── [작업 위치 안내] 점검 위치로 이동 ────────────────── */
  function moveToInspection(tag) {
    log("moveToInspection", tag);
    const t = tag || state.selected || "TG-PMP-101";
    const o = byTag(t);
    if (!o) return { ok: false, error: "TAG_NOT_FOUND", message: `${t} 설비를 찾을 수 없습니다.` };
    state.selected = t; state.visible.add(t);
    renderTag(t, "MOVE_TO_INSPECTION · 점검 위치", false);
    renderInfo(`🧭 점검 위치 이동 · <b>${t}</b> · 작업자는 설비 전면 기준 약 <b>1.5m</b> 거리에서 점검`);
    render("moved");
    return { ok: true, movedTo: t, standoff: "1.5m", message: `${t} 점검 위치로 이동 (전면 1.5m)` };
  }

  /* ── [작업 위치 안내] 경로 표시 ───────────────────────── */
  function showPath(target) {
    log("showPath", target);
    let info, dist, note = "";
    if (target === "EMERGENCY_EXIT") { dist = 35; info = `🚪 비상 탈출 경로 · 가장 가까운 비상구까지 약 <b>${dist}m</b>`; }
    else if (target === "OPERATION_POS") { dist = 18; note = "계단 구간 포함"; info = `🧭 조작 위치까지 경로 · 약 <b>${dist}m</b> · ${note}`; }
    else {
      const o = byTag(target);
      if (!o) return { ok: false, error: "TAG_NOT_FOUND", message: `${target} 설비를 찾을 수 없습니다.` };
      dist = o.dist; state.selected = target; state.visible.add(target);
      info = `🧭 <b>${target}</b>까지 경로 · 약 <b>${dist}m</b>`;
    }
    renderTag(state.selected || "—", "SHOW_PATH · 경로 표시", false);
    renderInfo(info);
    render("moved");
    return { ok: true, target: target, distanceM: dist, note: note, message: `경로 표시 (${target}, 약 ${dist}m${note ? ", " + note : ""})` };
  }

  /* ── [작업 위치 안내] 오늘 점검 순서 라우팅 ───────────── */
  function showInspectionRoute() {
    log("showInspectionRoute");
    const route = SCENE.filter((o) => o.inspect).sort((a, b) => a.dist - b.dist);
    if (route.length === 0) return { ok: false, error: "NO_TARGET", message: "오늘 점검 대상이 없습니다." };
    const order = route.map((o) => o.tag);
    state.selected = order[0];
    renderTag(order[0], `INSPECTION_ROUTE · ${order.length}개소`, false);
    renderInfo(`🗺️ 오늘 점검 순서 (총 ${order.length}개소) · ${order.join(" → ")} · 첫 위치로 안내`);
    render("moved", new Set(order));
    return { ok: true, count: order.length, order: order, first: order[0], message: `점검 경로 ${order.length}개소: ${order.join(" → ")}` };
  }

  /* ── [작업 위치 안내] 가장 가까운 점검 대상 ───────────── */
  function findNearest() {
    log("findNearest");
    const targets = SCENE.filter((o) => o.inspect).sort((a, b) => a.dist - b.dist);
    if (targets.length === 0) return { ok: false, error: "NO_TARGET", message: "점검 대상이 없습니다." };
    const n = targets[0];
    state.selected = n.tag; state.visible.add(n.tag);
    renderTag(n.tag, "FIND_NEAREST · 최근접 점검", false);
    renderInfo(`📍 가장 가까운 점검 대상 · <b>${n.tag}</b> · 약 <b>${n.dist}m</b> (오늘 점검 등록됨)`);
    render("moved", new Set([n.tag]));
    return { ok: true, nearest: n.tag, distanceM: n.dist, message: `가장 가까운 점검 대상 ${n.tag} (약 ${n.dist}m)` };
  }

  /* ── [작업 위치 안내] 점검자 위치 표시 ────────────────── */
  function showWorkerPosition(tag) {
    log("showWorkerPosition", tag);
    const t = tag || state.selected || "TG-PMP-101";
    const o = byTag(t);
    if (!o) return { ok: false, error: "TAG_NOT_FOUND", message: `${t} 설비를 찾을 수 없습니다.` };
    state.selected = t; state.visible.add(t);
    renderTag(t, "WORKER_POSITION · 점검자 위치", false);
    renderInfo(`🧍 점검자 위치 · <b>${t}</b> 우측 점검공간 · 베어링부·씰부 확인 가능`);
    render("moved");
    return { ok: true, tag: t, message: `${t} 점검자 위치 표시 (우측 점검공간)` };
  }

  /* ── 매칭 헬퍼 ───────────────────────────────────────── */
  function matchObjects(query) {
    const q = (query || "").toLowerCase();
    const typeKey = koToType(query);
    return SCENE.filter((o) => {
      if (typeKey && o.type === typeKey) return true;
      return o.name.toLowerCase().includes(q) && q.length > 1;
    });
  }
  function selectObjects(selector) {
    if (!selector) return [];
    if (selector.by === "TAG") return SCENE.filter((o) => o.tag === selector.value);
    if (selector.by === "TYPE") return SCENE.filter((o) => o.type === selector.value);
    return [];
  }
  function koToType(text) {
    if (!text) return null;
    for (const t in TYPE_KO) if (text.includes(TYPE_KO[t])) return t;
    return null;
  }
  function describeSel(sel) {
    if (!sel) return "객체";
    if (sel.by === "TYPE") return TYPE_KO[sel.value] || sel.value;
    return sel.value;
  }
  function dirKo(d) { return { front: "전면", back: "후면", left: "좌측", right: "우측" }[d] || d; }

  /* ── 화면 표현 (#viewer) ─────────────────────────────── */
  function els() {
    return {
      box: document.getElementById("viewer"),
      tag: document.getElementById("viewerTag"),
      status: document.getElementById("viewerStatus"),
      scene: document.getElementById("scene"),
      dir: document.getElementById("viewDir"),
      filter: document.getElementById("viewFilter"),
      info: document.getElementById("viewerInfo")
    };
  }
  function renderInfo(html) { state.info = html || ""; }
  function renderTag(tag, statusText, isError) {
    const e = els();
    if (e.tag) e.tag.textContent = tag;
    if (e.status) { e.status.textContent = statusText; e.status.className = "status" + (isError ? " err" : ""); }
  }
  function renderTopbar() {
    const e = els();
    if (e.dir) e.dir.textContent = dirKo(state.viewDir);
    if (e.filter) e.filter.textContent = state.filterLabel || "전체 표시";
  }
  function render(anim, highlightSet) {
    const e = els();
    renderTopbar();
    if (e.info) e.info.innerHTML = state.info;
    if (e.scene) {
      e.scene.innerHTML = SCENE.map((o) => {
        const vis = state.visible.has(o.tag);
        const sel = o.tag === state.selected;
        const hot = highlightSet && highlightSet.has(o.tag);
        const cls = ["obj", vis ? "" : "hidden", sel ? "sel" : "", hot ? "hot" : ""].filter(Boolean).join(" ");
        return `<div class="${cls}" title="${o.name} · ${o.system}"><span class="oi">${TYPE_ICON[o.type] || "📦"}</span>${o.tag}</div>`;
      }).join("");
    }
    if (anim && e.box) {
      e.box.classList.remove("moved", "error");
      void e.box.offsetWidth;
      e.box.classList.add(anim === "error" ? "error" : "moved");
    }
  }
  function log() { console.log.apply(console, ["[MOCK Viewer]"].concat([].slice.call(arguments))); }

  // 초기 씬 1회 렌더 (DOM 준비 후)
  if (document.readyState !== "loading") render();
  else document.addEventListener("DOMContentLoaded", () => render());

  window.ViewerSDK = {
    jumpToTag, searchEquipment, rotateView, hide, show, isolateSystem, filterByType,
    moveToInspection, showPath, showInspectionRoute, findNearest, showWorkerPosition,
    KNOWN_TAGS, SCENE
  };
})();
