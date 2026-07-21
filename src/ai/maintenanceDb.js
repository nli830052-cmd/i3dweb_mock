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
    "TG-PMP-101": {
      tag: "TG-PMP-101", name: "원심 펌프",
      history: [
        { date: "2025-03-21", wo: "WO-2025-0321", type: "분해정비 (Overhaul)", result: "조건부 정상", note: "임펠러 세척, 축 휨 측정, 베어링·그랜드패킹·가스켓 교체 완료. 그랜드패킹부 미세 누설 잔존 및 모터 베어링 진동 재확인 필요로 Open Point 등록" },
        { date: "2025-01-14", wo: "WO-2025-0114", type: "누설점검", result: "추적 관찰 필요", note: "그랜드패킹부 미세 누설 확인 및 그랜드 팔로워 볼트 너트 조임" },
        { date: "2024-08-02", wo: "WO-2024-0802", type: "정기점검", result: "정상", note: "진동, 온도, 누유 및 베어링 상태 점검" }
      ],
      lastOverhaul: { date: "2025-03-21", wo: "WO-2025-0321", detail: "임펠러/케이싱 링 간극 측정, 축 휨 측정, 베어링·그랜드패킹·가스켓 신품 교체, 누설·진동 재확인 Open Point 등록", result: "조건부 정상" },
      bonnetGasket: [{ date: "2025-03-21", wo: "WO-2025-0321" }],
      leaks: [{ date: "2025-01-14", wo: "WO-2025-0114", part: "그랜드패킹", action: "그랜드 팔로워 볼트 너트 조임 및 패킹 상태 확인" }],
      recurring: "그랜드패킹부 미세 누설 반복 확인 (2024-08-02 정기점검, 2025-01-14 누설점검)",
      inspectionResult: "정비 주기 초과 — 그랜드패킹부 누설 및 모터 베어링 진동 재확인 권고",
      openPoints: [{ id: "OP-2025-0321", wo: "WO-2025-0321", date: "2025-03-21", desc: "그랜드패킹부 미세 누설 및 모터 베어링 진동 재확인 필요", status: "진행 중", due: "2026-06-26", dept: "정비2팀", linkedWo: "WO-2026-0612" }],
      priorityParts: ["그랜드패킹", "임펠러", "볼 베어링", "주축", "케이싱 가스켓"],
      cycleMonths: 12, lastMaintenance: "2025-03-21", nextDue: "2026-03-21"
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
