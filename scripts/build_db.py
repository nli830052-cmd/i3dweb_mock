# -*- coding: utf-8 -*-
"""
정형 데이터(정비이력/공간/작업오더)를 SQLite(data/app.db)에 적재.  [DB 시드]

기존 하드코딩 mock(maintenanceDb.js/spatialDb.js/workflowDb.js)을 DB로 이전.
중첩 필드(history/leaks 등)는 JSON 문자열로 저장.

usage:  python scripts/build_db.py
out:    data/app.db  (테이블: maintenance, spatial, workflow)
"""
import sqlite3, json, os

DB = "data/app.db"

MAINTENANCE = {
    "TG-PMP-101": {
        "name": "원심 펌프",
        "history": [
            {"date": "2025-03-21", "wo": "WO-2025-0321", "type": "분해정비 (Overhaul)", "result": "조건부 정상", "note": "임펠러 세척, 축 휨 측정, 베어링·그랜드패킹·가스켓 교체 완료. 그랜드패킹부 미세 누설 잔존 및 모터 베어링 진동 재확인 필요로 Open Point 등록"},
            {"date": "2025-01-14", "wo": "WO-2025-0114", "type": "누설점검", "result": "추적 관찰 필요", "note": "그랜드패킹부 미세 누설 확인 및 그랜드 팔로워 볼트 너트 조임"},
            {"date": "2024-08-02", "wo": "WO-2024-0802", "type": "정기점검", "result": "정상", "note": "진동, 온도, 누유 및 베어링 상태 점검"},
        ],
        "lastOverhaul": {"date": "2025-03-21", "wo": "WO-2025-0321", "detail": "임펠러/케이싱 링 간극 측정, 축 휨 측정, 베어링·그랜드패킹·가스켓 신품 교체, 누설·진동 재확인 Open Point 등록", "result": "조건부 정상"},
        "bonnetGasket": [{"date": "2025-03-21", "wo": "WO-2025-0321"}],
        "leaks": [{"date": "2025-01-14", "wo": "WO-2025-0114", "part": "그랜드패킹", "action": "그랜드 팔로워 볼트 너트 조임 및 패킹 상태 확인"}],
        "recurring": "그랜드패킹부 미세 누설 반복 확인 (2024-08-02 정기점검, 2025-01-14 누설점검)",
        "inspectionResult": "정비 주기 초과 — 그랜드패킹부 누설 및 모터 베어링 진동 재확인 권고",
        "openPoints": [{
            "id": "OP-2025-0321", "wo": "WO-2025-0321", "date": "2025-03-21",
            "desc": "그랜드패킹부 미세 누설 및 모터 베어링 진동 재확인 필요", "status": "진행 중",
            "due": "2026-06-26", "dept": "정비2팀", "linkedWo": "WO-2026-0612",
        }],
        "priorityParts": ["그랜드패킹", "임펠러", "볼 베어링", "주축", "케이싱 가스켓"],
        "cycleMonths": 12, "lastMaintenance": "2025-03-21", "nextDue": "2026-03-21",
    },
    "TG-VLV-205": {
        "name": "제어 밸브",
        "history": [{"date": "2025-09-30", "type": "정기 점검"}, {"date": "2025-04-10", "type": "액추에이터 교정"}],
        "lastOverhaul": {"date": "2024-10-05", "detail": "분해 점검 및 시트 가공"},
        "bonnetGasket": [], "leaks": [],
        "recurring": "특이 반복 이슈 없음", "inspectionResult": "정상",
        "openPoints": [], "priorityParts": ["스템", "시트", "패킹"],
        "cycleMonths": 12, "lastMaintenance": "2025-09-30", "nextDue": "2026-09-30",
    },
    "GV-102A": {
        "name": "게이트 밸브",
        "history": [{"date": "2025-06-18", "type": "정기 점검"}],
        "lastOverhaul": {"date": "2023-12-01", "detail": "분해 정비"},
        "bonnetGasket": [{"date": "2023-12-01"}], "leaks": [],
        "recurring": "특이 반복 이슈 없음", "inspectionResult": "정상",
        "openPoints": [], "priorityParts": ["디스크", "시트", "스템"],
        "cycleMonths": 12, "lastMaintenance": "2025-06-18", "nextDue": "2026-06-18",
    },
}

