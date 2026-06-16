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
    "GV-101A": {
      tag: "GV-101A", name: "글로브 밸브",
      currentStage: "분해 전 준비 단계 완료, 밸브 몸체 분해 전",
      nextStage: "구동모터 분해",
      nextStepDetail: "밸브를 Full Close 상태로 놓고 구동모터 고정볼트를 분해하는 것입니다. 작업 전 전원 차단과 Red Tag 상태를 다시 확인하세요.",
      checklist: ["전원 차단 확인", "Red Tag 확인", "배관 배수 확인", "Match Mark 표시", "공기구 준비", "작업구역 설정"],
      prepIncomplete: ["Match Mark 표시", "보닛-바디 플랜지 간격 측정"],
      assemblyMissing: ["배관 내부 세척 확인", "부품 표면 스크래치 확인"]
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

  window.WorkflowDB = { query, RECORDS };
})();
