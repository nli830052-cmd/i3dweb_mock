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
  const SCENE = [
    { tag: "TG-BRG-002", type: "BEARING", name: "터빈 베어링",     system: "터빈 계통" },
    { tag: "TG-MOT-310", type: "MOTOR",   name: "구동 모터",       system: "터빈 계통" },
    { tag: "TGLOP-001",  type: "PUMP",    name: "터빈 윤활유 펌프", system: "터빈 윤활유 계통" },
    { tag: "TG-PMP-101", type: "PUMP",    name: "터빈 윤활유 펌프", system: "터빈 윤활유 계통" },
    { tag: "TG-PMP-102", type: "PUMP",    name: "터빈 윤활유 펌프", system: "터빈 윤활유 계통" },
    { tag: "TG-VLV-205", type: "VALVE",   name: "제어 밸브",       system: "터빈 윤활유 계통" },
    { tag: "TG-TNK-007", type: "TANK",    name: "윤활유 탱크",     system: "터빈 윤활유 계통" },
    { tag: "GV-101A",    type: "VALVE",   name: "글로브 밸브",     system: "냉각수 계통" },
    { tag: "GV-102A",    type: "VALVE",   name: "게이트 밸브",     system: "냉각수 계통" },
    { tag: "HX-301",     type: "HEATEX",  name: "열교환기",        system: "냉각수 계통" }
  ];

  const TYPE_KO = { PUMP: "펌프", VALVE: "밸브", MOTOR: "모터", BEARING: "베어링", HEATEX: "열교환기", TANK: "탱크" };
  const TYPE_ICON = { PUMP: "⚙️", VALVE: "🔧", MOTOR: "🔌", BEARING: "🛞", HEATEX: "♨️", TANK: "🛢️" };

  const KNOWN_TAGS = new Set(SCENE.map((o) => o.tag));

  // ── 상태 ─────────────────────────────────────────────────
  const state = {
    visible: new Set(SCENE.map((o) => o.tag)), // 보이는 태그
    selected: null,                            // 현재 선택/이동 태그
    viewDir: "front",                          // 시점 방향
    filterLabel: ""                            // 화면 상단 필터 설명
  };

  const byTag = (tag) => SCENE.find((o) => o.tag === tag);

  /* ── 이동 ────────────────────────────────────────────── */
  function jumpToTag(tag, params) {
    log("jumpToTag", tag, params);
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
    log("searchEquipment", query);
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
    log("rotateView", direction, angle);
    state.viewDir = direction || "back";
    renderTopbar();
    render();
    return { ok: true, viewDir: state.viewDir, angle: angle || 180, message: `${dirKo(state.viewDir)} 방향으로 시점 전환 (${angle || 180}°)` };
  }

  /* ── 숨김 / 표시 ─────────────────────────────────────── */
  function hide(selector) {
    log("hide", selector);
    const targets = selectObjects(selector);
    targets.forEach((o) => state.visible.delete(o.tag));
    state.filterLabel = `${describeSel(selector)} 숨김`;
    render();
    return { ok: true, hiddenCount: targets.length, message: `${describeSel(selector)} ${targets.length}개 숨김 처리` };
  }

  function show(selector) {
    log("show", selector);
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
    log("isolateSystem", system);
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
    log("filterByType", type);
    const keep = SCENE.filter((o) => o.type === type);
    if (keep.length === 0) return { ok: false, error: "NO_MATCH", message: `${TYPE_KO[type] || type} 타입 객체가 없습니다.` };
    state.visible = new Set(keep.map((o) => o.tag));
    state.filterLabel = `${TYPE_KO[type] || type}만 표시`;
    render();
    return { ok: true, type: type, shownCount: keep.length, message: `${TYPE_KO[type] || type} ${keep.length}개만 표시, 나머지 숨김` };
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
      filter: document.getElementById("viewFilter")
    };
  }
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
    KNOWN_TAGS, SCENE
  };
})();