SPATIAL = {
    "TG-PMP-101": {"clearance": {"front": 1.2, "right": 0.8}, "height": 2.3, "fallHazard": {"exists": True, "dir": "우측", "distM": 1.5, "type": "모터 베이스 하부 배관 개구부"}},
    "TG-VLV-205": {"clearance": {"front": 1.5, "right": 1.2}, "height": 1.6, "fallHazard": {"exists": False}},
    "GV-102A": {"clearance": {"front": 1.0, "right": 0.6}, "height": 0.9, "fallHazard": {"exists": False}},
}

WORKFLOW = {
    "TG-PMP-101": {
        "name": "원심 펌프",
        "currentStage": "분해 전 준비 단계 완료, 펌프 몸체 분해 전",
        "nextStage": "커플링 허브 분리 및 펌프 몸체 인양",
        "nextStepDetail": "커플링 플랜지 볼트를 풀어 모터와 축을 분리하고, 베어링 하우징 아이볼트에 와이어를 걸어 호이스트로 펌프 몸체를 들어 올려 이동 작업대 위에 거치시킵니다.",
        "checklist": ["전원 차단 및 LOTO 확인", "배수 밸브 오픈 및 배수", "보조 배관 및 냉각수 라인 해체", "커플링 가드 제거", "Match Mark 표시", "인양 와이어 및 호이스트 준비"],
        "prepIncomplete": ["Match Mark 표시", "커플링 면간 거리 측정"],
        "assemblyMissing": ["축 휨 측정 확인", "베어링 하우징 내부 청소 및 윤활유 보충"],
    },
    "TG-VLV-205": {
        "name": "제어 밸브",
        "currentStage": "작업 시작 전 (작업오더 대기)",
        "nextStage": "분해 전 준비",
        "nextStepDetail": "작업 허가 및 LOTO 적용 후 분해 전 준비 단계를 시작합니다.",
        "checklist": ["작업 허가 확인", "LOTO 적용", "공기구 준비"],
        "prepIncomplete": ["작업 허가 확인", "LOTO 적용"],
        "assemblyMissing": [],
    },
}

def J(x):
    return json.dumps(x, ensure_ascii=False)

def main():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    con = sqlite3.connect(DB)
    cur = con.cursor()
    cur.executescript("""
        DROP TABLE IF EXISTS maintenance;
        DROP TABLE IF EXISTS spatial;
        DROP TABLE IF EXISTS workflow;
        CREATE TABLE maintenance(
            tag TEXT PRIMARY KEY, name TEXT, cycle_months INTEGER,
            last_maintenance TEXT, next_due TEXT, inspection_result TEXT, recurring TEXT,
            history TEXT, last_overhaul TEXT, bonnet_gasket TEXT, leaks TEXT,
            open_points TEXT, priority_parts TEXT);
        CREATE TABLE spatial(
            tag TEXT PRIMARY KEY, clearance_front REAL, clearance_right REAL,
            height REAL, fall_hazard TEXT);
        CREATE TABLE workflow(
            tag TEXT PRIMARY KEY, name TEXT, current_stage TEXT, next_stage TEXT,
            next_step_detail TEXT, checklist TEXT, prep_incomplete TEXT, assembly_missing TEXT);
    """)

    for tag, r in MAINTENANCE.items():
        cur.execute("INSERT INTO maintenance VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            tag, r["name"], r["cycleMonths"], r["lastMaintenance"], r["nextDue"],
            r["inspectionResult"], r["recurring"], J(r["history"]), J(r["lastOverhaul"]),
            J(r["bonnetGasket"]), J(r["leaks"]), J(r["openPoints"]), J(r["priorityParts"])))

    for tag, r in SPATIAL.items():
        cur.execute("INSERT INTO spatial VALUES (?,?,?,?,?)", (
            tag, r["clearance"]["front"], r["clearance"]["right"], r["height"], J(r["fallHazard"])))

    for tag, r in WORKFLOW.items():
        cur.execute("INSERT INTO workflow VALUES (?,?,?,?,?,?,?,?)", (
            tag, r["name"], r["currentStage"], r["nextStage"], r["nextStepDetail"],
            J(r["checklist"]), J(r["prepIncomplete"]), J(r["assemblyMissing"])))

    con.commit()
    print("적재 완료 → %s" % DB)
    for t in ("maintenance", "spatial", "workflow"):
        print("  %-12s %d rows" % (t, cur.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]))
    con.close()

if __name__ == "__main__":
    main()
