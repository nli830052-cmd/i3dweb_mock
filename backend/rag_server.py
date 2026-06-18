# -*- coding: utf-8 -*-
"""
매뉴얼 RAG 검색 API (의존성 최소: stdlib http.server + numpy + sentence-transformers).

- 시작 시 인덱스(data/manual_index.*) + bge-m3 로드
- 브라우저 mock(file://)에서 호출 가능하도록 CORS 허용(*)

endpoints:
  GET  /health
  POST /api/rag/search   body: {"query": "...", "valveType": "gate|globe", "topK": 5}
       → {"hits": [{score, id, valveType, doc, sectionNo, sectionPath, page, heading, text}]}

run (프로젝트 루트에서):  python backend/rag_server.py   # http://localhost:8000
"""
import json, os, sys, sqlite3, re, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# scripts/search_manuals.py 재사용
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import search_manuals as sm  # noqa: E402

PORT = 8090   # 8000(i3dweb_chatbot)/8077(ollama) 점유 회피
DB_PATH = "data/app.db"
OLLAMA_URL = "http://localhost:11434"   # 로컬 Ollama
LLM_MODEL = "qwen3:8b"                   # 답변 생성 LLM (Apache 2.0)

def _strip_crumb(text):
    return re.sub(r"^\[[^\]]*\]\n?", "", text)

def ollama_generate(prompt, num_predict=600):
    """로컬 Ollama로 답변 생성. <think> 블록은 제거."""
    body = json.dumps({
        "model": LLM_MODEL, "prompt": prompt, "stream": False, "think": False,
        "options": {"temperature": 0.2, "num_predict": num_predict}
    }).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL + "/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read().decode("utf-8"))
    text = data.get("response", "")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()

# ── action JSON 생성(plan) ──────────────────────────────
ALLOWED_ACTIONS = {
    "JUMP_TO", "SEARCH_EQUIPMENT", "ROTATE_VIEW", "HIDE_OBJECT", "SHOW_OBJECT",
    "ISOLATE_SYSTEM", "FILTER_BY_TYPE", "MOVE_TO_INSPECTION", "SHOW_PATH",
    "SHOW_INSPECTION_ROUTE", "FIND_NEAREST", "SHOW_WORKER_POSITION", "SHOW_WORK_ZONE",
    "QUERY_MAINTENANCE", "QUERY_CYCLE", "QUERY_SPATIAL", "QUERY_WORKFLOW", "MANUAL_RAG",
}

PLAN_PROMPT = (
    "당신은 i3DWEB 설비 정비 어시스턴트의 행동 계획기입니다.\n"
    "사용자 문장을 보고 아래 형식의 JSON만 출력하세요. 설명/주석 절대 금지.\n\n"
    '형식: {"responseType":"ACTION|ANSWER|ANSWER_WITH_ACTION","message":"한 줄","actions":[...]}\n\n'
    "가능한 action.type:\n"
    "[Viewer 조작]\n"
    '- JUMP_TO {"targetType":"TAG","targetValue":"<태그>"}  // 특정 태그로 이동\n'
    '- SEARCH_EQUIPMENT {"query":"<설비명/타입>"}  // 태그 모를 때 이름/타입 검색\n'
    '- ROTATE_VIEW {"params":{"direction":"back|left","angle":180}}\n'
    '- HIDE_OBJECT {"targetType":"TYPE|TAG","targetValue":"VALVE|PUMP|<태그>"}\n'
    '- SHOW_OBJECT {"targetType":"TYPE|TAG|ALL","targetValue":"..."}\n'
    '- ISOLATE_SYSTEM {"targetValue":"<계통명 또는 null>"}\n'
    '- FILTER_BY_TYPE {"targetValue":"PUMP|VALVE|MOTOR|BEARING|HEATEX|TANK"}\n'
    '- MOVE_TO_INSPECTION {"targetValue":"<태그 또는 null>"}\n'
    '- SHOW_PATH {"target":"<태그>|OPERATION_POS|EMERGENCY_EXIT"}\n'
    '- SHOW_INSPECTION_ROUTE {}\n'
    '- FIND_NEAREST {}\n'
    '- SHOW_WORKER_POSITION {"targetValue":"<태그 또는 null>"}\n'
    '- SHOW_WORK_ZONE {"targetValue":"<태그 또는 null>"}\n'
    "[데이터 조회 — 사실을 지어내지 말 것]\n"
    '- QUERY_MAINTENANCE {"targetValue":"<태그>","field":"history|last_overhaul|gasket|leak|recurring|result|open_point"}\n'
    '- QUERY_CYCLE {"targetValue":"<태그>","field":"overdue|next_due|parts|replace"}\n'
    '- QUERY_SPATIAL {"targetValue":"<태그>","field":"clearance|height|fall_hazard"}\n'
    '- QUERY_WORKFLOW {"targetValue":"<태그>","field":"current|next|checklist|prep_incomplete|assembly_missing"}\n'
    "[매뉴얼 문서]\n"
    '- MANUAL_RAG {"query":"<검색어>","valveType":"gate|globe|null"}\n\n'
    "규칙:\n"
    "- 태그(TG-PMP-101, GV-101A 등)가 문장에 있으면 SEARCH가 아니라 JUMP_TO 등 태그 기반 액션 우선.\n"
    "- 이력/주기/공간/작업단계 질문은 QUERY_*, 절차/방법/기준은 MANUAL_RAG.\n"
    "- 단순 인사/잡담은 actions:[] 로.\n"
    "- 문장에 태그가 없으면 현재 선택 태그를 targetValue로 사용. 현재 선택 태그: %s\n\n"
    "예시:\n"
    '"TG-PMP-101 확인할껀데 어디있는지 알려줘" -> {"responseType":"ACTION","message":"TG-PMP-101 위치로 이동합니다.","actions":[{"type":"JUMP_TO","targetType":"TAG","targetValue":"TG-PMP-101"}]}\n'
    '"펌프 찾아줘" -> {"responseType":"ACTION","message":"펌프를 검색합니다.","actions":[{"type":"SEARCH_EQUIPMENT","query":"펌프"}]}\n'
    '"이 밸브 정비 어디쯤?" -> {"responseType":"ANSWER","message":"작업 단계를 확인합니다.","actions":[{"type":"QUERY_WORKFLOW","targetValue":"GV-101A","field":"current"}]}\n'
    '"그랜드패킹 교체 절차 알려줘" -> {"responseType":"ANSWER","message":"매뉴얼을 확인합니다.","actions":[{"type":"MANUAL_RAG","query":"그랜드패킹 교체 절차","valveType":"globe"}]}\n/no_think\n\n'
    '문장: "%s"\n출력:'
)

