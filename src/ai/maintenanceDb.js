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
        { date: "2025-11-14", wo: "WO-2025-1114", type: "그랜드패킹부 재점검", result: "조건부 정상", note: "패킹부 미세 비침 관찰" },
        { date: "2025-08-02", wo: "WO-2025-0802", type: "그랜드패킹부 누설 점검", result: "추적 관찰 필요", note: "스템 주변 패킹부 누설 → 그랜드너트 좌우 균등 조임" },
        { date: "2025-03-21", wo: "WO-2025-0321", type: "분해정비", result: "정상", note: "디스크/시트 Blue Check, 스템 점검, 그랜드패킹·보닛 가스켓 교체" }
      ],
      lastOverhaul: { date: "2025-03-21", wo: "WO-2025-0321", detail: "디스크/시트 Blue Check, 스템 4항목 점검, 그랜드패킹·보닛 가스켓 신품 교체", result: "정상" },
      bonnetGasket: [{ date: "2025-03-21", wo: "WO-2025-0321" }],
      leaks: [{ date: "2025-08-02", wo: "WO-2025-0802", part: "그랜드패킹", action: "그랜드너트 좌우 균등 조임" }],
      recurring: "그랜드패킹부 누설 (최근 12개월 내 동일 부위 2회: 2025-08-02, 2025-11-14)",
      inspectionResult: "조건부 정상 — 밸브 작동 가능하나 그랜드패킹 부위 재점검 권고 등록",
      openPoints: [{ id: "OP-2025-114", wo: "WO-2025-1114", date: "2025-11-14", desc: "그랜드패킹부 미세 비침 재확인 필요", status: "진행 중", due: "2026-06-26", dept: "정비2팀", linkedWo: "WO-2026-0612" }],
      priorityParts: ["그랜드패킹", "스템", "디스크/시트", "보닛 가스켓"],
      cycleMonths: 12, lastMaintenance: "2025-03-21", nextDue: "2026-06-26"
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
      priorityParts: ["스템", "시트", "패킹"],
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
      priorityParts: ["디스크", "시트", "스템"],
      cycleMonths: 12, lastMaintenance: "2025-06-18", nextDue: "2026-06-18"
    }
  };

  function query(tag) { return RECORDS[tag] || null; }

  // 시작 시 SQLite(백엔드)에서 동기화. 실패하면 위 하드코딩값을 폴백으로 사용.
  function hydrate() {
    const base = (window.RagClient && window.RagClient.BASE) || "http://localhost:8090";
    fetch(base + "/api/db/maintenance/all")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { Object.keys(RECORDS).forEach((k) => delete RECORDS[k]); Object.assign(RECORDS, d); console.log("[MaintenanceDB] SQLite 동기화", Object.keys(RECORDS).length, "건"); } })
      .catch(() => {});
  }

  window.MaintenanceDB = { query, RECORDS, hydrate };
  hydrate();
})();
