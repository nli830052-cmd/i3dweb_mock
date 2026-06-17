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
    // ── 5차: 작업 조건 (공간/높이/추락 — Walkinside 공간 데이터) ──
    // (정비 구역 표시 = ACTION)
    if (text.includes("정비 구역") || (text.includes("작업") && text.includes("구역") && has(text, ["표시", "보여"]))) {
      return mkAction("SHOW_WORK_ZONE", action({ type: "SHOW_WORK_ZONE", targetValue: tag }),
        "선택한 설비 주변에 정비 작업 구역을 표시합니다. 작업 반경은 설비 중심 기준 약 2m입니다.");
    }
    // (공간/간섭/발판/고소작업/추락 = 공간조건 grounded ANSWER)
    if (has(text, ["작업 공간", "공간 충분", "공간이", "간섭", "사다리", "작업 발판", "작업발판", "발판", "고소작업", "추락", "개구부", "2m 이상"])) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "GV-101A";
      return buildWorkConditionAnswer(t, text);
    }

    // ── 2차: 작업 위치 안내 ─────────────────────────────
    // (b) 오늘 점검 순서 안내 → SHOW_INSPECTION_ROUTE
    if (text.includes("점검") && has(text, ["순서", "동선", "루트"])) {
      return mkAction("SHOW_INSPECTION_ROUTE", action({ type: "SHOW_INSPECTION_ROUTE" }),
        "오늘 점검 대상을 현재 위치 기준 최적 순서로 안내합니다. 첫 번째 위치로 이동합니다.");
    }
    // (c) 가장 가까운 점검 대상 → FIND_NEAREST
    if (has(text, ["가장 가까운", "제일 가까운", "가까운"]) && (text.includes("점검") || text.includes("대상"))) {
      return mkAction("FIND_NEAREST", action({ type: "FIND_NEAREST", params: { filter: "inspection" } }),
        "현재 위치에서 가장 가까운 점검 대상으로 이동합니다.");
    }
    // (d) 점검자가 서야 하는 위치 → SHOW_WORKER_POSITION
    if (has(text, ["점검자", "작업자"]) && text.includes("위치")) {
      return mkAction("SHOW_WORKER_POSITION", action({ type: "SHOW_WORKER_POSITION", targetValue: tag }),
        "점검자가 서야 하는 위치를 표시합니다.");
    }
    // (e) 점검 위치로 이동 → MOVE_TO_INSPECTION
    if (text.includes("점검") && text.includes("위치") && has(text, ["이동", "안내", "가줘", "가자", "데려"])) {
      return mkAction("MOVE_TO_INSPECTION", action({ type: "MOVE_TO_INSPECTION", targetType: tag ? "TAG" : "SELECTED", targetValue: tag }),
        "선택한 설비의 점검 위치로 이동합니다. 작업자는 설비 전면 약 1.5m 거리에서 점검할 수 있습니다.");
    }
    // (f) 경로 / 비상 탈출 → SHOW_PATH
    if (text.includes("경로") || (text.includes("비상") && has(text, ["탈출", "출구", "대피"]))) {
      let target;
      if (text.includes("비상") || text.includes("대피")) target = "EMERGENCY_EXIT";
      else if (text.includes("조작")) target = "OPERATION_POS";
      else if (tag) target = tag;
      else target = "OPERATION_POS";
      return mkAction("SHOW_PATH", action({ type: "SHOW_PATH", target: target }),
        target === "EMERGENCY_EXIT" ? "가장 가까운 비상구까지의 경로를 표시합니다." : "선택 대상까지의 경로를 표시합니다.");
    }

    // ── 6차: 현재 작업 단계 (작업오더 워크플로 기반 grounded ANSWER) ──
    if (isStageQuery(text)) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "GV-101A";
      return buildStageAnswer(t, text);
    }

    // ── 4차: 교체/정비 주기 (CMMS·추론 기반 grounded ANSWER) ──
    // (cat3보다 앞: "교체해야?"·"주기"·"예정일"·"부품"을 이력 질의와 구분)
    if (isCycleQuery(text)) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "GV-101A";
      return buildCycleAnswer(t, text);
    }

    // ── 3차: 정비 이력/상태 (CMMS·RAG 기반 grounded ANSWER) ──
    // (태그가 있어도 정비 질의면 ANSWER 우선 → JUMP_TO보다 앞)
    if (isMaintenanceQuery(text)) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "GV-101A";
      return buildMaintenanceAnswer(t, text);
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

  /* ── 3차: 정비 이력 질의 판별 + DB 기반 답변 ───────────── */
  function isMaintenanceQuery(text) {
    const low = text.toLowerCase();
    return has(text, ["이력", "분해 정비", "분해정비", "가스켓", "누설", "고장 유형", "반복", "점검 결과", "정상이", "미조치", "오픈포인트"])
      || low.includes("open point") || low.includes("openpoint");
  }

  function buildMaintenanceAnswer(tag, text) {
    const rec = (window.MaintenanceDB && window.MaintenanceDB.query(tag)) || null;
    const low = text.toLowerCase();
    if (!rec) {
      return { responseType: "ANSWER", message: `${tag} 정비 이력을 조회합니다.`,
        answer: `${tag}에 대한 정비 이력이 CMMS에 등록되어 있지 않습니다. (mock)`,
        actions: [], confidence: 0.6, grounded: false, sources: [],
        retrieval: { source: "CMMS·정비이력 DB", query: `tag=${tag}`, hitCount: 0 } };
    }
    let answer;
    if (text.includes("가스켓")) {
      answer = rec.bonnetGasket.length
        ? `보닛 가스켓 교체 이력은 ${rec.bonnetGasket.map((g) => g.date).join(", ")} ${rec.bonnetGasket.length}회 확인됩니다. 이후 추가 교체 이력은 확인되지 않습니다.`
        : "보닛 가스켓 교체 이력은 확인되지 않습니다.";
    } else if (text.includes("누설")) {
      answer = rec.leaks.length
        ? `과거 누설 이력이 ${rec.leaks.length}건 확인됩니다. ${rec.leaks.map((l) => `${l.date} ${l.part} 부위 누설 (${l.action})`).join("; ")}.`
        : "과거 누설 이력은 확인되지 않습니다.";
    } else if (text.includes("반복") || text.includes("고장")) {
      answer = `최근 이력 기준 반복 이슈는 ${rec.recurring}입니다. 동일 부위 점검 이력이 반복 확인되면 우선 점검이 필요합니다.`;
    } else if (text.includes("분해") || text.includes("마지막")) {
      answer = `${tag}의 마지막 분해 정비일은 ${rec.lastOverhaul.date}입니다. 당시 ${rec.lastOverhaul.detail}이(가) 수행되었습니다.`;
    } else if (text.includes("점검 결과") || text.includes("정상이")) {
      answer = `최근 점검 결과는 ${rec.inspectionResult}입니다.`;
    } else if (low.includes("open point") || low.includes("openpoint") || text.includes("미조치") || text.includes("오픈포인트")) {
      answer = rec.openPoints.length
        ? `등록된 Open Point가 ${rec.openPoints.length}건 있습니다. 내용은 "${rec.openPoints.map((o) => o.desc).join(", ")}"이며, 조치 예정일은 ${rec.openPoints.map((o) => o.due).join(", ")}입니다.`
        : "등록된 미조치(Open Point) 사항은 없습니다.";
    } else {
      answer = `${rec.name}(${tag})의 최근 정비 이력은 ${rec.history.map((h) => `${h.date} ${h.type}`).join(", ")}입니다.`;
    }
    return { responseType: "ANSWER", message: `${tag} 정비 이력을 조회합니다.`, answer: answer, actions: [],
      confidence: 0.86, grounded: true,
      sources: [
        { documentName: "CMMS 정비이력", section: tag, page: null },
        { documentName: "정비 지침서", section: rec.name, page: null }
      ],
      retrieval: { source: "CMMS·정비이력 DB", query: `tag=${tag}`, hitCount: rec.history.length, data: rec } };
  }

  /* ── 4차: 교체/정비 주기 질의 판별 + 추론 답변 ─────────── */
  function isCycleQuery(text) {
    if (has(text, ["주기", "예정일", "다음 정비", "부품"])) return true;
    // "교체해야/교체 검토/교체 필요" = 판단 질의 (판단 동사로 "교체 이력"과 구분)
    if (text.includes("교체") && has(text, ["해야", "할까", "검토", "필요"])) return true;
    return false;
  }

  function addMonths(dateStr, months) {
    const d = new Date(dateStr); d.setMonth(d.getMonth() + months); return d;
  }
  function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function buildCycleAnswer(tag, text) {
    const rec = (window.MaintenanceDB && window.MaintenanceDB.query(tag)) || null;
    if (!rec) {
      return { responseType: "ANSWER", message: `${tag} 정비 주기를 조회합니다.`,
        answer: `${tag}의 정비 주기 정보가 CMMS에 등록되어 있지 않습니다. (mock)`,
        actions: [], confidence: 0.6, grounded: false, sources: [],
        retrieval: { source: "CMMS·정비주기 DB", query: `tag=${tag}`, hitCount: 0 } };
    }
    let answer;
    if (text.includes("부품")) {
      answer = `우선 점검 부품은 ${rec.priorityParts.join(", ")}입니다.` +
        (rec.leaks.length ? " 최근 누설 이력을 고려하면 그랜드패킹 부위를 먼저 확인하는 것이 좋습니다." : "");
    } else if (text.includes("교체")) {
      answer = rec.leaks.length
        ? "최근 누설 이력이 있고 그랜드패킹 부위 점검 이력이 반복되어 교체 검토가 필요합니다. 단, 최종 교체 여부는 분해 후 패킹 상태와 스터핑박스 손상 여부 확인 후 결정해야 합니다."
        : "현재 이력 기준 즉시 교체가 필요한 근거는 확인되지 않습니다. 정기 점검 시 상태 확인 후 판단하세요.";
    } else if (text.includes("예정일") || text.includes("다음 정비")) {
      answer = `다음 정비 예정일은 ${rec.nextDue}입니다.` +
        (rec.leaks.length ? " 최근 누설 이력 때문에 일반 주기보다 우선 점검 대상으로 분류되었습니다." : "");
    } else { // 주기 초과 여부
      const due = addMonths(rec.lastMaintenance, rec.cycleMonths);
      const overdue = new Date() > due;
      answer = `마지막 정비일은 ${rec.lastMaintenance}이고 기준 정비 주기는 ${rec.cycleMonths}개월입니다. ` +
        (overdue ? "현재 기준으로 정비 주기가 초과되어 점검 대상입니다." : `현재 기준 정비 주기 도래 전입니다. (다음 예정 ${fmtDate(due)})`);
    }
    return { responseType: "ANSWER", message: `${tag} 정비 주기를 조회합니다.`, answer: answer, actions: [],
      confidence: 0.85, grounded: true,
      sources: [
        { documentName: "CMMS 정비주기", section: tag, page: null },
        { documentName: "정비 지침서", section: rec.name, page: null }
      ],
      retrieval: { source: "CMMS·정비주기 DB", query: `tag=${tag}`, hitCount: rec.history.length,
        data: { cycleMonths: rec.cycleMonths, lastMaintenance: rec.lastMaintenance, nextDue: rec.nextDue, priorityParts: rec.priorityParts, leaks: rec.leaks } } };
  }

  /* ── 6차: 현재 작업 단계 질의 판별 + 작업오더 기반 답변 ── */
  function isStageQuery(text) {
    return has(text, ["단계", "체크리스트", "다음 작업", "준비사항", "점검사항", "누락", "미완료", "완료 안"]);
  }

  function buildStageAnswer(tag, text) {
    const rec = (window.WorkflowDB && window.WorkflowDB.query(tag)) || null;
    if (!rec) {
      return { responseType: "ANSWER", message: `${tag} 작업 단계를 확인합니다.`,
        answer: `${tag}에 대한 진행 중 작업오더가 없습니다. (mock)`,
        actions: [], confidence: 0.6, grounded: false, sources: [],
        retrieval: { source: "작업오더(WO) 워크플로", query: `tag=${tag}`, hitCount: 0 } };
    }
    let answer;
    if (text.includes("체크리스트")) {
      answer = `현재 단계 체크리스트는 ${rec.checklist.join(", ")}입니다.`;
    } else if (text.includes("누락")) {
      answer = rec.assemblyMissing.length
        ? `조립 전 점검사항 중 ${rec.assemblyMissing.join(", ")}이(가) 누락되었습니다. 조립 전 해당 항목을 먼저 확인해야 합니다.`
        : "조립 전 점검사항 중 누락된 항목은 없습니다.";
    } else if (text.includes("준비") && (text.includes("완료 안") || text.includes("미완료") || text.includes("안 된"))) {
      answer = rec.prepIncomplete.length
        ? `분해 전 준비사항 중 ${rec.prepIncomplete.join(", ")}이(가) 미완료 상태입니다. 완료 후 다음 단계로 진행할 수 있습니다.`
        : "분해 전 준비사항은 모두 완료되었습니다.";
    } else if (text.includes("다음")) {
      answer = `다음 작업 단계는 ${rec.nextStepDetail}`;
    } else {
      answer = `현재 작업은 ${rec.currentStage} 상태입니다. 다음 단계는 ${rec.nextStage}입니다.`;
    }
    return { responseType: "ANSWER", message: `${tag} 작업 단계를 확인합니다.`, answer: answer, actions: [],
      confidence: 0.85, grounded: true,
      sources: [
        { documentName: "작업오더(WO)", section: tag, page: null },
        { documentName: "정비 절차서", section: rec.name, page: null }
      ],
      retrieval: { source: "작업오더(WO) 워크플로", query: `tag=${tag}`, hitCount: rec.checklist.length, data: rec } };
  }

  /* ── 5차: 작업 조건 (Walkinside 공간 데이터 기반 grounded ANSWER) ── */
  function buildWorkConditionAnswer(tag, text) {
    const rec = (window.SpatialDB && window.SpatialDB.query(tag)) || null;
    if (!rec) {
      return { responseType: "ANSWER", message: `${tag} 작업 조건을 확인합니다.`,
        answer: `${tag}의 공간 데이터가 없습니다. (mock · Walkinside 연계 필요)`,
        actions: [], confidence: 0.6, grounded: false, sources: [],
        retrieval: { source: "Walkinside 공간 데이터", query: `tag=${tag}`, hitCount: 0, owner: "sol" } };
    }
    let answer;
    if (text.includes("추락") || text.includes("개구부")) {
      answer = rec.fallHazard.exists
        ? `현재 설비 기준 ${rec.fallHazard.dir} 약 ${rec.fallHazard.distM}m 지점에 ${rec.fallHazard.type}이(가) 있습니다. 작업 시 출입 제한 표시와 추락 방지 조치가 필요합니다.`
        : "현재 설비 주변에 등록된 추락 위험 구역이나 개구부는 확인되지 않습니다.";
    } else if (has(text, ["발판", "고소작업", "2m 이상", "사다리"])) {
      answer = rec.height >= 2
        ? `작업 위치 높이는 약 ${rec.height}m입니다. 2m 이상 고소작업 기준에 해당하므로 작업발판 또는 안전대 등 안전조치가 필요합니다.`
        : `작업 위치 높이는 약 ${rec.height}m입니다. 2m 미만으로 고소작업 기준에는 해당하지 않습니다.`;
    } else {
      answer = `작업 가능 공간은 전면 약 ${rec.clearance.front}m, 우측 약 ${rec.clearance.right}m입니다.` +
        (rec.clearance.right < 1 ? " 우측 공간이 좁아 공구 사용 시 간섭 가능성이 있습니다." : "");
    }
    return { responseType: "ANSWER", message: `${tag} 작업 조건을 확인합니다.`, answer: answer, actions: [],
      confidence: 0.85, grounded: true,
      sources: [{ documentName: "Walkinside 공간측정", section: tag, page: null }],
      retrieval: { source: "Walkinside 공간 데이터", query: `tag=${tag}`, hitCount: 1, owner: "sol",
        data: { clearance: rec.clearance, height: rec.height, fallHazard: rec.fallHazard } } };
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
    return { responseType: "ANSWER", message: "요청을 처리합니다.", answer: answer, actions: [], confidence: 0.8, _fallback: true };
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
    // 매뉴얼/절차 질의 → RAG 검색 + LLM(Qwen3) 종합 답변
    if (isManualQuery(request.message || "")) {
      try {
        const vt = valveTypeOf(request);
        const r = await window.RagClient.answer(request.message, vt);
        if (r && r.hitCount > 0) return buildRagAnswer(request.message, vt, r);
      } catch (e) {
        return { responseType: "ANSWER", message: "매뉴얼 RAG 서버에 연결하지 못했습니다.",
          answer: "RAG 백엔드를 실행했는지 확인하세요: python backend/rag_server.py (http://localhost:8090) · Ollama + qwen3:8b 필요",
          actions: [], confidence: 0.3, grounded: false };
      }
      // 검색 결과 없으면 아래 로컬 분류로 폴백
    }

    // 1차: 규칙기반 빠른 분류
    const ruleRes = classifyRuleBased(request);
    if (!ruleRes._fallback) return ruleRes;   // 명확히 매칭됨 → 즉시 반환

    // 2차: 규칙이 못 잡음 → LLM(Qwen3) 의도 분류 후 라우팅 (동의어/말투 대응)
    try {
      const r = await window.RagClient.route(request.message);
      if (r && r.intent && r.intent !== "GENERAL") {
        const dispatched = await dispatchByIntent(r.intent, request);
        if (dispatched) {
          dispatched.classify = { model: r.model || "qwen3:8b", intent: r.intent };
          return dispatched;
        }
      }
    } catch (e) { /* LLM/서버 미연결 → 규칙 폴백 사용 */ }
    return ruleRes;
  }

  /* ── LLM이 분류한 intent → 기존 핸들러로 라우팅 ─────────── */
  async function dispatchByIntent(intent, request) {
    const text = request.message || "";
    const ctxTag = (request.viewerContext && request.viewerContext.currentTag) || null;
    const tag = extractTag(text) || ctxTag;
    const type = detectType(text);
    const dt = tag || "GV-101A";   // 답변형 기본 대상
    switch (intent) {
      case "SEARCH": {
        const q = text.replace(/(찾아\S*|검색\S*|어디\S*|보여\S*|줘|해줘|알려\S*|있어\S*)/g, "").trim() || (type && type.ko) || text;
        return mkAction("SEARCH_EQUIPMENT", action({ type: "SEARCH_EQUIPMENT", query: q }), `"${q}" 설비를 검색합니다.`);
      }
      case "JUMP":
        return tag ? mkAction("JUMP_TO", action({ type: "JUMP_TO", targetType: "TAG", targetValue: tag }), `${tag} 위치로 이동합니다.`) : null;
      case "ROTATE": {
        const dir = has(text, ["측면", "옆"]) ? "left" : "back";
        return mkAction("ROTATE_VIEW", action({ type: "ROTATE_VIEW", params: { direction: dir, angle: dir === "back" ? 180 : 90 } }), `${dir === "back" ? "후면" : "측면"} 방향으로 시점 전환합니다.`);
      }
      case "HIDE": {
        const sel = tag ? { targetType: "TAG", targetValue: tag } : (type ? { targetType: "TYPE", targetValue: type.code } : null);
        return sel ? mkAction("HIDE_OBJECT", action(Object.assign({ type: "HIDE_OBJECT" }, sel)), "객체를 숨김 처리합니다.") : null;
      }
      case "SHOW": {
        const sel = type ? { targetType: "TYPE", targetValue: type.code } : (tag ? { targetType: "TAG", targetValue: tag } : { targetType: "ALL", targetValue: "ALL" });
        return mkAction("SHOW_OBJECT", action(Object.assign({ type: "SHOW_OBJECT" }, sel)), "객체를 다시 표시합니다.");
      }
      case "ISOLATE":
        return mkAction("ISOLATE_SYSTEM", action({ type: "ISOLATE_SYSTEM", targetValue: detectSystem(text) }), "선택한 계통만 표시합니다.");
      case "FILTER":
        return type ? mkAction("FILTER_BY_TYPE", action({ type: "FILTER_BY_TYPE", targetValue: type.code }), `${type.ko}만 표시합니다.`) : null;
      case "MOVE_INSP":
        return mkAction("MOVE_TO_INSPECTION", action({ type: "MOVE_TO_INSPECTION", targetType: tag ? "TAG" : "SELECTED", targetValue: tag }), "점검 위치로 이동합니다.");
      case "PATH": {
        const target = (text.includes("비상") || text.includes("대피")) ? "EMERGENCY_EXIT" : (text.includes("조작") ? "OPERATION_POS" : (tag || "OPERATION_POS"));
        return mkAction("SHOW_PATH", action({ type: "SHOW_PATH", target: target }), "경로를 표시합니다.");
      }
      case "ROUTE":
        return mkAction("SHOW_INSPECTION_ROUTE", action({ type: "SHOW_INSPECTION_ROUTE" }), "오늘 점검 순서를 안내합니다.");
      case "NEAREST":
        return mkAction("FIND_NEAREST", action({ type: "FIND_NEAREST", params: { filter: "inspection" } }), "가장 가까운 점검 대상으로 이동합니다.");
      case "WORKER":
        return mkAction("SHOW_WORKER_POSITION", action({ type: "SHOW_WORKER_POSITION", targetValue: tag }), "점검자 위치를 표시합니다.");
      case "ZONE":
        return mkAction("SHOW_WORK_ZONE", action({ type: "SHOW_WORK_ZONE", targetValue: tag }), "정비 작업 구역을 표시합니다.");
      case "MAINT_HISTORY": return buildMaintenanceAnswer(dt, text);
      case "MAINT_CYCLE": return buildCycleAnswer(dt, text);
      case "WORK_CONDITION": return buildWorkConditionAnswer(dt, text);
      case "WORK_STAGE": return buildStageAnswer(dt, text);
      case "MANUAL": {
        try {
          const vt = valveTypeOf(request);
          const r = await window.RagClient.answer(text, vt);
          if (r && r.hitCount > 0) return buildRagAnswer(text, vt, r);
        } catch (e) { /* fall through */ }
        return null;
      }
      default: return null;
    }
  }

  /* ── RAG: 매뉴얼/절차 질의 판별 + 밸브종류 + 답변 빌드 ──── */
  // 6개 카테고리 트리거와 겹치지 않는 "매뉴얼/표준" 신호만 사용
  function isManualQuery(text) {
    return has(text, ["절차", "방법", "어떻게", "교체 기준", "보수 기준", "점검 기준",
      "토크", "예비품", "특별점검", "매뉴얼", "지침", "조치 기준", "이상징후"]);
  }
  function valveTypeOf(request) {
    const t = request.message || "";
    if (/게이트|gate/i.test(t)) return "gate";
    if (/글로브|globe/i.test(t)) return "globe";
    const tag = request.viewerContext && request.viewerContext.currentTag;
    const map = { "GV-101A": "globe", "TG-VLV-205": "globe", "GV-102A": "gate" };
    return (tag && map[tag]) || null;   // 없으면 전체 검색
  }
  function buildRagAnswer(query, vt, r) {
    const vlabel = vt === "gate" ? "Gate 밸브 " : vt === "globe" ? "Globe 밸브 " : "";
    return {
      responseType: "ANSWER",
      message: vlabel + "매뉴얼 기반으로 답변합니다.",
      answer: r.answer,                       // Qwen3가 검색 청크로 종합한 답변
      actions: [],
      confidence: 0.9,
      grounded: !!r.grounded,
      sources: r.sources || ((r.hits || []).map((h) => ({ documentName: h.doc, section: h.sectionPath, page: h.page }))),
      retrieval: { source: "유지보수 매뉴얼 벡터검색 (bge-m3)",
        query: query, hitCount: r.hitCount, owner: "ai",
        data: (r.hits || []).map((h) => ({ score: h.score, id: h.id, valveType: h.valveType, heading: h.heading })) },
      generation: { model: r.model || "qwen3:8b", engine: "Ollama (로컬)", chunks: r.hitCount }
    };
  }

  window.AiBackend = { requestAiResponse, RESPONSE_TYPES };
})();
