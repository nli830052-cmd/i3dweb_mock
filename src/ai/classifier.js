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
  // TAG_RE: 최대 4-segment 태그 매칭 (예: GV-101A-3DF-D11)
  const TAG_RE = /\b[A-Z]{1,5}(?:-[A-Z0-9]{1,5}){1,4}\b/i;
  // DB에 등록된 base tag 목록 (가장 짧은 것부터 순서 보장용)
  const BASE_TAGS = ["TG-PMP-101", "GV-102A", "TG-VLV-205", "TG-BRG-002", "TG-LOP-001", "HX-301", "TK-401", "MT-501"];
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
    if (!m) return null;
    return normalizeTag(m[0]);
  }
  /**
   * 입력 태그에서 DB base tag를 추출.
   * 예) "GV-101A-3DF" → "GV-101A", "GV-101A-3DF-D11" → "GV-101A"
   * DB에 등록된 태그와 prefix 비교 후 가장 긴 매칭 반환. 없으면 원본 반환.
   */
  function normalizeTag(raw) {
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    // MaintenanceDB RECORDS 키 우선 조회 (런타임에 동적으로 확장될 수 있음)
    const dbKeys = (window.MaintenanceDB && window.MaintenanceDB.RECORDS)
      ? Object.keys(window.MaintenanceDB.RECORDS)
      : BASE_TAGS;
    // 가장 긴 prefix 매칭 우선
    let best = null;
    dbKeys.forEach(function(k) {
      const ku = k.toUpperCase();
      if (upper === ku || upper.startsWith(ku + "-")) {
        if (!best || k.length > best.length) best = k;
      }
    });
    return best || raw;
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
    // 5.5) P&ID 도면 표시 — 해당 설비의 연관 도면 ("도면 보여줘"의 "보여"가 JUMP로 가기 전에 가로챔)
    if (/도면|피앤아이디|계장도|공정도/.test(text) || /p\s*&\s*id|\bpid\b/i.test(text)) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || null;
      return mkAction("SHOW_PID", action({ type: "SHOW_PID", targetType: t ? "TAG" : "SELECTED", targetValue: t }),
        `${t || "선택한 설비"}의 연관 P&ID 도면을 표시합니다.`);
    }
    // 6) 검색 (태그 없이 이름/타입으로 찾기) — "어디"는 모호해 규칙에서 제외(LLM plan에 위임)
    if (has(text, ["찾아", "검색"]) && !tag) {
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
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "TG-PMP-101";
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
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "TG-PMP-101";
      return buildStageAnswer(t, text);
    }

    // ── 4차: 교체/정비 주기 (CMMS·추론 기반 grounded ANSWER) ──
    // (cat3보다 앞: "교체해야?"·"주기"·"예정일"·"부품"을 이력 질의와 구분)
    if (isCycleQuery(text)) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "TG-PMP-101";
      return buildCycleAnswer(t, text);
    }

    // ── 3차: 정비 이력/상태 (CMMS·RAG 기반 grounded ANSWER) ──
    // (태그가 있어도 정비 질의면 ANSWER 우선 → JUMP_TO보다 앞)
    if (isMaintenanceQuery(text)) {
      const t = tag || (request.viewerContext && request.viewerContext.currentTag) || "TG-PMP-101";
      return buildMaintenanceAnswer(t, text);
    }

    // 7) 이동 (태그 기반 또는 자유 입력 태그)
    if (has(text, ["이동", "움직", "가줘", "가자", "안내", "위치", "보여", "데려"])) {
      let targetTag = tag;
      if (!targetTag) {
        const raw = text.replace(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g, "");
        if (raw && raw.trim()) {
          targetTag = raw;
        }
      }
      if (targetTag && targetTag.trim()) {
        const cleanTag = targetTag.trim();
        return mkAction("JUMP_TO", action({ type: "JUMP_TO", targetType: "TAG", targetValue: cleanTag }),
          `${cleanTag} 위치를 찾았습니다. 현재 화면을 해당 설비 위치로 이동하고 강조 표시합니다.`);
      }
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
      // DB에 nextDue가 있으면 그 값을 우선 사용, 없으면 동적 계산
      const dueDateStr = rec.nextDue || fmtDate(addMonths(rec.lastMaintenance, rec.cycleMonths));
      const overdue = new Date() > new Date(dueDateStr);
      answer = `마지막 정비일은 ${rec.lastMaintenance}이고 기준 정비 주기는 ${rec.cycleMonths}개월입니다. ` +
        (overdue ? "현재 기준으로 정비 주기가 초과되어 점검 대상입니다." : `현재 기준 정비 주기 도래 전입니다. (다음 예정 ${dueDateStr})`);
    }
    // nextDue: DB 값 우선, 없으면 동적 계산
    const nextDueResolved = rec.nextDue || fmtDate(addMonths(rec.lastMaintenance, rec.cycleMonths));
    return { responseType: "ANSWER", message: `${tag} 정비 주기를 조회합니다.`, answer: answer, actions: [],
      confidence: 0.85, grounded: true,
      sources: [
        { documentName: "CMMS 정비주기", section: tag, page: null },
        { documentName: "정비 지침서", section: rec.name, page: null }
      ],
      retrieval: { source: "CMMS·정비주기 DB", query: `tag=${tag}`, hitCount: rec.history.length,
        data: { cycleMonths: rec.cycleMonths, lastMaintenance: rec.lastMaintenance, nextDue: nextDueResolved,
                priorityParts: rec.priorityParts, leaks: rec.leaks, overdue: new Date() > new Date(nextDueResolved) } } };
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
  // 근거형 질의(이력/주기/공간/단계/매뉴얼)인가 — 통합 챗(LLM+RAG+DB) 대상 판별
  function isWorkConditionQuery(text) {
    return has(text, ["작업 공간", "공간 충분", "공간이", "간섭", "사다리", "작업 발판", "작업발판", "발판", "고소작업", "추락", "개구부", "2m 이상"]);
  }
  function isGroundedQuery(text) {
    return isManualQuery(text) || isWorkConditionQuery(text) || isStageQuery(text) || isCycleQuery(text) || isMaintenanceQuery(text);
  }
  // 서버 통합 챗 응답 → 프런트 표준 응답 객체로 보정
  function adaptChat(r) {
    return Object.assign({ message: "", actions: [], confidence: 0.9 }, r);
  }

  // ── LLM-first 모드: 백엔드가 OpenAI API로 동작 중인지 기동 시 1회 확인 ──
  //    켜지면 규칙 필터를 건너뛰고 모든 입력을 LLM(plan)이 먼저 해석한다.
  let LLM_FIRST = false;
  (async function detectLlmMode() {
    try {
      const cfg = await window.RagClient.llmConfig();
      LLM_FIRST = !!(cfg && cfg.llmFirst);
      if (LLM_FIRST) console.log("[AI] LLM-first 모드 활성: " + cfg.model + " (" + cfg.engine + ")");
    } catch (e) { /* 백엔드 미가동 → 규칙 기반 유지 */ }
  })();

  const QUERY_CAT = { QUERY_MAINTENANCE: "maintenance", QUERY_CYCLE: "cycle",
    QUERY_SPATIAL: "spatial", QUERY_WORKFLOW: "workflow" };

  // 진행 단계 알림 → UI(app.js)가 "AI가 생각하는 과정"으로 표시
  function notifyProgress(stage) {
    try { if (typeof window.AiProgress === "function") window.AiProgress(stage); } catch (e) { /* UI 미구현 시 무시 */ }
  }

  /* LLM-first: plan(LLM)이 의도·액션 판단 → 질문이면 통합 챗(RAG+DB) 리치 답변 */
  async function llmFirstResponse(request) {
    const ctx = (request.viewerContext && request.viewerContext.currentTag) || null;
    notifyProgress("intent");
    const plan = await window.RagClient.plan(request.message, ctx, request.sessionId);
    if (!plan || !plan.valid) return null;
    const acts = (plan.actions || []).map((a) => Object.assign({ params: {} }, a));
    const viewerActs = acts.filter((a) => VIEWER_TYPES.indexOf(a.type) >= 0);
    const queryAct = acts.find((a) => QUERY_CAT[a.type]);
    const ragAct = acts.find((a) => a.type === "MANUAL_RAG");
    const planMeta = { model: plan.model, engine: plan.engine, actions: plan.actions };

    // 오늘 점검 브리핑 — UI(app.js)가 멀티스텝 시퀀스로 실행
    if (acts.some((a) => a.type === "BRIEFING")) {
      return { responseType: "BRIEFING", message: plan.message || "오늘 점검 브리핑을 시작합니다.",
        answer: null, actions: [], confidence: 0.9, plan: planMeta };
    }

    // 질문 성격 → 통합 챗의 5단 구조 답변. plan의 분류를 힌트로 넘겨 재분류를 생략.
    if (queryAct || ragAct) {
      const hint = queryAct
        ? { category: QUERY_CAT[queryAct.type], sub: queryAct.field || "" }
        : { category: "manual", sub: "rag", query: ragAct.query,
            valveType: (ragAct.valveType && ragAct.valveType !== "null") ? ragAct.valveType : valveTypeOf(request) };
      const tag = (queryAct && queryAct.targetValue) || ctx;
      notifyProgress("retrieve");
      const r = await window.RagClient.chat(request.message, tag, request.sessionId, hint);
      notifyProgress("generate");
      if (!r) return null;
      const out = adaptChat(r);
      if (viewerActs.length) { out.responseType = "ANSWER_WITH_ACTION"; out.actions = viewerActs; }
      out.plan = planMeta;
      return out;
    }
    if (viewerActs.length) {
      return { responseType: "ACTION", message: plan.message || "실행합니다.", answer: null,
        actions: viewerActs, confidence: 0.9, plan: planMeta };
    }
    // 잡담/일반 대화 — plan.message로 응답
    return { responseType: "ANSWER", message: plan.message || "",
      answer: plan.message || "무엇을 도와드릴까요?", actions: [], confidence: 0.7, plan: planMeta };
  }

  async function requestAiResponse(request, opts) {
    opts = opts || {};
    if (opts.simulateError) {
      throw { status: 500, body: { error: "INTERNAL_ERROR", message: "AI 응답 생성 중 오류가 발생했습니다.", requestId: (request.sessionId || "sess") + "-" + Date.now() } };
    }

    // ★ 오늘 점검 브리핑 고정 진입 — LLM/백엔드 분류 결과와 무관하게 동작
    if (isTodayBriefingQuery(request.message || "")) {
      return { responseType: "BRIEFING", message: "오늘 점검 브리핑을 시작합니다.",
        answer: null, actions: [], confidence: 0.99 };
    }

    // ★ 터빈 실시간 모니터링 고정 mock — 텍스트 질의도 사진 첨부와 같은 답변 제공
    if (isTurbineMonitoringQuery(request.message || "")) {
      notifyProgress("retrieve");
      await new Promise((r) => setTimeout(r, 450));
      return buildTurbineMonitoringAnswer();
    }

    // ★ 상세질문은 LLM이 의도를 분류하고, 검증된 고정 내용 + 전용 UI로 답변한다.
    // 서버/LLM 장애 시에만 아래 키워드 규칙이 안전장치로 동작한다.
    let demoIntent = null;
    try {
      const intentResult = await window.RagClient.demoIntent(request.message || "", request.sessionId);
      const intentMap = {
        PUMP_CLEANING_FME: "cleaning",
        PUMP_FME_EXPLANATION: "fme",
        PUMP_LIFTING_TEST: "lifting",
        PUMP_REASSEMBLY_PARTS: "consumables"
      };
      demoIntent = intentMap[intentResult && intentResult.intent] || null;
    } catch (e) { /* 의도 분류 서버 미연결 → 키워드 폴백 */ }

    const pumpRag = buildPumpRagDemoAnswer(request.message || "", demoIntent);
    if (pumpRag) {
      notifyProgress("retrieve");
      await new Promise((r) => setTimeout(r, 450));
      try {
        await window.RagClient.recordContext(request.sessionId, request.message || "", pumpRag.contextSummary || pumpRag.message || "");
      } catch (e) { /* 서버 미연결이어도 고정 답변은 정상 표시 */ }
      return pumpRag;
    }

    // ★ 정비점검절차 리치 카드 — 절차서 고정 응답 (LLM/백엔드보다 우선, 오프라인 동작)
    if (isProcedureCardQuery(request.message || "")) {
      notifyProgress("retrieve");
      await new Promise((r) => setTimeout(r, 650));   // 검색 단계가 눈에 보이도록
      return buildProcedureCardAnswer(request.message || "");
    }

    // ★ LLM-first (OpenAI API 연결 시): 규칙 필터 없이 LLM이 전부 해석.
    //    실패(서버/API 오류) 시에만 아래 기존 규칙+폴백 경로로.
    if (LLM_FIRST) {
      try {
        const out = await llmFirstResponse(request);
        if (out) return out;
      } catch (e) { /* OpenAI/서버 오류 → 기존 경로 폴백 */ }
    }

    // ★ 통합 챗 우선: 근거형 데이터/매뉴얼 질의는 백엔드(LLM+RAG+DB)로 — 5단 구조 답변
    if (isGroundedQuery(request.message || "")) {
      try {
        const ctx = request.viewerContext && request.viewerContext.currentTag;
        const r = await window.RagClient.chat(request.message, ctx, request.sessionId);
        if (r && (r.grounded || r.category === "manual")) return adaptChat(r);
      } catch (e) { /* 백엔드/Ollama 미가동 → 아래 클라이언트 폴백 */ }
    }

    // 매뉴얼/절차 질의 → RAG 검색 + LLM(Qwen3) 종합 답변
    if (isManualQuery(request.message || "")) {
      try {
        const vt = valveTypeOf(request);
        const r = await window.RagClient.answer(request.message, vt);
        if (r && r.hitCount > 0) return buildRagAnswer(request.message, vt, r);
      } catch (e) {
        return { responseType: "ANSWER", message: "매뉴얼 RAG 서버에 연결하지 못했습니다.",
          answer: "RAG 백엔드를 실행했는지 확인하세요: python backend/rag_server.py (http://localhost:8090) · Ollama + qwen3.5:9b 필요",
          actions: [], confidence: 0.3, grounded: false };
      }
      // 검색 결과 없으면 아래 로컬 분류로 폴백
    }

    // 1차: 규칙기반 빠른 분류
    const ruleRes = classifyRuleBased(request);
    if (!ruleRes._fallback) return ruleRes;   // 명확히 매칭됨 → 즉시 반환

    // 2차: 규칙이 못 잡음 → LLM(Qwen3)이 action JSON 직접 생성 → 실행 (도구+파라미터까지 LLM이)
    try {
      const ctx = request.viewerContext && request.viewerContext.currentTag;
      const plan = await window.RagClient.plan(request.message, ctx);
      if (plan && plan.valid) {
        const out = await executePlan(plan, request);
        if (out) return out;
      }
    } catch (e) { /* LLM/서버 미연결·plan 무효 → 규칙 폴백 */ }
    return ruleRes;
  }

  function isTodayBriefingQuery(text) {
    const q = String(text || "").replace(/\s+/g, "");
    return q.includes("오늘") && q.includes("점검") &&
      (q.includes("대상") || q.includes("할거") || q.includes("할것") || q.includes("브리핑")) &&
      (q.includes("알려") || q.includes("시작") || q.includes("해줘"));
  }

  function isTurbineMonitoringQuery(text) {
    const q = String(text || "").replace(/\s+/g, "");
    return q.includes("터빈") && q.includes("모니터링") && (q.includes("정보") || q.includes("알려") || q.includes("조회"));
  }

  function buildTurbineMonitoringAnswer() {
    const turbineTag = "5-4H31-J043C3";
    return {
      responseType: "ANSWER_WITH_ACTION",
      uiKind: "turbine-monitoring",
      message: "터빈 태그 5-4H31-J043C3의 실시간 정비 모니터링 화면으로 연결됩니다. 상세한 설명을 드리면 다음과 같습니다.",
      blocks: [{ kind: "turbineMonitoring", metrics: [
        { label: "장비 태그", value: turbineTag, status: "확인", level: 100, tone: "info", description: "실시간 모니터링 데이터가 연결된 터빈 장비 태그입니다." },
        { label: "Health", value: "69.9%", status: "경고", level: 69.9, tone: "warn", description: "터빈의 종합 건강도가 정상 범위보다 낮아 효율 저하나 주요 구성품의 성능 저하가 진행되고 있을 가능성이 있습니다." },
        { label: "터빈 입구 온도", value: "26C", status: "하한 근접", level: 26, tone: "warn", description: "입구 온도가 낮은 상태로 유지되면 연소 안정성과 터빈 효율에 영향을 줄 수 있습니다. 흡입 공기 조건, 연료 공급 상태, 제어 밸브 동작 상태를 우선 확인해야 합니다." },
        { label: "압축기·터빈 효율", value: "0.3 / 0.6", status: "낮음", level: 45, tone: "danger", description: "정상적인 에너지 변환 효율을 충분히 확보하지 못하고 있습니다. 압축기 블레이드 오염, 흡기 필터 막힘, 내부 유로 손실, 터빈 블레이드 마모 여부를 점검해야 합니다." },
        { label: "압축기 압력비", value: "0.8", status: "부족", level: 40, tone: "danger", description: "충분한 압력 상승이 형성되지 않고 있습니다. 흡기 계통 막힘, 압축기 성능 저하, 누설, 블레이드 오염 또는 손상 가능성을 확인해야 합니다." },
        { label: "터빈 출구 압력", value: "88 kPa", status: "추이 관찰", level: 88, tone: "info", description: "현재 값만으로 즉각적인 이상을 단정하기는 어렵습니다. 변동이 반복되거나 기준 하한으로 내려가면 배기 계통과 후단 설비의 저항 상태를 점검해야 합니다." }
      ] }],
      answer: `### 권장 점검 우선순위

1. 흡기 필터와 흡기 덕트의 막힘 및 오염 상태 점검
2. 압축기 블레이드 오염, 마모 및 손상 여부 확인
3. 연료 공급 압력과 연료 제어 밸브 동작 상태 점검
4. 터빈 입구 온도 센서와 관련 제어 계통 점검
5. 압축기 및 터빈 내부 누설 여부 확인
6. 터빈 블레이드, 베어링, 윤활 계통 상태 점검

### AI 분석

현재 터빈은 **즉시 정지가 필요한 위험 상태로 보이지는 않습니다.** 다만 효율 저하와 압력 형성 부족 징후가 확인되고 있으므로 **예방 점검이 필요한 상태**입니다.`,
      actions: [{ type: "MONITORING", targetType: "TAG", targetValue: turbineTag, params: { on: true } }],
      confidence: 0.98,
      grounded: true,
      sources: [{ type: "spatial", label: "터빈 실시간 모니터링", detail: "고정 시연 데이터" }],
      retrieval: { source: "i3DWEB 실시간 모니터링", query: "터빈 운전 상태", hitCount: 6,
        data: { equipmentTag: turbineTag, health: "69.9%", inletTemperature: "26C", compressorEfficiency: 0.3,
          turbineEfficiency: 0.6, compressorPressureRatio: 0.8, outletPressure: "88 kPa" } },
    };
  }

  function buildPumpRagDemoAnswer(text, forcedDemo) {
    const q = String(text || "").replace(/\s+/g, "");
    const isPump = q.includes("원심펌프") || q.includes("펌프");
    let demo = forcedDemo || null;
    // 표현이 달라도 의도가 같으면 전용 박람회 UI로 고정한다.
    if (!demo && isPump && q.includes("세척제") &&
        (q.includes("낙하") || q.includes("공구") || q.includes("도구") || q.includes("공기구") || q.includes("이물질") || q.includes("FME"))) {
      demo = "cleaning";
    } else if (!demo && q.toUpperCase().includes("FME") &&
        (q.includes("설명") || q.includes("뜻") || q.includes("의미") || q.includes("뭐") || q.includes("무엇"))) {
      // LLM 의도 분류 서버 장애 시에만 사용하는 안전장치
      demo = "fme";
    } else if (!demo && isPump && q.includes("인양") &&
        (q.includes("와이어") || q.includes("아이볼트") || q.includes("Eyebolt")) &&
        (q.includes("수압") || q.includes("시험"))) {
      demo = "lifting";
    } else if (!demo && isPump && (q.includes("재조립") || q.includes("조립")) &&
        (q.includes("소모품") || q.includes("신품") || q.includes("새로") || q.includes("교체"))) {
      demo = "consumables";
    }
    if (!demo) return null;

    const common = { responseType: "ANSWER", answer: null, actions: [], confidence: 0.98, grounded: true,
      sources: [], generation: { model: "RAG demo", engine: "고정 근거형 mock", chunks: demo === "cleaning" ? 6 : 5 } };
    const cards = {
      cleaning: {
        message: "원심펌프 정비 시 이물질 유입 방지(FME)와 세척제 사용 안전 지침을 정리했습니다.",
        cols: [
          { title: "공기구 및 이물질 유입 방지 대책 (FME)", tone: "blue", items: [
            { icon: "tool", title: "공기구 끈 묶기", text: "펌프 내부 작업 시 낙하로 인한 계통 유입을 방지하기 위해 모든 공기구에는 탈락 방지용 끈(Tether)을 연결하여 작업해야 합니다.", cite: "절차-표준-020, 7.4.1" },
            { icon: "cover", title: "임시 커버 설치", text: "하부 케이싱, 배관 구개부 등 열려 있는 공간에는 안전 커버·플러그·블라인드 플랜지를 먼저 설치하고 재조립 직전에 제거 여부를 검사합니다.", cite: "절차-표준-020, 9.1.5 / 9.3.1" },
            { icon: "check", title: "FME 구역 관리", text: "반입·반출 품목의 수량과 상태를 기록하여 펌프 내부에 잔류물이 없도록 통제합니다.", cite: "절차-표준-020, 7.4.6" }
          ], check: ["공구 끈 연결 상태 확인", "반입·반출 품목 기록 및 확인", "개구부 임시 커버 설치 확인", "조립 전 내부 이물질 최종 점검"] },
          { title: "세척제 사용 제한 및 안전 조치", tone: "blue", alert: { title: "TCE 세척제 사용 금지", text: "절연전선 및 플라스틱, 고무 재질이 포함된 부품에는 TCE(삼염화 에틸렌: Trichloroethylene) 성분이 함유된 세척제 사용이 엄격히 금지됩니다.", cite: "절차-표준-020, 7.5.3" }, items: [
            { icon: "safety", title: "세척제 관리 및 안전", steps: ["난연성으로 허가받은 제품만 사용합니다.", "사용 전 MSDS(물질안전보건자료)를 숙지합니다.", "보호 장구를 착용하고 안전수칙을 준수합니다.", "작업 종료 후 지정된 현장 임시보관함으로 즉시 이동·보관합니다."], cite: "절차-표준-020, 7.5.2" }
          ] }
        ], refs: ["유지보수절차-표준-020 (개정 017.2) 7.4, 7.5", "이물질유입방지 절차서 (공화-기행-06)"]
      },
      fme: {
        message: "앞서 안내한 원심펌프 정비 내용에서 FME의 의미와 현장 적용 방법을 설명드립니다.",
        cols: [
          { title: "FME란 무엇인가요?", tone: "blue", items: [
            { icon: "check", title: "Foreign Material Exclusion", text: "FME는 Foreign Material Exclusion의 약자로, 정비 중 공구·부품·먼지 같은 이물질이 펌프나 배관 내부로 들어가지 않도록 통제하는 이물질 유입 방지 활동입니다." },
            { icon: "tool", title: "왜 필요한가요?", text: "내부에 남은 이물질은 임펠러 손상, 유로 막힘, 진동 증가 및 재기동 후 설비 고장의 원인이 될 수 있으므로 작업 시작부터 재조립 직전까지 관리해야 합니다." },
            { icon: "cover", title: "현장 적용 방법", text: "공기구에는 탈락 방지 끈(Tether)을 연결하고, 열린 케이싱과 배관 개구부에는 임시 커버를 설치하며, FME 구역의 반입·반출 품목 수량과 상태를 기록합니다.", cite: "절차-표준-020, 7.4.1 / 7.4.6" }
          ], check: ["공구 끈 연결", "개구부 임시 커버", "반입·반출 품목 기록", "조립 전 내부 최종 확인"] }
        ], refs: ["유지보수절차-표준-020 (개정 017.2) 7.4", "이물질유입방지 절차서 (공화-기행-06)"]
      },
      lifting: {
        message: "원심펌프 인양 절차 및 정비 후 검증(수압시험) 기준을 안내드립니다.",
        cols: [
          { title: "1. 펌프 몸체 인양 (Lifting) 절차", items: [
            { icon: "hook", title: "와이어 거는 위치", text: "임의의 배관이나 축에 와이어를 걸지 말고, 반드시 베어링 하우징 상부의 아이볼트(Eyebolt)에 와이어를 단단히 걸고 호이스트로 이동합니다.", cite: "절차-표준-020, 9.1.4" },
            { icon: "drop", title: "선행 해체 작업", text: "배수밸브를 열어 내부 유체를 완전히 배수하고, 씰 냉각수 라인·보조 배관·커플링 허브와 키를 분해한 뒤 케이싱과 아답타 체결 볼트를 해제합니다.", cite: "절차-표준-020, 8.4 / 9.1.4" },
            { icon: "check", title: "중량물 취급 안전", text: "인양 전에 중량물 작업계획서를 작성·승인받고 크레인 작업 구역 내 안전거리를 유지합니다.", cite: "절차-표준-020, 7.3.10" }
          ] },
          { title: "2. 정비 후 성능 검증 및 수압시험 기준", hero: { label: "수압시험 기준", value: "최고토출압력의 1.5배의 압력에서\n3분 이상 유지", text: "각 부분에서 누수 등 이상이 없어야 합니다.", cite: "KRSA-7014-R0, 4.2.2" }, items: [
            { icon: "pulse", title: "시운전 및 진동 측정", text: "수압시험 합격 후 시운전 30분 이상 경과 시 각 부위 진동을 측정해 분해 전과 비교하고, 발열 상태와 배관 플랜지 누설 여부를 정밀 계측하여 기록합니다.", cite: "절차-표준-020, 10.2" }
          ] }
        ], refs: ["유지보수절차-표준-020 (개정 017.2) 8.4, 9.1.4, 10.2", "KRSA-7014-R0 4.2.2"]
      },
      consumables: {
        message: "원심펌프 재조립 시 반드시 신품으로 교체해야 하는 소모품과 조립 시 주의사항을 정리했습니다.",
        cols: [
          { title: "1. 필수 신품 교체 소모성 부품 (100% 교체)", tone: "red", note: "펌프 내부를 개방했다가 재조립할 때는 마모·변형 유무와 관계없이 다음 소모품을 반드시 신품(New Version)으로 교체해야 합니다.", products: [["O-ring", "오링"], ["Gasket", "가스켓"], ["Gland Packing", "그랜드 패킹"], ["Oil Seal", "오일 씰"]], cite: "절차-표준-020, 9.3.1" },
          { title: "2. 교체용 메카니컬 씰 (Mechanical Seal) 기준", seal: true, bullets: ["고온(120℃) 및 고압(1.0 MPa 이상) 조건에 충분히 견딜 수 있는 사양", "별도 급유 없이 펌프 내부 이송 유체 자체로 씰 면이 자동 윤활 및 냉각되는 구조"], cite: "KRSA-7014-R0, 3.3.5" },
          { title: "3. 조립 시 기계적 손상 예방 조치", tone: "amber", items: [
            { icon: "bolt", title: "틈새부식 방지제 도포", text: "플랜지 접합면과 볼트·너트 나사 결합부에는 고착과 부식을 방지하기 위해 틈새부식 방지제를 얇게 발라줍니다.", cite: "절차-표준-020, 9.3.1" },
            { icon: "target", title: "Match Mark 일치 조립", text: "축의 편심과 비틀림을 예방하기 위해 공장 출하 마크 또는 분해 전 표시한 Match Mark의 선을 완전히 일치시켜 체결합니다.", cite: "절차-표준-020, 9.3.1" }
          ] }
        ], refs: ["유지보수절차-표준-020 (개정 017.2) 9.3.1", "KRSA-7014-R0 3.3.5"]
      }
    };
    const d = cards[demo];
    const contextSummary = demo === "cleaning" || demo === "fme"
      ? "FME는 Foreign Material Exclusion, 즉 이물질 유입 방지를 의미합니다. 원심펌프 내부 작업 시 공기구에 Tether를 연결하고 개구부에 임시 커버를 설치하며 반입·반출 품목을 기록합니다. 절연전선·플라스틱·고무 부품에는 TCE 함유 세척제를 사용하지 않습니다."
      : demo === "lifting"
        ? "원심펌프 인양은 베어링 하우징 상부 아이볼트에 와이어를 걸어 수행합니다. 정비 후 수압시험은 최고토출압력의 1.5배에서 3분 이상 유지하고 누수가 없어야 합니다."
        : "원심펌프 재조립 시 O-ring, Gasket, Gland Packing, Oil Seal은 상태와 관계없이 신품으로 교체합니다.";
    return Object.assign(common, { message: d.message, contextSummary: contextSummary,
      blocks: [{ kind: "pumpRag", variant: demo, cols: d.cols, refs: d.refs }],
      retrieval: { source: "유지보수 매뉴얼 RAG mock", query: text, hitCount: d.refs.length, owner: "ai", data: { demo: demo } } });
  }

  /* ── LLM이 생성한 action JSON(plan)을 실행 → 응답 객체 ──── */
  const VIEWER_TYPES = [
    // 솔루션팀 뷰어 액션 인터페이스 (docs/AI 채팅 구현.xlsx · ON/OFF는 params.on)
    "JUMP_TO", "TOP_VIEW", "FRONT_VIEW", "SIDE_VIEW", "ISO_VIEW", "HOME",
    "CLIP", "CLIP_AXIS", "CLIP_FLIP", "CLIP_SIZE",
    "SHOW_ONLY", "HIDE", "HIDE_ALL", "SHOW_ALL", "UNSELECT_ALL",
    "AVATAR", "KEY_MAP", "PID", "MONITORING", "SEARCH",
    // mock 데모 확장 (작업 위치/구역 안내)
    "MOVE_TO_INSPECTION", "SHOW_PATH", "SHOW_INSPECTION_ROUTE", "FIND_NEAREST",
    "SHOW_WORKER_POSITION", "SHOW_WORK_ZONE",
    // 규칙 폴백(오프라인)이 쓰는 구형 타입 — executor에 함께 등록되어 있음
    "SEARCH_EQUIPMENT", "ROTATE_VIEW", "HIDE_OBJECT", "SHOW_OBJECT",
    "ISOLATE_SYSTEM", "FILTER_BY_TYPE", "SHOW_PID"];

  async function executePlan(plan, request) {
    const text = request.message || "";
    const ctxTag = (request.viewerContext && request.viewerContext.currentTag) || null;
    const acts = (plan.actions || []).map((a) => Object.assign({ params: {} }, a));
    const viewerActs = acts.filter((a) => VIEWER_TYPES.indexOf(a.type) >= 0);
    const queryAct = acts.find((a) => a.type && a.type.indexOf("QUERY_") === 0);
    const ragAct = acts.find((a) => a.type === "MANUAL_RAG");
    const planMeta = { model: plan.model || "qwen3.5:9b", actions: plan.actions };

    // 답변부 (사실은 DB/RAG에 위임 — 환각 방지)
    let ansObj = null;
    if (ragAct) {
      try {
        const vt = ragAct.valveType && ragAct.valveType !== "null" ? ragAct.valveType : valveTypeOf(request);
        const r = await window.RagClient.answer(ragAct.query || text, vt);
        if (r && r.hitCount > 0) ansObj = buildRagAnswer(ragAct.query || text, vt, r);
      } catch (e) { /* ignore */ }
    } else if (queryAct) {
      const tv = queryAct.targetValue || ctxTag || "TG-PMP-101";
      if (queryAct.type === "QUERY_MAINTENANCE") ansObj = buildMaintenanceAnswer(tv, text);
      else if (queryAct.type === "QUERY_CYCLE") ansObj = buildCycleAnswer(tv, text);
      else if (queryAct.type === "QUERY_SPATIAL") ansObj = buildWorkConditionAnswer(tv, text);
      else if (queryAct.type === "QUERY_WORKFLOW") ansObj = buildStageAnswer(tv, text);
    }

    if (viewerActs.length && ansObj) {
      ansObj.responseType = "ANSWER_WITH_ACTION";
      ansObj.actions = viewerActs;
      if (plan.message) ansObj.message = plan.message;
      ansObj.plan = planMeta;
      return ansObj;
    }
    if (viewerActs.length) {
      return { responseType: "ACTION", message: plan.message || "실행합니다.", answer: null,
        actions: viewerActs, confidence: 0.9, plan: planMeta };
    }
    if (ansObj) { ansObj.plan = planMeta; return ansObj; }
    // 순수 ANSWER
    return { responseType: "ANSWER", message: "",
      answer: plan.message || "확인이 필요합니다.", actions: [], confidence: 0.6, plan: planMeta };
  }

  /* ── 정비점검절차 리치 카드 (절차-표준-020 · 범용 원심펌프) ────
     "정비점검절차 알려줘" → 절차서 헤더 + workflow 흐름도 + 섹션 상세 카드.
     본문에는 1. 작업 준비사항만 펼치고, 2~4 단계는 상단 흐름도로만 표시. */
  function isProcedureCardQuery(text) {
    const t = String(text || "").replace(/\s+/g, "");
    return t.indexOf("정비점검절차") >= 0
      || (t.indexOf("점검착수전") >= 0 && (t.indexOf("확인사항") >= 0 || t.indexOf("점검사항") >= 0))
      || ((t.indexOf("펌프") >= 0 || t.indexOf("이장비") >= 0 || t.indexOf("해당장비") >= 0 || t.indexOf("장비") >= 0)
        && (t.indexOf("정비절차") >= 0 || t.indexOf("점검절차") >= 0));
  }

  function isPreInspectionQuery(text) {
    const t = String(text || "").replace(/\s+/g, "");
    return t.indexOf("점검착수전") >= 0 && (t.indexOf("확인사항") >= 0 || t.indexOf("점검사항") >= 0);
  }

  const PRE_INSPECTION_ITEMS = [
    "설비 Tag, 명판, 계통도 및 작업 위치를 대조하여 작업 대상을 확인한다.",
    "최근 진동·온도·누설·압력·유량 기록과 전회 정비이력을 검토하여 중점 점검항목을 선정한다.",
    "정비 전후 비교를 위해 진동, 베어링 온도, 흡입·토출 압력, 유량, 전류 및 축정렬 측정계획을 수립한다.",
    "진동계, 온도계, 다이얼 게이지, 축정렬기 등 계측기의 검교정 상태와 작동 여부를 확인한다.",
    "토크렌치, 베어링 풀러, 커플링 분리공구 및 인양장비의 규격과 이상 여부를 확인한다.",
    "베어링, 씰, 패킹, O-ring, 가스켓, 윤활제 등 예상 교체부품과 소모품을 준비한다.",
    "전원, 흡입·토출 배관, 씰수, 냉각수 및 윤활계통의 격리범위를 운전부서와 사전 협의한다.",
    "작업통제구역, 부품 세척·보관구역, FME 구역 및 중량물 적치용 받침목을 설치한다.",
    "제작사 매뉴얼, 단면도, 축정렬·간극·진동·온도 및 체결토크 판정기준을 준비한다."
  ];

  // 원본: 유지보수메뉴얼/(절차-표준-020) 범용 원심펌프 정비.pdf — 7.2 작업준비 사항
  const PROC_020 = {
    kind: "procedure",
    title: "범용 원심펌프 정비 절차",
    docBadge: "절차서: 유지보수절차-표준-020 (개정 017.2)",
    image: "assets/images/pump_procedure.png",
    srcBtn: "원본 절차서 보기",
    meta: [
      { icon: "equip", k: "적용 장비", v: "범용 원심펌프" },
      { icon: "doc",   k: "문서 번호", v: "유지보수절차-표준-020" },
      { icon: "rev",   k: "개정 번호", v: "017.2" },
      { icon: "goal",  k: "주요 목적", v: "안전한 정비 수행 및\n이물질 유입·화재 예방" }
    ],
    steps: [
      { no: 1, name: "작업 준비사항",        icon: "clipboard", active: true },
      { no: 2, name: "산업재해 예방활동",    icon: "shield" },
      { no: 3, name: "이물질 유입 방지활동", icon: "funnel" },
      { no: 4, name: "화재 예방활동",        icon: "flame" }
    ],
    sections: [
      { no: 1, title: "작업 준비사항", items: [
        "소요장비, 자재, 공기구 등을 사전 점검하고 준비한다.",
        "전회 정비작업의 정비기록사항, 운전 중 발생되었던 문제점을 사전 검토한다.",
        "관련부서와 작업에 대한 사전협의를 한다.",
        "사용되는 모든 계측기는 검교정이 완료되고, 유효기간 이내의 것을 사용한다.",
        "정비원은 작업 전 관련절차에 따라 작업허가를 정비작업 착수 전, 완료 후 발전팀장에게 통보하여야 한다.",
        "정비절차서, 정비검사/보고서 및 관련 도면 등을 사전 준비한다.",
        "정비현황판 설치 및 작업구역을 설정한다.",
        "부품을 분해할 적정장소를 선정하여 작업장 표시를 하고 비닐, 합판 작업대 등을 준비한다.",
        "부품을 바닥에 내려놓을 때 바닥과 부품사이에 침목을 설치한다."
      ] }
    ],
    continueNote: "이어서: 2. 산업재해 예방활동, 3. 이물질 유입 방지활동, 4. 화재 예방활동",
    footer: [
      { icon: "doc",      label: "관련 절차서 보기" },
      { icon: "download", label: "체크리스트 다운로드" },
      { icon: "alert",    label: "안전수칙 요약" },
      { icon: "move",     label: "3D 위치로 이동", act: "jump", target: "TG-PMP-101" }
    ]
  };

  function buildProcedureCardAnswer(text) {
    const preInspection = isPreInspectionQuery(text);
    const procedureBlock = preInspection
      ? Object.assign({}, PROC_020, {
          title: "원심펌프 점검 착수 전 확인사항",
          meta: [
            { icon: "equip", k: "적용 장비", v: "범용 원심펌프" },
            { icon: "doc", k: "문서 번호", v: "유지보수절차-표준-020" },
            { icon: "goal", k: "주요 목적", v: "원심펌프의 안전한 분해·점검·조립 및 성능 복원" }
          ],
          steps: [
            { no: 1, name: "작업 준비", icon: "clipboard", active: true },
            { no: 2, name: "안전조치·설비 격리", icon: "shield" },
            { no: 3, name: "FME·부품 관리", icon: "funnel" },
            { no: 4, name: "화재·세척제 안전", icon: "flame" }
          ],
          sections: [{ no: 1, title: "점검 착수 전 확인사항", items: PRE_INSPECTION_ITEMS }],
          continueNote: "확인 완료 후 산업재해 예방활동과 이물질·화재 예방조치를 수행합니다."
        })
      : PROC_020;
    return {
      responseType: "ANSWER_WITH_ACTION",
      message: preInspection
        ? "해당 장비의 단면을 표시하고 원심펌프 점검 착수 전 확인사항을 안내합니다.\n아래 내용은 유지보수절차-표준-020 (개정 017.2) 기준입니다."
        : "범용 원심펌프 정비 절차를 안내해드리겠습니다.\n아래 절차는 유지보수절차-표준-020 (개정 017.2) 기준입니다.",
      answer: null,
      actions: [{ type: "CLIP", targetType: "TAG", targetValue: "TG-PMP-101", params: { on: true } }],
      confidence: 0.95, grounded: true,
      sources: [],
      blocks: [procedureBlock],
      retrieval: { source: "절차서 검색 (유지보수절차-표준-020)", query: text,
        hitCount: PROC_020.sections[0].items.length, owner: "ai",
        data: { doc: "절차-표준-020", section: "7.2 작업준비 사항", steps: PROC_020.steps.map((s) => s.name) } }
    };
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
    if (/펌프|pump/i.test(t)) return "pump";
    const tag = request.viewerContext && request.viewerContext.currentTag;
    const map = { "TG-PMP-101": "pump", "TG-VLV-205": "globe", "GV-102A": "gate" };
    return (tag && map[tag]) || null;   // 없으면 전체 검색
  }
  function buildRagAnswer(query, vt, r) {
    const vlabel = vt === "gate" ? "Gate 밸브 " : vt === "globe" ? "Globe 밸브 " : vt === "pump" ? "원심 펌프 " : "";
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
      generation: { model: r.model || "qwen3.5:9b", engine: "Ollama (로컬)", chunks: r.hitCount }
    };
  }

  window.AiBackend = { requestAiResponse, RESPONSE_TYPES };
})();
