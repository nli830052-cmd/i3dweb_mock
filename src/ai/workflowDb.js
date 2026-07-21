/* ============================================================
 *  src/ai/workflowDb.js  —  [AI팀 영역 · 작업오더(WO) 워크플로(mock)]
 *  정비 작업 단계/체크리스트 상태 stand-in.
 *  실제 연동 시 CMMS 작업오더 API로 교체(query 시그니처 유지).
 *
 *  공개 API:
 *    WorkflowDB.query(tag) -> 작업 단계 레코드 | null
 * ========================================================== */
(function () {
  "use strict";

  const RECORDS = {
    "TG-PMP-101": {
      tag: "TG-PMP-101", name: "원심 펌프",
      currentStage: "분해 전 준비 단계 완료, 펌프 몸체 분해 전",
      nextStage: "커플링 허브 분리 및 펌프 몸체 인양",
      nextStepDetail: "커플링 플랜지 볼트를 풀어 모터와 축을 분리하고, 베어링 하우징 아이볼트에 와이어를 걸어 호이스트로 펌프 몸체를 들어 올려 이동 작업대 위에 거치시킵니다.",
      checklist: ["전원 차단 및 LOTO 확인", "배수 밸브 오픈 및 배수", "보조 배관 및 냉각수 라인 해체", "커플링 가드 제거", "Match Mark 표시", "인양 와이어 및 호이스트 준비"],
      prepIncomplete: ["Match Mark 표시", "커플링 면간 거리 측정"],
      assemblyMissing: ["축 휨 측정 확인", "베어링 하우징 내부 청소 및 윤활유 보충"]
    },
    "TG-VLV-205": {
      tag: "TG-VLV-205", name: "제어 밸브",
      currentStage: "작업 시작 전 (작업오더 대기)",
      nextStage: "분해 전 준비",
      nextStepDetail: "작업 허가 및 LOTO 적용 후 분해 전 준비 단계를 시작합니다.",
      checklist: ["작업 허가 확인", "LOTO 적용", "공기구 준비"],
      prepIncomplete: ["작업 허가 확인", "LOTO 적용"],
      assemblyMissing: []
    }
  };

  function query(tag) { return RECORDS[tag] || null; }

  function hydrate() {
    const base = (window.RagClient && window.RagClient.BASE) || "http://localhost:8090";
    fetch(base + "/api/db/workflow/all")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { Object.keys(RECORDS).forEach((k) => delete RECORDS[k]); Object.assign(RECORDS, d); console.log("[WorkflowDB] SQLite 동기화", Object.keys(RECORDS).length, "건"); } })
      .catch(() => {});
  }

  window.WorkflowDB = { query, RECORDS, hydrate };
  hydrate();
})();
