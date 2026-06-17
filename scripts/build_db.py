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
    "GV-101A": {
        "name": "글로브 밸브",
        "history": [
            {"date": "2025-11-14", "type": "그랜드패킹 점검"},
            {"date": "2025-08-02", "type": "누설 점검"},
            {"date": "2025-03-21", "type": "분해 정비"},
        ],
        "lastOverhaul": {"date": "2025-03-21", "detail": "디스크/시트 접촉 상태 점검, 그랜드패킹 교체"},
        "bonnetGasket": [{"date": "2025-03-21"}],
        "leaks": [{"date": "2025-08-02", "part": "그랜드패킹", "action": "패킹 조임 및 상태 점검"}],
        "recurring": "그랜드패킹 부위 누설",
        "inspectionResult": "조건부 정상 — 밸브 작동 가능하나 그랜드패킹 부위 재점검 권고 등록",
        "openPoints": [{"desc": "그랜드패킹 누설 재확인 필요", "due": "2026-06-20"}],
        "priorityParts": ["그랜드패킹", "스템", "디스크/시트", "보닛 가스켓"],
        "cycleMonths": 12, "lastMaintenance": "2025-03-21", "nextDue": "2026-06-20",
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
    "GV-101A": {"clearance": {"front": 1.2, "right": 0.8}, "height": 2.3, "fallHazard": {"exists": True, "dir": "좌측", "distM": 2, "type": "개구부 위험 구역"}},
    "TG-VLV-205": {"clearance": {"front": 1.5, "right": 1.2}, "height": 1.6, "fallHazard": {"exists": False}},
    "GV-102A": {"clearance": {"front": 1.0, "right": 0.6}, "height": 0.9, "fallHazard": {"exists": False}},
    "TG-PMP-101": {"clearance": {"front": 1.4, "right": 1.0}, "height": 1.1, "fallHazard": {"exists": False}},
}

WORKFLOW = {
    "GV-101A": {
        "name": "글로브 밸브",
        "currentStage": "분해 전 준비 단계 완료, 밸브 몸체 분해 전",
        "nextStage": "구동모터 분해",
        "nextStepDetail": "밸브를 Full Close 상태로 놓고 구동모터 고정볼트를 분해하는 것입니다. 작업 전 전원 차단과 Red Tag 상태를 다시 확인하세요.",
        "checklist": ["전원 차단 확인", "Red Tag 확인", "배관 배수 확인", "Match Mark 표시", "공기구 준비", "작업구역 설정"],
        "prepIncomplete": ["Match Mark 표시", "보닛-바디 플랜지 간격 측정"],
        "assemblyMissing": ["배관 내부 세척 확인", "부품 표면 스크래치 확인"],
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
