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
    { tag: "TG-PMP-101",    type: "PUMP",   name: "원심 펌프",     system: "터빈 윤활유 계통",     dist: 4.8,  inspect: true,  height: 2.3 }
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
    info: "",                                  // 하단 안내(경로/거리/순서) HTML
    clip: { on: false, axis: "TB", flip: false, size: 100 }, // 단면(클리핑)
    avatar: false,                             // 아바타 표시
    keyMap: false                              // 키맵 표시
  };

  const byTag = (tag) => SCENE.find((o) => o.tag === tag);

  /* ── 이동 ────────────────────────────────────────────── */
  function jumpToTag(tag, params) {
    log("jumpToTag", tag, params); state.info = "";
    const cleanTag = (tag || "").trim();
    if (cleanTag && !cleanTag.includes("XXX") && !KNOWN_TAGS.has(tag) && !KNOWN_TAGS.has(cleanTag)) {
      KNOWN_TAGS.add(tag);
      KNOWN_TAGS.add(cleanTag);
      state.visible.add(cleanTag);
      state.visible.add(tag);
    }
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

  /* ══ 솔루션팀 액션 인터페이스 (docs/AI 채팅 구현.xlsx) ══════
     실제 i3DWEB SDK 수령 전까지의 mock 구현. 시그니처는 스펙 기준. */

  /* ── 뷰 프리셋: top/front/side/iso ────────────────────── */
  function presetView(kind, tag) {
    log("presetView", kind, tag); state.info = "";
    const t = (tag || state.selected || "").trim();
    if (t) {
      if (!KNOWN_TAGS.has(t)) return { ok: false, error: "TAG_NOT_FOUND", message: `${t} 태그를 Viewer에서 찾을 수 없습니다.` };
      state.selected = t; state.visible.add(t);
    }
    state.viewDir = kind;
    renderTag(state.selected || "—", `${kind.toUpperCase()}_VIEW · 시점 전환`, false);
    render("moved");
    return { ok: true, view: kind, tag: state.selected, message: `${state.selected || "현재 모델"} ${dirKo(kind)} 시점으로 전환` };
  }

  /* ── 단면(클리핑) ─────────────────────────────────────── */
  const AXIS_KO = { TB: "상하", LR: "좌우", FB: "전후" };
  function clip(tag, on) {
    log("clip", tag, on); state.info = "";
    const t = (tag || state.selected || "").trim();
    if (t && KNOWN_TAGS.has(t)) { state.selected = t; state.visible.add(t); }
    state.clip.on = on !== false;
    if (state.clip.on) renderInfo(`✂️ 단면(클리핑) ON · <b>${state.selected || "—"}</b> · 축 ${AXIS_KO[state.clip.axis]}(${state.clip.axis}) · 사이즈 ${state.clip.size}`);
    renderTag(state.selected || "—", "CLIP · " + (state.clip.on ? "ON" : "OFF"), false);
    render("moved");
    return { ok: true, clip: state.clip.on, tag: state.selected, message: `단면 보기 ${state.clip.on ? "켜짐" : "꺼짐"}${state.selected ? " (" + state.selected + ")" : ""}` };
  }
  function clipAxis(axis) {
    log("clipAxis", axis);
    const a = (axis || "").toUpperCase();
    if (!AXIS_KO[a]) return { ok: false, error: "BAD_AXIS", message: `지원하지 않는 축입니다: ${axis} (TB/LR/FB)` };
    state.clip.axis = a; state.clip.on = true;
    renderInfo(`✂️ 단면 축 변경 · <b>${AXIS_KO[a]}(${a})</b>`);
    render();
    return { ok: true, axis: a, message: `단면 축을 ${AXIS_KO[a]}(${a})로 변경` };
  }
  function clipFlip() {
    log("clipFlip");
    if (!state.clip.on) return { ok: false, error: "CLIP_OFF", message: "단면 보기가 꺼져 있어 반전할 수 없습니다." };
    state.clip.flip = !state.clip.flip;
    renderInfo(`✂️ 단면 축 반전 · ${state.clip.flip ? "반전됨" : "원위치"} (축 ${state.clip.axis})`);
    render();
    return { ok: true, flip: state.clip.flip, message: `단면 축 반전 (${state.clip.flip ? "반전" : "원위치"})` };
  }
  function clipSize(n) {
    log("clipSize", n);
    const v = Number(n);
    if (!isFinite(v)) return { ok: false, error: "BAD_NUMBER", message: `단면 사이즈가 숫자가 아닙니다: ${n}` };
    state.clip.size = v; state.clip.on = true;
    renderInfo(`✂️ 단면 사이즈 조정 · <b>${v}</b> (축 ${state.clip.axis})`);
    render();
    return { ok: true, size: v, message: `단면 사이즈를 ${v}(으)로 조정` };
  }

  /* ── 그것만 표시 / 전체 숨김 / 선택 해제 ──────────────── */
  function showOnly(selector) {
    log("showOnly", selector); state.info = "";
    const targets = selectObjects(selector);
    if (targets.length === 0) return { ok: false, error: "NO_MATCH", message: `${describeSel(selector)}에 해당하는 모델이 없습니다.` };
    state.visible = new Set(targets.map((o) => o.tag));
    state.filterLabel = `${describeSel(selector)}만 표시`;
    render();
    return { ok: true, shownCount: targets.length, hiddenCount: SCENE.length - targets.length, message: `${describeSel(selector)}만 표시 (${targets.length}개), 나머지 숨김` };
  }
  function hideAll() {
    log("hideAll"); state.info = "";
    state.visible = new Set();
    state.filterLabel = "전체 숨김";
    render();
    return { ok: true, hiddenCount: SCENE.length, message: `전체 모델 ${SCENE.length}개 숨김` };
  }
  function unselectAll() {
    log("unselectAll");
    state.selected = null;
    renderTag("—", "UNSELECT_ALL · 선택 해제", false);
    render();
    return { ok: true, message: "모델 선택 해제" };
  }

  /* ── 홈 / 아바타 / 키맵 ───────────────────────────────── */
  function home() {
    log("home"); state.info = "";
    state.viewDir = "front"; state.clip.on = false;
    renderTag(state.selected || "—", "HOME · 홈 뷰", false);
    render("moved");
    return { ok: true, message: "홈 위치로 카메라 이동" };
  }
  function avatar(on) {
    log("avatar", on);
    state.avatar = on !== false;
    renderInfo(state.avatar ? "🧍 아바타 표시 ON" : "");
    render();
    return { ok: true, avatar: state.avatar, message: `아바타 ${state.avatar ? "켜짐" : "꺼짐"}` };
  }
  function keyMap(on) {
    log("keyMap", on);
    state.keyMap = on !== false;
    renderInfo(state.keyMap ? "🗺️ 키맵 표시 ON · 현재 위치 반영" : "");
    render();
    return { ok: true, keyMap: state.keyMap, message: `키맵 ${state.keyMap ? "켜짐" : "꺼짐"}` };
  }

  /* ── 모니터링 (연계 화면 mock) ─────────────────────────── */
  function monitoring(tag, on) {
    log("monitoring", tag, on);
    if (on === false) { state.info = ""; render(); return { ok: true, monitoring: false, message: "모니터링 화면 닫힘" }; }
    const t = (tag || state.selected || "TG-PMP-101").trim();
    state.selected = t;
    if (KNOWN_TAGS.has(t)) state.visible.add(t);
    renderTag(t, "MONITORING · 실시간", false);
    const info = t === "TURBINE-001"
      ? `📊 <b>터빈 실시간 모니터링</b> · Health <b style="color:#d98a0b">69.9%</b> · 입구온도 26℃ · 압축기효율 0.3 · 터빈효율 0.6 · 압력비 0.8 · 출구압력 88 kPa`
      : `📊 <b>${t}</b> 실시간 모니터링 (mock) · 유량 12.4㎥/h · 압력 8.2bar · 온도 46.3℃`;
    renderInfo(info);
    render("moved");
    return { ok: true, monitoring: true, tag: t, message: `${t} 모니터링 화면 표시` };
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

  /* ── [작업 조건] 정비 작업 구역 표시 ──────────────────── */
  function showWorkZone(tag) {
    log("showWorkZone", tag); state.info = "";
    const t = tag || state.selected || "TG-PMP-101";
    const o = byTag(t);
    if (!o) return { ok: false, error: "TAG_NOT_FOUND", message: `${t} 설비를 찾을 수 없습니다.` };
    state.selected = t; state.visible.add(t);
    renderTag(t, "SHOW_WORK_ZONE · 작업 구역", false);
    renderInfo(`🚧 정비 작업 구역 표시 · <b>${t}</b> · 작업 반경 설비 중심 기준 약 <b>2m</b>`);
    render("moved");
    return { ok: true, tag: t, radiusM: 2, message: `${t} 정비 작업 구역 표시 (반경 2m)` };
  }

  /* ── [도면] 연관 P&ID 도면 표시 ─────────────────────────
     실제 i3DWEB은 설비↔도면 링크로 P&ID를 띄움. 여기선 뷰어 위에
     인라인 SVG P&ID(태그 강조)를 오버레이로 mock 표시한다. */
  function showPID(tag) {
    log("showPID", tag);
    const t = (tag || state.selected || "TG-PMP-101").trim();
    const o = byTag(t);
    state.selected = t;
    if (KNOWN_TAGS.has(t)) state.visible.add(t);
    const system = (o && o.system) || "냉각수 계통";
    render("moved");                 // 씬 갱신(이때 기존 오버레이는 닫힘)
    renderPID(t, system);            // P&ID 오버레이 열기
    renderTag(t, "SHOW_PID · P&ID 도면", false);
    return { ok: true, tag: t, drawing: "P&ID", system: system, message: `${t} 연관 P&ID 도면 표시 (${system})` };
  }

  function pidOverlayEl() {
    let ov = document.getElementById("pidOverlay");
    if (!ov) {
      const vp = document.querySelector(".i3d-viewport") || document.getElementById("viewer");
      if (!vp) return null;
      ov = document.createElement("div");
      ov.id = "pidOverlay";
      ov.className = "pid-overlay";
      vp.appendChild(ov);
    }
    return ov;
  }

  function hidePID() {
    const ov = document.getElementById("pidOverlay");
    if (ov) { ov.classList.remove("on"); ov.innerHTML = ""; }
  }

  function renderPID(tag, system) {
    const ov = pidOverlayEl();
    if (!ov) return;
    ov.innerHTML =
      `<div class="pid-frame">` +
        `<div class="pid-bar">` +
          `<span class="pid-title">📐 P&amp;ID 도면 · <b>${tag}</b> <span class="pid-sys">${system}</span></span>` +
          `<button class="pid-close" id="pidClose" title="닫기 (도면 닫기)">×</button>` +
        `</div>` +
        `<div class="pid-canvas">${pidSvg(tag)}</div>` +
        `<div class="pid-foot">연관 도면(mock) · 실제 연동 시 i3DWEB 도면 뷰어로 대체</div>` +
      `</div>`;
    ov.classList.add("on");
    const c = document.getElementById("pidClose");
    if (c) c.addEventListener("click", hidePID);
  }

  // 태그를 강조한 간단한 P&ID 스키매틱(탱크→펌프→[밸브]→열교환기 + 계장 버블)
  function pidSvg(tag) {
    return `<svg viewBox="0 0 560 230" class="pid-svg" xmlns="http://www.w3.org/2000/svg">
      <line x1="72" y1="150" x2="430" y2="150" stroke="#0e4b92" stroke-width="3"/>
      <rect x="24" y="112" width="48" height="76" rx="6" fill="#fff" stroke="#0e4b92" stroke-width="2.5"/>
      <line x1="24" y1="128" x2="72" y2="128" stroke="#0e4b92" stroke-width="1.4"/>
      <text x="48" y="206" text-anchor="middle" class="pid-lbl">TK-01</text>
      <circle cx="150" cy="150" r="20" fill="#fff" stroke="#0e4b92" stroke-width="2.5"/>
      <path d="M140 140 L140 160 L162 150 Z" fill="#0e4b92"/>
      <text x="150" y="206" text-anchor="middle" class="pid-lbl">P-01</text>
      <line x1="290" y1="122" x2="290" y2="98" stroke="#6b7986" stroke-width="1.2" stroke-dasharray="3 3"/>
      <circle cx="290" cy="82" r="16" fill="#fff" stroke="#6b7986" stroke-width="1.5"/>
      <line x1="274" y1="82" x2="306" y2="82" stroke="#6b7986" stroke-width="1"/>
      <text x="290" y="79" text-anchor="middle" class="pid-inst">PI</text>
      <text x="290" y="92" text-anchor="middle" class="pid-inst">101</text>
      <rect x="260" y="120" width="60" height="60" rx="6" fill="none" stroke="#2eacee" stroke-width="1.5" stroke-dasharray="4 3" class="pid-hot"/>
      <path d="M270 134 L270 166 L290 150 Z" fill="#2eacee"/>
      <path d="M310 134 L310 166 L290 150 Z" fill="#2eacee"/>
      <line x1="290" y1="138" x2="290" y2="150" stroke="#2eacee" stroke-width="2.5"/>
      <circle cx="290" cy="134" r="6" fill="#fff" stroke="#2eacee" stroke-width="2.5"/>
      <text x="290" y="196" text-anchor="middle" class="pid-tag">${tag}</text>
      <rect x="430" y="120" width="76" height="60" rx="4" fill="#fff" stroke="#0e4b92" stroke-width="2.5"/>
      <line x1="430" y1="140" x2="506" y2="140" stroke="#0e4b92" stroke-width="1.2"/>
      <line x1="430" y1="160" x2="506" y2="160" stroke="#0e4b92" stroke-width="1.2"/>
      <text x="468" y="206" text-anchor="middle" class="pid-lbl">HX-301</text>
    </svg>`;
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
  function dirKo(d) { return { front: "전면", back: "후면", left: "좌측", right: "우측", top: "탑뷰(윗면)", side: "측면", iso: "ISO 뷰" }[d] || d; }

  /* ── 화면 표현 (#viewer) ─────────────────────────────── */
  function els() {
    return {
      box: document.getElementById("viewer"),
      tag: document.getElementById("viewerTag"),
      status: document.getElementById("viewerStatus"),
      scene: document.getElementById("scene"),
      dir: document.getElementById("viewDir"),
      filter: document.getElementById("viewFilter"),
      info: document.getElementById("viewerInfo"),
      tree: document.getElementById("i3dTree")
    };
  }

  /* ── 좌측 탐색 트리 빌드 (계통별 그룹) ─────────────────── */
  function buildTree() {
    const e = els();
    if (!e.tree) return;
    const systems = [];
    SCENE.forEach((o) => {
      let g = systems.find((s) => s.name === o.system);
      if (!g) { g = { name: o.system, items: [] }; systems.push(g); }
      g.items.push(o);
    });
    e.tree.innerHTML = systems.map((s) =>
      `<div class="tree-sys">` +
        s.items.map((o) =>
          `<div class="tree-row tree-leaf" data-tag="${o.tag}" title="${o.name}">` +
            `${o.tag}</div>`
        ).join("") +
      `</div>`
    ).join("");
    e.tree.querySelectorAll(".tree-leaf").forEach((leaf) => {
      leaf.addEventListener("click", () => jumpToTag(leaf.dataset.tag));
    });
  }

  /* ── 속성 정보 패널 갱신 ──────────────────────────────── */
  function renderProp() {
    const o = state.selected && byTag(state.selected);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (!o) {
      ["propTag","propName","propType","propSystem","propVis","propDist"].forEach((id) => set(id, "—"));
      return;
    }
    set("propTag", o.tag);
    set("propName", o.name);
    set("propType", (TYPE_KO[o.type] || o.type) + " (" + o.type + ")");
    set("propSystem", o.system);
    set("propVis", state.visible.has(o.tag) ? "표시" : "숨김");
    set("propDist", o.dist + " m");
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
    hidePID();                 // 다른 뷰어 액션이 실행되면 열려있던 P&ID 오버레이는 닫는다
    renderTopbar();
    if (e.info) e.info.innerHTML = state.info;
    if (e.scene) {
      e.scene.innerHTML = SCENE.map((o) => {
        const vis = state.visible.has(o.tag);
        const sel = o.tag === state.selected;
        const hot = highlightSet && highlightSet.has(o.tag);
        const cls = ["obj", vis ? "" : "hidden", sel ? "sel" : "", hot ? "hot" : ""].filter(Boolean).join(" ");
        return `<div class="${cls}" data-tag="${o.tag}" title="${o.name} · ${o.system} · 클릭 시 태그를 채팅 입력칸에 채움">${o.tag}</div>`;
      }).join("");
      // 설비 클릭 → 해당 태그를 채팅 입력칸에 채움 (전송은 사용자가)
      e.scene.querySelectorAll(".obj").forEach((box) => {
        box.addEventListener("click", () => fillChatInput(box.dataset.tag));
      });
    }
    if (e.tree) {
      e.tree.querySelectorAll(".tree-leaf").forEach((leaf) => {
        const t = leaf.dataset.tag;
        leaf.classList.toggle("sel", t === state.selected);
        leaf.classList.toggle("hidden", !state.visible.has(t));
      });
    }
    renderProp();
    if (anim && e.box) {
      e.box.classList.remove("moved", "error");
      void e.box.offsetWidth;
      e.box.classList.add(anim === "error" ? "error" : "moved");
    }
  }
  function log() { console.log.apply(console, ["[MOCK Viewer]"].concat([].slice.call(arguments))); }

  /* ── 설비 클릭 → 채팅 입력칸에 태그 채우기 ────────────── */
  function fillChatInput(tag) {
    if (!tag) return;
    const input = document.getElementById("userInput");
    if (!input) return;
    input.value = tag;
    input.focus();
    // 커서를 끝으로
    const len = input.value.length;
    try { input.setSelectionRange(len, len); } catch (_) {}
    log("fillChatInput", tag);
  }

  // Tag 검색 패널 바인딩 (좌측 i3DWEB 사이드)
  function bindTagSearch() {
    const input = document.getElementById("tagSearch");
    const btn = document.getElementById("tagSearchBtn");
    if (!input || !btn) return;
    const run = () => {
      const v = (input.value || "").trim().toUpperCase();
      if (!v) return;
      if (KNOWN_TAGS.has(v)) jumpToTag(v);
      else searchEquipment(input.value.trim());
    };
    btn.addEventListener("click", run);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") run(); });
  }

  // 초기 트리 빌드 + 씬 1회 렌더 (DOM 준비 후)
  function init() { buildTree(); bindTagSearch(); render(); }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);

  window.ViewerSDK = {
    jumpToTag, searchEquipment, rotateView, hide, show, isolateSystem, filterByType,
    moveToInspection, showPath, showInspectionRoute, findNearest, showWorkerPosition,
    showWorkZone, showPID, hidePID,
    // 솔루션팀 액션 인터페이스 (docs/AI 채팅 구현.xlsx)
    presetView, clip, clipAxis, clipFlip, clipSize,
    showOnly, hideAll, unselectAll, home, avatar, keyMap, monitoring,
    KNOWN_TAGS, SCENE
  };
})();
