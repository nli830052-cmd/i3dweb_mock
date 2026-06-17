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

INTENTS = [
    "SEARCH", "JUMP", "ROTATE", "HIDE", "SHOW", "ISOLATE", "FILTER",
    "MOVE_INSP", "PATH", "ROUTE", "NEAREST", "WORKER", "ZONE",
    "MAINT_HISTORY", "MAINT_CYCLE", "WORK_CONDITION", "WORK_STAGE", "MANUAL", "GENERAL",
]

INTENT_PROMPT = (
    "당신은 i3DWEB 설비 정비 어시스턴트의 의도 분류기입니다.\n"
    "사용자 문장을 아래 intent 중 정확히 하나로 분류해 JSON만 출력하세요. 설명 금지.\n\n"
    "- SEARCH: 이름/타입으로 설비 검색 (펌프 찾아줘)\n"
    "- JUMP: 특정 태그 위치로 이동\n"
    "- ROTATE: 시점 회전(뒷면/측면)\n"
    "- HIDE: 객체 숨기기\n"
    "- SHOW: 숨긴 객체 다시 표시\n"
    "- ISOLATE: 특정 계통만 표시\n"
    "- FILTER: 특정 타입만 표시\n"
    "- MOVE_INSP: 점검 위치로 이동\n"
    "- PATH: 경로/비상 탈출 표시\n"
    "- ROUTE: 오늘 점검 순서 안내\n"
    "- NEAREST: 가장 가까운 점검 대상\n"
    "- WORKER: 점검자가 서는 위치\n"
    "- ZONE: 정비 작업 구역 표시\n"
    "- MAINT_HISTORY: 정비 이력/누설/가스켓/점검 결과/Open Point\n"
    "- MAINT_CYCLE: 정비 주기/다음 예정일/우선 부품/교체 판단\n"
    "- WORK_CONDITION: 작업 공간/높이/고소작업/추락 위험\n"
    "- WORK_STAGE: 현재 정비 진행 단계/다음 단계/체크리스트/누락 항목 (예: '지금 어디까지 했어', '정비 어디쯤')\n"
    "- MANUAL: 절차/방법/기준 등 매뉴얼 문서에서 찾을 질문\n"
    "- GENERAL: 위에 안 맞는 일반 질문\n\n"
    "출력: {\"intent\":\"WORK_STAGE\"}\n"
    "예) '이 밸브 지금 어디까지 했어?' -> {\"intent\":\"WORK_STAGE\"}\n"
    "예) '정비 어디쯤이야?' -> {\"intent\":\"WORK_STAGE\"}\n"
    "예) '펌프 찾아줘' -> {\"intent\":\"SEARCH\"}\n"
    "예) '그랜드패킹 교체 절차' -> {\"intent\":\"MANUAL\"}\n"
    "예) '정비 주기 지났어?' -> {\"intent\":\"MAINT_CYCLE\"}\n/no_think\n\n"
    "문장: \"%s\"\n출력:"
)

def classify_intent(message):
    out = ollama_generate(INTENT_PROMPT % message, num_predict=40)
    m = re.search(r'"intent"\s*:\s*"([A-Z_]+)"', out)
    intent = m.group(1) if m else None
    return intent if intent in INTENTS else "GENERAL"

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
        if path not in ("/api/rag/search", "/api/rag/answer", "/api/ai/route"):
            return self._json(404, {"error": "NOT_FOUND"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "BAD_JSON"})
        query = (req.get("query") or "").strip()
        if not query:
            return self._json(400, {"error": "EMPTY_QUERY"})

        # 의도 분류 (LLM) — 벡터검색 불필요
        if path == "/api/ai/route":
            try:
                intent = classify_intent(query)
            except Exception as e:
                return self._json(502, {"error": "LLM_UNAVAILABLE", "message": str(e)})
            return self._json(200, {"query": query, "intent": intent, "model": LLM_MODEL})
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
