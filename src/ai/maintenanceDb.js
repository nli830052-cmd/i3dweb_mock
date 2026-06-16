/* ============================================================
 *  src/ai/maintenanceDb.js  —  [AI팀 영역 · 데이터 소스(mock)]
 *  CMMS/정비이력 DB stand-in. 실제 연동 시 이 파일을 실제 DB/RAG
 *  조회로 교체(window.MaintenanceDB.query 시그니처 유지).
 *
 *  공개 API:
 *    MaintenanceDB.query(tag) -> 레코드 | null
 *
 *  ★ 실제 연동: query()를 CMMS API 또는 chroma RAG 검색으로 교체.
 * ========================================================== */
(function () {
  "use strict";

  const RECORDS = {
    "GV-101A": {
      tag: "GV-101A", name: "글로브 밸브",
      history: [
        { date: "2025-11-14", type: "그랜드패킹 점검" },
        { date: "2025-08-02", type: "누설 점검" },
        { date: "2025-03-21", type: "분해 정비" }
      ],
      lastOverhaul: { date: "2025-03-21", detail: "디스크/시트 접촉 상태 점검, 그랜드패킹 교체" },
      bonnetGasket: [{ date: "2025-03-21" }],
      leaks: [{ date: "2025-08-02", part: "그랜드패킹", action: "패킹 조임 및 상태 점검" }],
      recurring: "그랜드패킹 부위 누설",
      inspectionResult: "조건부 정상 — 밸브 작동 가능하나 그랜드패킹 부위 재점검 권고 등록",
      openPoints: [{ desc: "그랜드패킹 누설 재확인 필요", due: "2026-06-20" }],
      cycleMonths: 12, lastMaintenance: "2025-03-21", nextDue: "2026-06-20"
    },
    "TG-VLV-205": {
      tag: "TG-VLV-205", name: "제어 밸브",
      history: [
        { date: "2025-09-30", type: "정기 점검" },
        { date: "2025-04-10", type: "액추에이터 교정" }
      ],
      lastOverhaul: { date: "2024-10-05", detail: "분해 점검 및 시트 가공" },
      bonnetGasket: [],
      leaks: [],
      recurring: "특이 반복 이슈 없음",
      inspectionResult: "정상",
      openPoints: [],
      cycleMonths: 12, lastMaintenance: "2025-09-30", nextDue: "2026-09-30"
    },
    "GV-102A": {
      tag: "GV-102A", name: "게이트 밸브",
      history: [{ date: "2025-06-18", type: "정기 점검" }],
      lastOverhaul: { date: "2023-12-01", detail: "분해 정비" },
      bonnetGasket: [{ date: "2023-12-01" }],
      leaks: [],
      recurring: "특이 반복 이슈 없음",
      inspectionResult: "정상",
      openPoints: [],
      cycleMonths: 12, lastMaintenance: "2025-06-18", nextDue: "2026-06-18"
    }
  };

  function query(tag) { return RECORDS[tag] || null; }

  window.MaintenanceDB = { query, RECORDS };
})();
