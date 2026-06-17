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
import json, os, sys, sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# scripts/search_manuals.py 재사용
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import search_manuals as sm  # noqa: E402

PORT = 8090   # 8000(i3dweb_chatbot)/8077(ollama) 점유 회피
DB_PATH = "data/app.db"

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
        if self.path.split("?")[0] != "/api/rag/search":
            return self._json(404, {"error": "NOT_FOUND"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "BAD_JSON"})
        query = (req.get("query") or "").strip()
        if not query:
            return self._json(400, {"error": "EMPTY_QUERY"})
        valve = req.get("valveType")
        top_k = int(req.get("topK") or sm.TOP_K)
        min_score = float(req.get("minScore") if req.get("minScore") is not None else sm.MIN_SCORE)

        vecs, meta = _ensure_loaded()
        hits = sm.search(query, vecs, meta, valve_type=valve, top_k=top_k, min_score=min_score)
        return self._json(200, {
            "query": query, "valveType": valve,
            "hitCount": len(hits),
            "grounded": len(hits) > 0,
            "minScore": min_score,
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
