/* ============================================================
 *  src/viewer/spatialDb.js  —  [솔루션팀 영역 · Walkinside 공간 데이터(mock)]
 *  작업 공간/높이/추락위험 등 공간 측정값 stand-in.
 *  실제 연동 시 Walkinside 공간 질의 API로 교체.
 *
 *  공개 API:
 *    SpatialDB.query(tag) -> { clearance:{front,right}, height, fallHazard } | null
 *
 *  참고: 정비 이력(CMMS)은 AI팀 소유, 공간 데이터는 솔루션팀(Walkinside) 소유.
 * ========================================================== */
(function () {
  "use strict";

  const SPATIAL = {
    "TG-PMP-101": { clearance: { front: 1.2, right: 0.8 }, height: 2.3, fallHazard: { exists: true, dir: "우측", distM: 1.5, type: "모터 베이스 하부 배관 개구부" } },
    "TG-VLV-205": { clearance: { front: 1.5, right: 1.2 }, height: 1.6, fallHazard: { exists: false } },
    "GV-102A": { clearance: { front: 1.0, right: 0.6 }, height: 0.9, fallHazard: { exists: false } }
  };

  function query(tag) { return SPATIAL[tag] || null; }

  function hydrate() {
    const base = (window.RagClient && window.RagClient.BASE) || "http://localhost:8090";
    fetch(base + "/api/db/spatial/all")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { Object.keys(SPATIAL).forEach((k) => delete SPATIAL[k]); Object.assign(SPATIAL, d); console.log("[SpatialDB] SQLite 동기화", Object.keys(SPATIAL).length, "건"); } })
      .catch(() => {});
  }

  window.SpatialDB = { query, SPATIAL, hydrate };
  hydrate();
})();