def _extract_json(text):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e < 0:
        return None
    try:
        return json.loads(text[s:e + 1])
    except Exception:
        return None

def make_plan(message, current_tag):
    out = ollama_generate(PLAN_PROMPT % (current_tag or "없음", message), num_predict=320)
    obj = _extract_json(out)
    if not isinstance(obj, dict):
        return {"valid": False, "raw": out[:200]}
    rt = obj.get("responseType")
    acts = obj.get("actions")
    if rt not in ("ACTION", "ANSWER", "ANSWER_WITH_ACTION") or not isinstance(acts, list):
        return {"valid": False, "raw": out[:200]}
    for a in acts:
        if not isinstance(a, dict) or a.get("type") not in ALLOWED_ACTIONS:
            return {"valid": False, "raw": out[:200]}
    return {"valid": True, "responseType": rt, "message": obj.get("message", ""), "actions": acts, "model": LLM_MODEL}

def build_answer_prompt(query, hits):
    ctx = "\n\n".join(
        "- (%s · p.%s)\n%s" % (m["section_path"], m["page"], _strip_crumb(m["text"]))
        for _s, m in hits
    )
    return (
        "당신은 i3DWEB 설비 유지보수 어시스턴트입니다.\n"
        "아래 [매뉴얼 발췌]의 내용만 근거로 사용자 질문에 한국어로 간결하고 정확하게 답하세요.\n"
        "발췌에 없는 내용은 지어내지 말고 '지침서에서 확인되지 않습니다'라고 답하세요.\n"
        "추측하지 말고, 근거가 된 절차서 섹션을 한 줄로 함께 표기하세요.\n/no_think\n\n"
        "[매뉴얼 발췌]\n" + ctx + "\n\n[질문]\n" + query + "\n\n[답변]\n"
    )

def _db_rows(table):
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT * FROM %s" % table).fetchall()
    con.close()
    return [dict(r) for r in rows]

def _jl(s):
    try:
        return json.loads(s) if s else None
    except Exception:
        return None

def db_maintenance_all():
    out = {}
    for r in _db_rows("maintenance"):
        out[r["tag"]] = {
            "tag": r["tag"], "name": r["name"],
            "history": _jl(r["history"]), "lastOverhaul": _jl(r["last_overhaul"]),
            "bonnetGasket": _jl(r["bonnet_gasket"]), "leaks": _jl(r["leaks"]),
            "recurring": r["recurring"], "inspectionResult": r["inspection_result"],
            "openPoints": _jl(r["open_points"]), "priorityParts": _jl(r["priority_parts"]),
            "cycleMonths": r["cycle_months"], "lastMaintenance": r["last_maintenance"], "nextDue": r["next_due"],
        }
    return out

def db_spatial_all():
    out = {}
    for r in _db_rows("spatial"):
        out[r["tag"]] = {
            "clearance": {"front": r["clearance_front"], "right": r["clearance_right"]},
            "height": r["height"], "fallHazard": _jl(r["fall_hazard"]),
        }
    return out

def db_workflow_all():
    out = {}
    for r in _db_rows("workflow"):
        out[r["tag"]] = {
            "tag": r["tag"], "name": r["name"], "currentStage": r["current_stage"],
            "nextStage": r["next_stage"], "nextStepDetail": r["next_step_detail"],
            "checklist": _jl(r["checklist"]), "prepIncomplete": _jl(r["prep_incomplete"]),
            "assemblyMissing": _jl(r["assembly_missing"]),
        }
    return out

_DB_ALL = {
    "/api/db/maintenance/all": db_maintenance_all,
    "/api/db/spatial/all": db_spatial_all,
    "/api/db/workflow/all": db_workflow_all,
}
_VECS = None
_META = None

def _ensure_loaded():
    global _VECS, _META
    if _VECS is None:
        _VECS, _META = sm.load_index()
        sm._get_model()  # 모델 미리 로드 (첫 요청 지연 방지)
    return _VECS, _META

def _to_camel(score, m):
    return {
        "score": round(float(score), 4),
        "id": m["id"], "valveType": m["valve_type"], "doc": m["doc"],
        "sectionNo": m["section_no"], "sectionPath": m["section_path"],
        "page": m["page"], "heading": m["heading"], "text": m["text"],
    }

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            vecs, meta = _ensure_loaded()
            return self._json(200, {"ok": True, "chunks": len(meta), "model": sm.MODEL_NAME})
        if path in _DB_ALL:
            try:
                return self._json(200, _DB_ALL[path]())
            except Exception as e:
                return self._json(500, {"error": "DB_ERROR", "message": str(e)})
        return self._json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/api/rag/search", "/api/rag/answer", "/api/ai/plan"):
            return self._json(404, {"error": "NOT_FOUND"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "BAD_JSON"})
        query = (req.get("query") or "").strip()
        if not query:
            return self._json(400, {"error": "EMPTY_QUERY"})

        # action JSON 생성 (LLM) — 벡터검색 불필요
        if path == "/api/ai/plan":
            try:
                return self._json(200, make_plan(query, req.get("currentTag")))
            except Exception as e:
                return self._json(502, {"error": "LLM_UNAVAILABLE", "message": str(e)})
        valve = req.get("valveType")
        top_k = int(req.get("topK") or sm.TOP_K)
        min_score = float(req.get("minScore") if req.get("minScore") is not None else sm.MIN_SCORE)

        vecs, meta = _ensure_loaded()
        hits = sm.search(query, vecs, meta, valve_type=valve, top_k=top_k, min_score=min_score)

        if path == "/api/rag/search":
            return self._json(200, {
                "query": query, "valveType": valve,
                "hitCount": len(hits), "grounded": len(hits) > 0, "minScore": min_score,
                "hits": [_to_camel(s, m) for s, m in hits],
            })

        # /api/rag/answer : 검색 → LLM 종합
        if not hits:
            return self._json(200, {
                "query": query, "valveType": valve, "hitCount": 0, "grounded": False,
                "model": LLM_MODEL, "answer": "지침서에서 확인되지 않습니다.", "sources": [], "hits": [],
            })
        try:
            answer = ollama_generate(build_answer_prompt(query, hits))
        except Exception as e:
            return self._json(502, {"error": "LLM_UNAVAILABLE", "message": str(e),
                                    "hint": "ollama 실행 및 %s 모델 확인" % LLM_MODEL})
        return self._json(200, {
            "query": query, "valveType": valve, "hitCount": len(hits), "grounded": True,
            "model": LLM_MODEL, "answer": answer,
            "sources": [{"documentName": m["doc"], "section": m["section_path"], "page": m["page"]} for _s, m in hits],
            "hits": [_to_camel(s, m) for s, m in hits],
        })

    def log_message(self, fmt, *args):
        sys.stderr.write("[rag] " + (fmt % args) + "\n")

def main():
    print("RAG 인덱스/모델 로딩...")
    vecs, meta = _ensure_loaded()
    print("준비 완료: %d청크, 모델=%s" % (len(meta), sm.MODEL_NAME))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("RAG API: http://localhost:%d  (POST /api/rag/search, GET /health)" % PORT)
    srv.serve_forever()

if __name__ == "__main__":
    main()
