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
import json, os, sys, sqlite3, re, urllib.request, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# scripts/search_manuals.py 재사용
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import search_manuals as sm  # noqa: E402

PORT = 8090   # 8000(i3dweb_chatbot)/8077(ollama) 점유 회피
# 실행 위치와 무관하게 repo 루트의 data/app.db 를 찾도록 절대경로 사용
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "app.db")
RAG_DOC = "(절차-표준-020) 범용 원심펌프 정비"   # 데이터 질문 근거로 인용할 보충본 doc(파일명)
OLLAMA_URL = "http://localhost:11434"   # 로컬 Ollama
LLM_MODEL = "qwen3.5:9b"                 # 답변 생성 LLM (Apache 2.0)

# ── LLM 백엔드 설정 (OpenAI API) ─────────────────────────
# repo 루트의 .env 파일(OPENAI_API_KEY=sk-...)에 키를 넣으면
# 모든 LLM 호출(plan/의도분류/답변종합)이 OpenAI API로 전환된다.
# 키가 비어 있으면 기존 로컬 Ollama(qwen3.5:9b)로 동작 — 폐쇄망 폴백.
def _load_dotenv():
    """repo 루트 .env → 환경변수 (이미 설정된 값은 유지, 의존성 없이 stdlib만)."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass

_load_dotenv()
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "").strip() or "gpt-4o-mini"
OPENAI_URL = "https://api.openai.com/v1"

def _llm_first():
    """OpenAI 키가 설정되어 있으면 True — 키워드 shortcut을 끄고 LLM-first로 동작."""
    return bool(OPENAI_API_KEY)

def _llm_model():
    return OPENAI_MODEL if _llm_first() else LLM_MODEL

def _llm_engine():
    return "OpenAI API" if _llm_first() else "Ollama (로컬)"

# ── 멀티턴 세션 (서버 보관형) ───────────────────────────
# 프론트(솔루션팀)는 sessionId만 보내고, 대화 이력은 이 서버가 누적·보관한다.
_SESSIONS = {}                 # sid -> {"turns": [{"user","assistant"}], "ts": epoch}
_SESS_LOCK = threading.Lock()  # ThreadingHTTPServer라 동시접근 보호
MAX_TURNS = 6                  # 프롬프트에 싣는 최근 턴 수
SESSION_TTL = 3600            # 미사용 1h 경과 시 만료

def _summarize_actions(actions):
    parts = []
    for a in actions or []:
        if not isinstance(a, dict):
            continue
        t = a.get("type") or ""
        v = a.get("targetValue") or a.get("query") or a.get("target") or ""
        parts.append(t + (":" + str(v) if v else ""))
    return ", ".join(parts)

def _prune_locked():
    now = time.time()
    for k in [k for k, v in _SESSIONS.items() if now - v["ts"] > SESSION_TTL]:
        _SESSIONS.pop(k, None)

def _get_history(sid):
    if not sid:
        return []
    with _SESS_LOCK:
        s = _SESSIONS.get(sid)
        if not s:
            return []
        if time.time() - s["ts"] > SESSION_TTL:
            _SESSIONS.pop(sid, None)
            return []
        return list(s["turns"])

def _append_history(sid, user_msg, plan):
    if not sid:
        return
    summary = plan.get("message", "") or ""
    acts = _summarize_actions(plan.get("actions"))
    if acts:
        summary = (summary + " (" + acts + ")").strip()
    with _SESS_LOCK:
        s = _SESSIONS.setdefault(sid, {"turns": [], "ts": time.time()})
        s["turns"].append({"user": user_msg, "assistant": summary})
        s["turns"] = s["turns"][-MAX_TURNS:]
        s["ts"] = time.time()
        _prune_locked()

def _format_history(history):
    lines = []
    for h in history:
        lines.append("사용자: " + h["user"])
        lines.append("어시스턴트: " + (h.get("assistant") or ""))
    return "\n".join(lines)

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

def openai_generate(prompt, num_predict=600):
    """OpenAI Chat Completions로 답변 생성. 기존 프롬프트를 그대로 user 메시지로 전달."""
    model = OPENAI_MODEL
    body = {"model": model,
            "messages": [{"role": "user", "content": prompt.replace("/no_think", "")}]}
    if re.match(r"^(gpt-5|o\d)", model):
        # reasoning 계열: temperature 미지원, 출력 한도에 추론 토큰 포함 → 여유 확보
        body["max_completion_tokens"] = max(num_predict * 4, 2000)
        body["reasoning_effort"] = "low"
    else:
        body["temperature"] = 0.2
        body["max_tokens"] = num_predict
    req = urllib.request.Request(OPENAI_URL + "/chat/completions",
                                 data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + OPENAI_API_KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    return ((data.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()

def llm_generate(prompt, num_predict=600):
    """LLM 호출 단일 진입점: OpenAI 키가 있으면 OpenAI, 없으면 로컬 Ollama."""
    if _llm_first():
        return openai_generate(prompt, num_predict)
    return ollama_generate(prompt, num_predict)

def openai_vision(prompt, image_data_url, num_predict=400):
    """이미지 포함 OpenAI 호출 (gpt-4o 계열 vision). Ollama 폴백 없음 — 호출 전 _llm_first() 확인."""
    body = {"model": OPENAI_MODEL,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url, "detail": "low"}}]}],
            "temperature": 0.2, "max_tokens": num_predict}
    req = urllib.request.Request(OPENAI_URL + "/chat/completions",
                                 data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + OPENAI_API_KEY})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode("utf-8"))
    return ((data.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()

# ── action JSON 생성(plan) ──────────────────────────────
# 뷰어 액션은 솔루션팀 인터페이스 명세(docs/AI 채팅 구현.xlsx) 기준.
# 켜기/끄기(ON/OFF)는 params.on(true/false)으로 표현하기로 협의됨.
ALLOWED_ACTIONS = {
    # [솔루션팀 뷰어 액션]
    "JUMP_TO", "TOP_VIEW", "FRONT_VIEW", "SIDE_VIEW", "ISO_VIEW", "HOME",
    "CLIP", "CLIP_AXIS", "CLIP_FLIP", "CLIP_SIZE",
    "SHOW_ONLY", "HIDE", "HIDE_ALL", "SHOW_ALL", "UNSELECT_ALL",
    "AVATAR", "KEY_MAP", "PID", "MONITORING", "SEARCH",
    # [mock 데모 확장 — 작업 위치/구역 안내 · 브리핑]
    "MOVE_TO_INSPECTION", "SHOW_PATH", "SHOW_INSPECTION_ROUTE", "FIND_NEAREST",
    "SHOW_WORKER_POSITION", "SHOW_WORK_ZONE", "BRIEFING",
    # [데이터/매뉴얼 — AI 내부 분류]
    "QUERY_MAINTENANCE", "QUERY_CYCLE", "QUERY_SPATIAL", "QUERY_WORKFLOW", "MANUAL_RAG",
}

PLAN_PROMPT = (
    "당신은 i3DWEB 설비 정비 어시스턴트의 행동 계획기입니다.\n"
    "사용자 문장을 보고 아래 형식의 JSON만 출력하세요. 설명/주석 절대 금지.\n\n"
    '형식: {"responseType":"ACTION|ANSWER|ANSWER_WITH_ACTION","message":"한 줄","actions":[...]}\n\n'
    "가능한 action.type:\n"
    "[카메라/시점]\n"
    '- JUMP_TO {"targetType":"TAG","targetValue":"<태그>"}  // 태그로 카메라 이동: "~로 가줘/이동/점프/고/어디?"\n'
    '- TOP_VIEW {"targetType":"TAG","targetValue":"<태그>"}  // 윗면/탑뷰: "~ 위 보여줘/윗면/탑"\n'
    '- FRONT_VIEW {"targetType":"TAG","targetValue":"<태그>"}  // 앞면/프론트\n'
    '- SIDE_VIEW {"targetType":"TAG","targetValue":"<태그>"}  // 옆면/사이드\n'
    '- ISO_VIEW {"targetType":"TAG","targetValue":"<태그>"}  // ISO/아이소 뷰\n'
    '- HOME {}  // 홈으로 카메라 이동: "홈/홈으로"\n'
    "[단면(클리핑)]\n"
    '- CLIP {"targetType":"TAG","targetValue":"<태그>","params":{"on":true|false}}  // 단면 보기: "잘라서 보여줘/단면/클리핑", 끌 때 on:false\n'
    '- CLIP_AXIS {"targetType":"","targetValue":"TB|LR|FB"}  // 단면 축 변경: 상하=TB 좌우=LR 전후=FB\n'
    '- CLIP_FLIP {}  // 단면 축 반전: "반전/축 반전"\n'
    '- CLIP_SIZE {"targetType":"NUMBER","targetValue":<숫자>}  // 단면 사이즈 조정: "(숫자) 줄여서/늘려서"\n'
    "[표시/숨김/선택]\n"
    '- SHOW_ONLY {"targetType":"TAG|TYPE","targetValue":"<태그|PUMP|VALVE|MOTOR|BEARING|HEATEX|TANK>"}  // 그것만 표시: "~만 보여줘/~빼고 다 지워줘"\n'
    '- HIDE {"targetType":"TAG|TYPE","targetValue":"<태그|타입>"}  // 숨김: "숨겨줘/꺼줘/가려줘/하이드"\n'
    '- HIDE_ALL {}  // 전체 모델 숨기기\n'
    '- SHOW_ALL {}  // 전체 표시/숨김 해제: "다 보여줘/숨긴 거 복구/쇼 올"\n'
    '- UNSELECT_ALL {}  // 선택 해제: "선택 없애줘/아무것도 선택하지 마"\n'
    "[화면 요소]\n"
    '- AVATAR {"params":{"on":true|false}}  // 아바타/사람/캐릭터 켜기·끄기\n'
    '- KEY_MAP {"params":{"on":true|false}}  // 키맵/지도 켜기·끄기\n'
    "[연계 화면]\n"
    '- PID {"targetType":"TAG","targetValue":"<태그>","params":{"on":true|false}}  // 연계 P&ID 도면 표시/닫기\n'
    '- MONITORING {"targetType":"TAG","targetValue":"<태그>","params":{"on":true|false}}  // 실시간 모니터링 화면: "모니터링/실시간 정보 보여줘"\n'
    '- SEARCH {"targetType":"STRING","targetValue":"<문자열>"}  // 문자열 포함 모델 검색: "~ 들어간 모델 목록/~ 검색/~ 찾아줘"\n'
    "[작업 안내 — 확장]\n"
    '- MOVE_TO_INSPECTION {"targetValue":"<태그 또는 null>"}\n'
    '- SHOW_PATH {"target":"<태그>|OPERATION_POS|EMERGENCY_EXIT"}\n'
    '- SHOW_INSPECTION_ROUTE {}\n'
    '- FIND_NEAREST {}\n'
    '- SHOW_WORKER_POSITION {"targetValue":"<태그 또는 null>"}\n'
    '- SHOW_WORK_ZONE {"targetValue":"<태그 또는 null>"}\n'
    '- BRIEFING {}  // 오늘 점검 브리핑(종합): "오늘 점검할 거/점검할 구역/오늘 할 일/점검 대상 알려줘", "브리핑 해줘" — 오늘 무엇을 점검해야 하는지 묻는 질문은 전부 이것 (이동 순서·동선만 물으면 SHOW_INSPECTION_ROUTE, 특정 설비의 작업 구역 표시만 원하면 SHOW_WORK_ZONE)\n'
    "[데이터 조회 — 사실을 지어내지 말 것]\n"
    '- QUERY_MAINTENANCE {"targetValue":"<태그>","field":"history|last_overhaul|gasket|leak|recurring|result|open_point"}\n'
    '- QUERY_CYCLE {"targetValue":"<태그>","field":"overdue|next_due|parts|replace"}\n'
    '- QUERY_SPATIAL {"targetValue":"<태그>","field":"clearance|height|fall_hazard"}\n'
    '- QUERY_WORKFLOW {"targetValue":"<태그>","field":"current|next|checklist|prep_incomplete|assembly_missing"}\n'
    "[매뉴얼 문서]\n"
    '- MANUAL_RAG {"query":"<검색어>","valveType":"gate|globe|pump|null"}\n\n'
    "규칙:\n"
    "- 태그(TG-PMP-101, GV-101A 등)가 문장에 있으면 SEARCH가 아니라 JUMP_TO 등 태그 기반 액션 우선.\n"
    "- 켜기/끄기가 있는 액션(CLIP/PID/MONITORING/AVATAR/KEY_MAP)은 반드시 params.on에 true/false로 표현하라. ('꺼줘/닫아줘/오프' = false)\n"
    "- [중요] 'X 빼고 다 지워/없애/숨겨/꺼줘', 'X만 보여/남겨줘'는 SHOW_ONLY(X)다. 이때 X는 화면에 '남길' 대상이다. "
    "절대 HIDE(X)로 출력하지 마라 — HIDE(X)는 X 자체를 숨기라는 정반대 뜻이 된다. HIDE는 'X를 숨겨/꺼/지워줘'처럼 X가 숨길 대상일 때만.\n"
    "- 이력/주기/공간/작업단계 질문은 QUERY_*, 절차/방법/기준은 MANUAL_RAG.\n"
    "- '설명해줘/무슨 뜻/무엇인가/의미가 뭐야'는 지식 설명 질문이다. 모델을 검색하거나 찾아달라는 명시적 표현이 없으면 절대 SEARCH로 분류하지 말고 ANSWER 또는 MANUAL_RAG로 처리하라.\n"
    "- 단순 인사/잡담은 actions:[] 로.\n"
    "- 이전 대화가 있으면 '그거/거기/그럼/다음/그 밸브' 같은 표현을 그 맥락으로 해석하고, query/targetValue는 맥락을 반영해 완성형으로 채워라.\n"
    "- 문장에 태그가 명시되어 있지 않다면 반드시 현재 선택 태그를 targetValue로 사용하라.\n"
    "- 단, 현재 선택 태그가 '없음'인 경우 절대 임의의 태그(예: 예시의 TG-PMP-101)를 지어내지 말고, 태그 파악이 불가함을 알리는 검색(SEARCH)이나 MANUAL_RAG로 처리하거나 targetValue를 비워둬라. 현재 선택 태그: %s\n\n"
    "예시:\n"
    '"TG-PMP-101 확인할껀데 어디있는지 알려줘" -> {"responseType":"ACTION","message":"TG-PMP-101 위치로 이동합니다.","actions":[{"type":"JUMP_TO","targetType":"TAG","targetValue":"TG-PMP-101"}]}\n'
    '"펌프 찾아줘" -> {"responseType":"ACTION","message":"펌프를 검색합니다.","actions":[{"type":"SEARCH","targetType":"STRING","targetValue":"펌프"}]}\n'
    '"윗면 보여줘" -> {"responseType":"ACTION","message":"TG-PMP-101 탑뷰로 전환합니다.","actions":[{"type":"TOP_VIEW","targetType":"TAG","targetValue":"TG-PMP-101"}]}\n'
    '"잘라서 보여줘" -> {"responseType":"ACTION","message":"TG-PMP-101 단면을 표시합니다.","actions":[{"type":"CLIP","targetType":"TAG","targetValue":"TG-PMP-101","params":{"on":true}}]}\n'
    '"단면 꺼줘" -> {"responseType":"ACTION","message":"단면 보기를 종료합니다.","actions":[{"type":"CLIP","targetType":"TAG","targetValue":"TG-PMP-101","params":{"on":false}}]}\n'
    '"TG-PMP-101 빼고 다 없애줘" -> {"responseType":"ACTION","message":"TG-PMP-101만 남기고 나머지를 숨깁니다.","actions":[{"type":"SHOW_ONLY","targetType":"TAG","targetValue":"TG-PMP-101"}]}\n'
    '"TG-PMP-101 없애줘" -> {"responseType":"ACTION","message":"TG-PMP-101를 숨깁니다.","actions":[{"type":"HIDE","targetType":"TAG","targetValue":"TG-PMP-101"}]}\n'
    '"이 펌프 P&ID 도면 보여줘" -> {"responseType":"ACTION","message":"TG-PMP-101 연관 P&ID 도면을 표시합니다.","actions":[{"type":"PID","targetType":"TAG","targetValue":"TG-PMP-101","params":{"on":true}}]}\n'
    '"오늘 점검할 거 알려줘" -> {"responseType":"ACTION","message":"오늘 점검 브리핑을 시작합니다.","actions":[{"type":"BRIEFING"}]}\n'
    '"이 펌프 정비 어디쯤?" -> {"responseType":"ANSWER","message":"작업 단계를 확인합니다.","actions":[{"type":"QUERY_WORKFLOW","targetValue":"TG-PMP-101","field":"current"}]}\n'
    '"그랜드패킹 교체 절차 알려줘" -> {"responseType":"ANSWER","message":"매뉴얼을 확인합니다.","actions":[{"type":"MANUAL_RAG","query":"그랜드패킹 교체 절차","valveType":"pump"}]}\n'
    '"FME가 무엇인지 설명해줘" -> {"responseType":"ANSWER","message":"FME는 Foreign Material Exclusion의 약자로 이물질 유입 방지 활동을 의미합니다.","actions":[]}\n'
    '"TG-PMP-101 정비 이력 알려주고 위치도 보여줘" -> {"responseType":"ANSWER_WITH_ACTION","message":"정비 이력을 조회하고 해당 위치로 이동합니다.","actions":[{"type":"QUERY_MAINTENANCE","targetValue":"TG-PMP-101","field":"history"},{"type":"JUMP_TO","targetType":"TAG","targetValue":"TG-PMP-101"}]}\n'
    '"작업 공간 충분한지 보여주면서 알려줘" -> {"responseType":"ANSWER_WITH_ACTION","message":"작업 공간을 확인하고 작업 구역을 표시합니다.","actions":[{"type":"QUERY_SPATIAL","targetValue":"TG-PMP-101","field":"clearance"},{"type":"SHOW_WORK_ZONE","targetValue":"TG-PMP-101"}]}\n/no_think\n\n'
)

def _extract_json(text):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e < 0:
        return None
    try:
        return json.loads(text[s:e + 1])
    except Exception:
        return None

def make_plan(message, current_tag, history=None):
    current_tag = current_tag or "TG-PMP-101"
    # 키워드 shortcut은 로컬 LLM(느림·부정확) 보조용 — OpenAI 모드에서는 LLM이 직접 판단
    if not _llm_first() and any(k in message for k in ["이동", "움직", "가줘", "가자", "안내", "위치", "보여", "데려"]):
        raw = re.sub(r"[가-힣ㄱ-ㅎㅏ-ㅣ]+", "", message)
        if raw and raw.strip():
            return {
                "valid": True,
                "responseType": "ACTION",
                "message": "%s 위치를 찾았습니다. 현재 화면을 해당 설비 위치로 이동하고 강조 표시합니다." % raw.strip(),
                "actions": [{
                    "params": {},
                    "type": "JUMP_TO",
                    "targetType": "TAG",
                    "targetValue": raw.strip()
                }],
                "model": _llm_model(), "engine": _llm_engine()
            }
    prompt = PLAN_PROMPT % current_tag
    if history:
        prompt += ("[이전 대화] (오래된→최근, '그거/거기/다음' 같은 후속·대명사 해석에 활용)\n"
                   + _format_history(history) + "\n\n")
    prompt += '문장: "' + message + '"\n출력:'
    out = llm_generate(prompt, num_predict=320)
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
    return {"valid": True, "responseType": rt, "message": obj.get("message", ""), "actions": acts,
            "model": _llm_model(), "engine": _llm_engine()}

DEMO_INTENT_PROMPT = (
    "당신은 원심펌프 정비 질문의 의도 분류기입니다. 사용자 표현이 예시와 달라도 의미와 문맥으로 판단하세요.\n"
    "아래 intent 중 하나를 선택해 JSON 한 개만 출력하세요. 설명 금지.\n\n"
    "- PUMP_CLEANING_FME: 세척제 사용 기준·금지 세척제·TCE, 공구·공기구·도구 낙하방지, 이물질 유입방지(FME) 질문\n"
    "- PUMP_FME_EXPLANATION: FME의 뜻·의미·정의나 현장 적용을 설명해 달라는 질문. 이전 답변에 FME가 나온 뒤 '그게 뭐야/설명해줘'라고 묻는 후속 질문도 포함\n"
    "- PUMP_LIFTING_TEST: 펌프 인양, 와이어·아이볼트 위치, 정비 후 수압시험 질문\n"
    "- PUMP_REASSEMBLY_PARTS: 펌프 재조립 시 신품 교체 소모품, 오링·가스켓·패킹·오일씰 질문\n"
    "- GENERAL: 위 세 의도에 해당하지 않는 모든 질문\n\n"
    '형식: {"intent":"PUMP_CLEANING_FME|PUMP_FME_EXPLANATION|PUMP_LIFTING_TEST|PUMP_REASSEMBLY_PARTS|GENERAL","confidence":0.0}\n'
    "/no_think\n\n%s질문: %s\n출력:"
)

def classify_demo_intent(message, history=None):
    history_text = ""
    if history:
        history_text = "[이전 대화]\n" + _format_history(history) + "\n\n"
    out = llm_generate(DEMO_INTENT_PROMPT % (history_text, json.dumps(message, ensure_ascii=False)), num_predict=100)
    obj = _extract_json(out)
    allowed = {"PUMP_CLEANING_FME", "PUMP_FME_EXPLANATION", "PUMP_LIFTING_TEST", "PUMP_REASSEMBLY_PARTS", "GENERAL"}
    intent = obj.get("intent") if isinstance(obj, dict) else None
    if intent not in allowed:
        intent = "GENERAL"
    try:
        confidence = float(obj.get("confidence", 0.0)) if isinstance(obj, dict) else 0.0
    except Exception:
        confidence = 0.0
    return {"intent": intent, "confidence": confidence, "model": _llm_model(), "engine": _llm_engine()}

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

# ══════════════════════════════════════════════════════════════════
#  /api/ai/chat — LLM + RAG + DB 통합 답변 (5단 구조)
#  질문 분류 → DB 사실 조회 + 매뉴얼 RAG 검색 → LLM 종합(폴백: 템플릿)
#  반환: { category, headline, answer, recommendation, data, sources,
#          manualExcerpt, retrieval, generation }
# ══════════════════════════════════════════════════════════════════
import calendar
from datetime import date

def _any(text, words):
    return any(w in text for w in words)

def classify_question(message, tag):
    """질문 → (category, sub, manualQuery, valveType). classifier.js 트리거와 정렬."""
    t = message or ""
    low = t.lower()
    # ── [RAG-우선 라우터] 절차·조치·기준·방법을 '어떻게' 묻는 질문은
    #    특정 설비의 사실(DB)이 아니라 매뉴얼 일반 지식이다 → 매뉴얼 RAG(전문 검색).
    #    단, 특정 설비의 '이력/수치/판단'(언제 누설났나, 주기 초과?, 교체해야?)은
    #    아래 데이터 분기로 내려보낸다 — DATA_FACT 신호가 있으면 게이트를 통과시키지 않는다.
    PROC_WORDS = ["조치", "방안", "대처", "복구", "어떻게", "방법", "절차", "기준",
                  "토크", "보수", "예방", "해결"]
    DATA_FACT_WORDS = [
        # maintenance — 이 설비의 실제 이력/사실
        "이력", "기록", "마지막", "언제", "몇 번", "몇번", "난 적", "있었", "지난", "발생했",
        "가스켓", "반복", "고장", "점검 결과", "정상이", "미조치", "오픈포인트", "open point",
        # cycle — 이 설비의 주기/판단
        "주기", "초과", "예정일", "다음 정비", "교체해야", "교체 검토", "할까", "필요한", "부품",
        # spatial — 이 설비의 공간 측정값
        "공간", "간섭", "사다리", "발판", "고소작업", "추락", "개구부", "높이", "2m",
        # workflow — 이 설비의 작업오더 진행 상태
        "단계", "체크리스트", "다음 작업", "준비사항", "점검사항", "누락", "미완료",
    ]
    if _any(t, PROC_WORDS) and not _any(low, DATA_FACT_WORDS):
        return "manual", "rag", message, "pump"
    # 1) 공간/안전 (Walkinside)
    if _any(t, ["작업 공간", "공간 충분", "공간이", "간섭", "사다리", "작업 발판", "작업발판", "발판", "고소작업", "추락", "개구부", "2m 이상"]):
        if _any(t, ["추락", "개구부"]):
            return "spatial", "fall", "개구부 추락 위험 안전조치 안전난간", "pump"
        if _any(t, ["발판", "고소작업", "2m 이상", "사다리"]):
            return "spatial", "height", "고소작업 2m 작업발판 안전대 안전조치", "pump"
        return "spatial", "clearance", "작업 공간 작업 반경 적정성 간섭", "pump"
    # 2) 작업 단계 (WO)
    if _any(t, ["단계", "체크리스트", "다음 작업", "준비사항", "점검사항", "누락", "미완료", "완료 안"]):
        if "체크리스트" in t:
            return "workflow", "checklist", "분해 전 준비 체크리스트 Match Mark", "pump"
        if "누락" in t:
            return "workflow", "missing", "조립 전 점검 배관 내부 세척", "pump"
        if "준비" in t and _any(t, ["완료 안", "미완료", "안 된"]):
            return "workflow", "prep", "분해 전 준비 Match Mark 플랜지 간격", "pump"
        if "다음" in t:
            return "workflow", "next", "구동모터 분해 Full Close 단계", "pump"
        return "workflow", "current", "정비 6단계 표준 절차 현재 단계", "pump"
    # 3) 교체/정비 주기 (CMMS)
    if _any(t, ["주기", "예정일", "다음 정비", "부품"]) or ("교체" in t and _any(t, ["해야", "할까", "검토", "필요"])):
        if "부품" in t:
            return "cycle", "parts", "분해 시 우선 점검 순서 부품", "pump"
        if "교체" in t:
            return "cycle", "replace", "그랜드패킹 교체 판단 기준 분해 후 실측", "pump"
        if _any(t, ["예정일", "다음 정비"]):
            return "cycle", "nextdue", "특별점검 착수 기준 우선 점검", "pump"
        return "cycle", "overdue", "정비주기 등급별 12개월 만료", "pump"
    # 4) 정비 이력/상태 (CMMS)
    if _any(t, ["이력", "분해 정비", "분해정비", "가스켓", "누설", "고장 유형", "반복", "점검 결과", "정상이", "미조치", "오픈포인트"]) or "open point" in low or "openpoint" in low:
        if "가스켓" in t:
            return "maintenance", "gasket", "보닛 가스켓 재사용 금지 교체", "pump"
        if _any(t, ["반복", "고장"]):
            return "maintenance", "recurring", "반복 고장 분류 12개월 2회 우선 점검", "pump"
        if _any(t, ["점검 결과", "정상이"]):
            return "maintenance", "result", "분해 후 점검 판정 등급 조건부 정상", "pump"
        if "open point" in low or "openpoint" in low or _any(t, ["미조치", "오픈포인트"]):
            return "maintenance", "openpoint", "Open Point 미조치 관리 기준", "pump"
        if "누설" in t:
            # 그랜드패킹 외 부위(시트/디스크/플랜지/보닛/Pressure Seal)의 '조치/방법'을 물으면
            # 설비 누설 이력(DB)이 아니라 매뉴얼 14.2 부위별 조치 기준 → 매뉴얼 RAG
            _parts = ["시트", "디스크", "플랜지", "보닛", "pressure seal", "프레셔 씰", "프레셔씰"]
            _acts = ["조치", "방안", "방법", "어떻게", "기준", "대처", "복구", "해결"]
            if _any(low, _parts) and _any(t, _acts):
                return "manual", "rag", message, "pump"
            return "maintenance", "leak", "그랜드패킹부 누설 조치", "pump"
        if _any(t, ["분해", "마지막"]):
            return "maintenance", "overhaul", "스템 점검 디스크 시트 Blue Check", "pump"
        return "maintenance", "history", "정비기록 작성 항목", "pump"
    # 5) 매뉴얼/절차
    if _any(t, ["절차", "방법", "어떻게", "교체 기준", "보수 기준", "점검 기준", "토크", "예비품", "특별점검", "매뉴얼", "지침", "조치 기준", "이상징후"]):
        return "manual", "rag", message, "pump"
    return "manual", "rag", message, "pump"

# ══════════════════════════════════════════════════════════════════
#  [Phase 1] 키워드+LLM 하이브리드 의도분류
#  - 키워드(classify_question)가 데이터 카테고리에 못 걸린 패러프레이즈를
#    LLM(qwen3)이 택소노미로 분류 → 리치 5단 경로(make_chat)로 수렴.
#  - 데모 안정성: 키워드 빠른길은 그대로, LLM은 "키워드 미스"에만 호출.
# ══════════════════════════════════════════════════════════════════
CATEGORY_SUBS = {
    "maintenance": ["history", "overhaul", "gasket", "leak", "recurring", "result", "openpoint"],
    "cycle":       ["overdue", "nextdue", "parts", "replace"],
    "spatial":     ["clearance", "height", "fall"],
    "workflow":    ["current", "next", "checklist", "prep", "missing"],
    "manual":      ["rag"],
}

# (category, sub) → 매뉴얼 벡터검색어 (classify_question의 값과 동일하게 유지)
SUB_MANUAL_QUERY = {
    ("spatial", "clearance"): "작업 공간 작업 반경 적정성 간섭",
    ("spatial", "height"):    "고소작업 2m 작업발판 안전대 안전조치",
    ("spatial", "fall"):      "개구부 추락 위험 안전조치 안전난간",
    ("cycle", "overdue"):     "정비주기 등급별 12개월 만료",
    ("cycle", "nextdue"):     "특별점검 착수 기준 우선 점검",
    ("cycle", "parts"):       "분해 시 우선 점검 순서 부품",
    ("cycle", "replace"):     "그랜드패킹 교체 판단 기준 분해 후 실측",
    ("maintenance", "result"):    "분해 후 점검 판정 등급 조건부 정상",
    ("maintenance", "openpoint"): "Open Point 미조치 관리 기준",
    ("maintenance", "recurring"): "반복 고장 분류 12개월 2회 우선 점검",
    ("maintenance", "gasket"):    "보닛 가스켓 재사용 금지 교체",
    ("maintenance", "leak"):      "그랜드패킹부 누설 조치",
    ("maintenance", "overhaul"):  "스템 점검 디스크 시트 Blue Check",
    ("maintenance", "history"):   "정비기록 작성 항목",
}

MANUAL_SIGNALS = ["절차", "방법", "어떻게", "교체 기준", "보수 기준", "점검 기준",
                  "토크", "예비품", "특별점검", "매뉴얼", "지침", "조치 기준", "이상징후"]
INTENT_CONF_MIN = 0.6

INTENT_PROMPT = (
    "당신은 설비 정비 어시스턴트의 의도 분류기입니다.\n"
    "사용자 문장을 아래 택소노미 중 하나로 분류해 JSON만 출력하세요. 설명 금지.\n\n"
    '형식: {"category":"...","sub":"...","tag":"<태그 또는 null>",'
    '"valveType":"gate|globe|null","confidence":0.0~1.0}\n\n'
    "category·sub 목록:\n"
    "- maintenance: history(이력) overhaul(마지막분해정비) gasket(가스켓) leak(누설) "
    "recurring(반복고장) result(점검결과) openpoint(미조치)\n"
    "- cycle: overdue(주기초과) nextdue(다음예정일) parts(우선부품) replace(부품교체판단)\n"
    "- spatial: clearance(작업공간) height(고소작업/발판) fall(추락/개구부)\n"
    "- workflow: current(현재단계) next(다음단계) checklist(체크리스트) prep(준비미완료) missing(조립누락)\n"
    "- manual: rag(절차/방법/기준 등 매뉴얼 일반)\n\n"
    "규칙:\n"
    "- '교체해야/교체 검토' 같은 미래 판단은 cycle.replace, '교체 이력' 같은 과거 사실은 maintenance.gasket.\n"
    "- '높은 곳/사다리/올라가서' 처럼 표현이 달라도 의미가 고소작업이면 spatial.height.\n"
    "- 문장에 태그 없으면 현재 선택 태그 사용. 현재 선택 태그: %s\n"
    "- 의미가 모호하면 confidence를 0.5 이하로.\n/no_think\n\n"
    '문장: "%s"\n출력:'
)

def classify_intent_llm(message, tag, history=None):
    """LLM 의도분류 → {category, sub, tag, valveType, confidence} 또는 None."""
    out = llm_generate(INTENT_PROMPT % (tag or "없음", message), num_predict=120)
    obj = _extract_json(out)
    if not isinstance(obj, dict):
        return None
    cat, sub = obj.get("category"), obj.get("sub")
    if cat not in CATEGORY_SUBS or sub not in CATEGORY_SUBS[cat]:
        return None                      # 택소노미 밖 → 폐기(환각 방지)
    try:
        obj["confidence"] = float(obj.get("confidence", 0))
    except Exception:
        obj["confidence"] = 0.0
    return obj

def resolve_intent(message, tag, history=None):
    """(category, sub, manual_query, valveType, via, confidence).
    [OpenAI 모드] LLM 분류 우선 → 미확신 시 키워드 폴백.
    [Ollama 모드] 1) 키워드 빠른길 → 2) 키워드 미스면 LLM 분류 → 3) 저신뢰면 되묻기 신호."""
    cat, sub, mq, valve = classify_question(message, tag)   # 키워드 분류 (폴백 겸용)

    if _llm_first():                                        # LLM-first: 패러프레이즈까지 커버
        try:
            llm = classify_intent_llm(message, tag, history)
        except Exception:
            llm = None
        if llm and llm["confidence"] >= INTENT_CONF_MIN:
            c, s = llm["category"], llm["sub"]
            mq2 = SUB_MANUAL_QUERY.get((c, s), message)
            return c, s, mq2, (llm.get("valveType") or "pump"), "llm", llm["confidence"]
        return cat, sub, mq, valve, "keyword", 1.0          # LLM 미확신/실패 → 키워드 결과

    if cat != "manual":
        return cat, sub, mq, valve, "keyword", 1.0          # 데이터 카테고리 확정
    if _any(message, MANUAL_SIGNALS):
        return cat, sub, mq, valve, "keyword", 1.0          # 진짜 매뉴얼 신호

    try:                                                    # 2) 패러프레이즈 구제
        llm = classify_intent_llm(message, tag, history)
    except Exception:
        llm = None
    if llm and llm["confidence"] >= INTENT_CONF_MIN:
        c, s = llm["category"], llm["sub"]
        mq2 = SUB_MANUAL_QUERY.get((c, s), message)
        return c, s, mq2, (llm.get("valveType") or "pump"), "llm", llm["confidence"]
    if llm:                                                 # 3) 저신뢰 → 되묻기
        return llm["category"], llm["sub"], mq, valve, "low_conf", llm["confidence"]
    return "manual", "rag", message, "pump", "fallback", 0.0

def _overdue(last_iso, months):
    """(초과일수, 만료일ISO). 미래면 초과일수 음수."""
    try:
        y, m, d = map(int, last_iso.split("-"))
    except Exception:
        return None, None
    idx = (m - 1) + months
    ey, em = y + idx // 12, idx % 12 + 1
    ed = min(d, calendar.monthrange(ey, em)[1])
    due = date(ey, em, ed)
    return (date.today() - due).days, due.isoformat()

CHAT_SOURCE = {
    "maintenance": "CMMS·정비이력 DB", "cycle": "CMMS·정비주기 DB",
    "spatial": "Walkinside 공간 데이터", "workflow": "작업오더(WO) 워크플로",
    "manual": "유지보수 매뉴얼 벡터검색 (bge-m3)",
}

def chat_db_facts(category, tag):
    """category별 DB 사실 조회 → (retrieval.data, 원본 rec)."""
    if category in ("maintenance", "cycle"):
        rec = db_maintenance_all().get(tag)
        if not rec:
            return None, None
        if category == "cycle":
            return {k: rec[k] for k in ("cycleMonths", "lastMaintenance", "nextDue", "priorityParts")}, rec
        return rec, rec
    if category == "spatial":
        rec = db_spatial_all().get(tag)
        return rec, rec
    if category == "workflow":
        rec = db_workflow_all().get(tag)
        return rec, rec
    return None, None

def chat_template(category, sub, tag, rec):
    """LLM 미가동 시 결정적 폴백: (headline, answer, recommendation). DB 사실 기반."""
    nm = (rec or {}).get("name", "")
    if category == "maintenance":
        if sub == "result":
            return ("최근 점검 결과: %s" % (rec.get("inspectionResult", "").split("—")[0].strip() or "조건부 정상"),
                    "%s의 최근 점검 결과는 %s 입니다. 즉시 운전 정지 수준은 아니지만 동일 부위 누설이 반복되어 정비 우선순위가 높습니다." % (tag, rec.get("inspectionResult", "")),
                    "다음 정비 시 그랜드패킹부를 최우선으로 재점검하세요.")
        if sub == "openpoint":
            ops = rec.get("openPoints") or []
            if ops:
                o = ops[0]
                return ("Open Point %d건 등록 (%s)" % (len(ops), o.get("status", "진행 중")),
                        "%s에는 Open Point %s(%s)가 등록되어 있습니다. 발생 %s, 조치 예정일 %s, 담당 %s, 연계 작업오더 %s." % (
                            tag, o.get("id", ""), o.get("desc", ""), o.get("wo", ""), o.get("due", ""), o.get("dept", ""), o.get("linkedWo", "")),
                        "연계 작업오더에서 그랜드패킹·스터핑박스·스템 접촉부를 확인해 Open Point를 종결하세요.")
            return ("등록된 Open Point 없음", "%s에 등록된 미조치(Open Point) 사항은 없습니다." % tag, "")
        if sub == "recurring":
            return ("반복 고장: %s" % rec.get("recurring", "").split("(")[0].strip(),
                    "단순히 그랜드 팔로워를 다시 조이는 임시 조치보다, 이번 분해정비에서 패킹 상태·주축 휨·스터핑박스 내면을 함께 확인하는 것이 중요합니다.",
                    "WO-2026-0612에서 그랜드패킹부를 우선 점검하고, 경화·마모·고착·접촉면 손상이 확인되면 신품 교체를 권장합니다.")
        if sub == "overhaul":
            lo = rec.get("lastOverhaul") or {}
            return ("마지막 분해정비 %s" % lo.get("date", ""),
                    "%s의 마지막 분해정비는 %s(%s)이며, %s 수행 후 '%s' 판정을 받았습니다." % (
                        tag, lo.get("date", ""), lo.get("wo", ""), lo.get("detail", ""), lo.get("result", "정상")), "")
        if sub == "gasket":
            bg = rec.get("bonnetGasket") or []
            return ("케이싱 가스켓 교체 %d회" % len(bg),
                    ("케이싱 가스켓 교체는 %s %d회 확인됩니다. 매뉴얼상 케이싱 가스켓은 재사용 금지로 분해정비 때마다 신품 교체 대상입니다." % (
                        ", ".join(g.get("date", "") for g in bg), len(bg))) if bg else "케이싱 가스켓 교체 이력은 확인되지 않습니다.", "")
        if sub == "leak":
            lk = rec.get("leaks") or []
            return ("누설 이력 %d건" % len(lk),
                    "과거 누설은 그랜드패킹부에서 발생했고, 이후 동일 부위에서 미세 비침이 재확인되어 반복 이상 징후로 관리됩니다." if lk else "과거 누설 이력은 확인되지 않습니다.", "")
        hist = rec.get("history") or []
        return ("%s(%s)의 최근 정비이력을 확인했습니다." % (tag, nm or "설비"),
                "최근 1년 내 그랜드패킹부 누설·재점검이 반복 확인되어, 단순 정상 설비가 아니라 관찰이 필요한 조건부 관리 대상으로 보는 것이 적절합니다.",
                "다음 정비 시 그랜드패킹부를 최우선으로 확인하세요.")
    if category == "cycle":
        last = rec.get("lastMaintenance"); cyc = rec.get("cycleMonths")
        if sub == "overdue":
            od, due = _overdue(last, cyc)
            nd = rec.get("nextDue")
            # 다음 예정일이 주기 만료일과 다르면(예: 누설 후속 점검으로 별도 설정) 혼동 방지 문구 추가
            note = (" 참고로 '다음 점검 예정일' %s은 누설 후속 점검(Open Point)일로, 주기 초과 판정 기준이 아닙니다." % nd) if (nd and nd != due) else ""
            if od is not None and od > 0:
                return ("정비 주기 초과 (약 %d일)" % od,
                        "마지막 분해정비 %s + 주기 %d개월 → 만료 %s. 오늘 기준 약 %d일 초과된 점검 대상입니다.%s" % (last, cyc, due, od, note),
                        "최근 누설 이력까지 고려해 우선순위를 높게 두고 분해정비로 주기 초과와 Open Point를 함께 해소하세요.")
            return ("정비 주기 도래 전", "마지막 분해정비 %s + 주기 %d개월 → 만료 %s. 아직 주기 도래 전입니다.%s" % (last, cyc, due, note), "")
        if sub == "nextdue":
            return ("다음 정비 예정 %s" % rec.get("nextDue", ""),
                    "최근 누설 이력으로 우선 점검 대상으로 분류되어, 일반 주기보다 앞당겨 분해정비가 진행/예정 중입니다. 연계 조치 예정일은 %s 입니다." % rec.get("nextDue", ""), "")
        if sub == "parts":
            return ("우선 점검 부품", "최근 누설 부위인 그랜드패킹부를 가장 먼저 확인하는 것이 좋습니다.", "")
        # replace
        return ("그랜드패킹 교체 검토 대상",
                "반복 누설 이력으로 그랜드패킹은 교체 검토 대상입니다. 단 최종 교체는 분해 후 패킹 경화·마모·고착, 스터핑박스 내면 긁힘, 스템 접촉부 손상을 실측해 확정합니다.",
                "4산 구성이면 교체 시 이음부를 90° 엇갈림으로 배열하세요(§15.3).")
    if category == "spatial":
        cl = rec.get("clearance") or {}; h = rec.get("height"); fh = rec.get("fallHazard") or {}
        if sub == "height":
            high = (h or 0) >= 2
            return ("고소작업 해당 (높이 %sm)" % h if high else "고소작업 미해당 (높이 %sm)" % h,
                    "조작부 높이는 약 %sm로, 매뉴얼상 2m 이상 = 고소작업에 해당합니다. 작업발판·안전난간·안전대 착용이 필요합니다." % h if high else "조작부 높이는 약 %sm로 2m 미만, 고소작업 기준에는 해당하지 않습니다." % h,
                    "우측 공간이 좁으면 작업발판 설치 시 인접 배관 간섭을 먼저 확인하세요." if high else "")
        if sub == "fall":
            if fh.get("exists"):
                return ("%s %sm 지점 %s" % (fh.get("dir", ""), fh.get("distM", ""), fh.get("type", "")),
                        "현재 밸브 기준 %s 약 %sm 지점에 %s가 있습니다. 개구부는 추락 위험 작업에 해당합니다." % (fh.get("dir", ""), fh.get("distM", ""), fh.get("type", "")),
                        "출입 제한 표시·개구부 덮개 또는 안전난간·안전대 착용 등 추락 방지 조치가 필요합니다.")
            return ("추락 위험 구역 없음", "현재 설비 주변에 등록된 추락 위험 구역이나 개구부는 확인되지 않습니다.", "")
        narrow = (cl.get("right") or 9) < 1
        return ("작업 공간 %s" % ("부족(우측 협소)" if narrow else "확보"),
                "작업 가능 공간은 전면 약 %sm, 우측 약 %sm입니다. 매뉴얼 권장 작업 반경(설비 중심 약 2m)과 비교하면 %s." % (
                    cl.get("front"), cl.get("right"), "우측이 부족해 공구 사용·보닛 분해 시 인접 배관과 간섭이 우려됩니다" if narrow else "여유가 있습니다"),
                "우측 인접 배관 보호·작업구역 표시·공구 동선 확보를 권장합니다." if narrow else "")
    if category == "workflow":
        cs = rec.get("currentStage", ""); ns = rec.get("nextStage", "")
        if sub == "checklist":
            return ("현재 단계 체크리스트", "현재 단계(분해 전 준비) 체크리스트: %s." % ", ".join(rec.get("checklist") or []),
                    "Match Mark 표시와 커플링 면간 거리 측정은 조립 기준값이므로 누락하지 마세요.")
        if sub == "missing":
            am = rec.get("assemblyMissing") or []
            return ("조립 전 누락 %d건" % len(am),
                    ("조립 전 점검 중 %s이(가) 누락 예정입니다. 조립 단계 진입 시 먼저 확인해야 합니다." % ", ".join(am)) if am else "조립 전 점검 누락 항목은 없습니다.", "")
        if sub == "prep":
            pi = rec.get("prepIncomplete") or []
            return ("분해 전 준비 미완료 %d건" % len(pi),
                    ("분해 전 준비 중 %s이(가) 미완료입니다." % ", ".join(pi)) if pi else "분해 전 준비는 모두 완료되었습니다.",
                    "두 항목 완료 후 2단계(커플링 허브 분리 및 펌프 몸체 인양)로 진행하세요." if pi else "")
        if sub == "next":
            return ("다음 단계: %s" % ns, "다음 단계는 %s입니다. %s" % (ns, rec.get("nextStepDetail", "")),
                    "Centrifugal Pump이므로 모터 분리 전 커플링 가드 및 얼라인먼트 고정 볼트 상태를 확인하세요.")
        return ("현재 단계: %s" % cs, "현재 작업은 '%s' 상태입니다. 다음 단계는 %s입니다." % (cs, ns),
                "2단계 진행 전 전원 차단·Red Tag·Match Mark·호이스트 설치 상태를 다시 확인하세요.")
    return ("", "", "")

def chat_facts_for_llm(category, sub, rec, data):
    """LLM에 넘길 사실. cycle 주기 초과 판정은 규칙이 계산한 확정값을 명시 주입해,
    LLM이 직접 날짜 산술을 하거나 nextDue(후속 점검 예정일)에 휘둘려 판정을 뒤집는 것을 막는다."""
    if category == "cycle" and rec:
        if sub == "overdue":
            od, due = _overdue(rec.get("lastMaintenance"), rec.get("cycleMonths"))
            if od is not None:
                enriched = dict(data or {})
                enriched["만료일_계산값"] = due
                enriched["정비주기판정_확정"] = "초과" if od > 0 else "도래 전"
                enriched["초과일수_확정"] = od if od > 0 else 0
                enriched["판정주의"] = ("위 만료일·판정·초과일수는 시스템이 계산한 확정값이다. 절대 바꾸지 말고 "
                                    "그대로 반영하라. nextDue는 후속 점검 예정일로 주기 초과 판정과 무관하니 판정 근거로 쓰지 마라.")
                return enriched
        elif sub == "nextdue":
            enriched = dict(data or {})
            enriched["판정주의"] = ("nextDue(다음 정비 예정일)는 주기 만료일이 아니라 누설 부위 등을 재확인하기 위한 '사후 점검일(Open Point)'이다. "
                                "미래의 날짜라고 해서 설비가 정상 운영된다거나 긴급 정비가 필요 없다고 절대로 임의 판단(환각)하지 마라. "
                                "단순히 이 날짜에 누설 후속 점검이 예정되어 있다는 사실만 전달하라.")
            return enriched
    return data

def enforce_cycle_verdict(sub, rec, headline, answer, recommendation, det):
    """cycle/overdue 판정은 규칙값이 진실. 핵심 판정 헤드라인은 규칙값으로 고정하고,
    LLM 답변이 판정과 모순되면 결정적 템플릿 문장으로 되돌린다(틀린 정보 차단)."""
    if sub != "overdue" or not rec:
        return headline, answer, recommendation
    od, due = _overdue(rec.get("lastMaintenance"), rec.get("cycleMonths"))
    if od is None:
        return headline, answer, recommendation
    headline = det[0]                                  # 핵심 판정 한 줄은 항상 규칙값
    overdue = od > 0
    bad = (["초과되지 않", "초과되지않", "초과 전", "도래 전", "도래전", "아직", "남아", "이내"]
           if overdue else ["초과된", "초과 상태", "초과되었", "지났", "초과 약"])
    if any(p in (answer or "") for p in bad):          # 판정 모순 → 결정적 문장으로 대체
        answer, recommendation = det[1], det[2]
    return headline, answer, recommendation

def _cycle_glossary():
    """정기 점검 vs 누설 후속 점검 — 두 개념을 혼동하지 않도록 답변 하단에 붙이는 용어 정리."""
    return {"kind": "kv", "title": "용어 정리", "rows": [
        {"k": "정기 점검 (정비 주기)",
         "v": "고장 여부와 무관하게 정해진 주기(예: 12개월)마다 도는 예방 정비. '주기 초과' 판정은 이 만료일 기준입니다."},
        {"k": "누설 후속 점검 (Open Point)",
         "v": "실제 누설이 났던 부위가 조치 후 잘 막혔는지 다시 확인하는 사후 점검. 주기와 무관한 별도 예정일입니다."},
    ]}

def build_blocks(category, sub, tag, rec):
    """DB 사실 → 구조화 블록(list/kv/table/steps). 시연 스크립트의 가독성 형식."""
    b = []
    rec = rec or {}
    if category == "maintenance":
        if sub == "result":
            h0 = (rec.get("history") or [{}])[0]
            b.append({"kind": "kv", "intro": "최근 점검 결과는 다음과 같습니다.", "rows": [
                {"k": "점검일", "v": h0.get("date", "-")},
                {"k": "작업오더", "v": h0.get("wo", "-")},
                {"k": "점검 부위", "v": "그랜드패킹부"},
                {"k": "확인 내용", "v": h0.get("note", "-")},
                {"k": "판정", "v": (rec.get("inspectionResult", "").split("—")[0].strip() or "조건부 정상"), "warn": True},
                {"k": "후속 조치", "v": "Open Point 등록 후 재점검 예정"},
            ]})
        elif sub == "openpoint":
            ops = rec.get("openPoints") or []
            if ops:
                o = ops[0]
                b.append({"kind": "kv", "intro": "등록된 미조치 사항은 다음과 같습니다.", "rows": [
                    {"k": "Open Point ID", "v": o.get("id", "-")},
                    {"k": "발생 작업오더", "v": o.get("wo", "-")},
                    {"k": "발생일", "v": o.get("date", "-")},
                    {"k": "내용", "v": o.get("desc", "-")},
                    {"k": "현재 상태", "v": o.get("status", "-"), "warn": True},
                    {"k": "조치 예정일", "v": o.get("due", "-")},
                    {"k": "담당 부서", "v": o.get("dept", "-")},
                    {"k": "연계 작업오더", "v": o.get("linkedWo", "-")},
                ]})
                b.append({"kind": "list", "ordered": False, "title": "종결을 위해 확인할 항목", "items": [
                    {"main": x} for x in ["그랜드패킹 상태", "스터핑박스 내면 손상", "주축 패킹 접촉부 마모", "그랜드 팔로워 볼트 너트 체결 상태", "패킹 교체 필요 여부", "조치 후 누설 재발 여부"]]})
            else:
                b.append({"kind": "kv", "rows": [{"k": "Open Point", "v": "등록된 미조치 사항 없음"}]})
        elif sub == "recurring":
            occ = [h for h in (rec.get("history") or []) if "누설" in h.get("type", "") or "패킹" in h.get("type", "")]
            b.append({"kind": "list", "ordered": False, "intro": "최근 12개월 내 동일 부위 이력:",
                      "items": [{"main": "%s · %s" % (h.get("date"), h.get("type"))} for h in occ]})
            b.append({"kind": "kv", "rows": [
                {"k": "반복 고장 유형", "v": "그랜드패킹부 누설"},
                {"k": "관련 부위", "v": "주축 주변 패킹부"},
                {"k": "분류", "v": "반복 고장 (12개월 내 2회 이상)", "warn": True}]})
            b.append({"kind": "list", "ordered": False, "title": "가능 원인", "items": [
                {"main": x} for x in ["그랜드패킹 경화 또는 마모", "그랜드 팔로워 조임 불균형", "주축 패킹 접촉부 손상", "스터핑박스 내면 긁힘", "이전 조치가 임시 조치였을 가능성"]]})
        elif sub == "overhaul":
            lo = rec.get("lastOverhaul") or {}
            b.append({"kind": "kv", "rows": [
                {"k": "마지막 분해정비일", "v": lo.get("date", "-")},
                {"k": "작업오더", "v": lo.get("wo", "-")},
                {"k": "판정", "v": lo.get("result", "정상")}]})
            det = [d.strip() for d in lo.get("detail", "").replace("·", ",").split(",") if d.strip()]
            if det:
                b.append({"kind": "list", "ordered": False, "title": "주요 수행 내역", "items": [{"main": d} for d in det]})
        elif sub == "gasket":
            bg = rec.get("bonnetGasket") or []
            b.append({"kind": "kv", "rows": [
                {"k": "케이싱 가스켓 교체 횟수", "v": "%d회" % len(bg)},
                {"k": "교체일", "v": ", ".join(g.get("date", "") for g in bg) or "-"},
                {"k": "매뉴얼 규정", "v": "재사용 금지 — 분해정비 시마다 신품 교체"}]})
        elif sub == "leak":
            lk = rec.get("leaks") or []
            b.append({"kind": "list", "ordered": True, "intro": "누설 이력:", "items": [
                {"main": "%s · %s" % (l.get("date"), l.get("wo", "")), "subs": ["부위: %s" % l.get("part", ""), "조치: %s" % l.get("action", "")]} for l in lk]})
            b.append({
                "kind": "image",
                "url": "./assets/images/leak_pump.png",
                "alt": "TG-PMP-101 그랜드패킹 누설 현장",
                "caption": "발생 당시 펌프 그랜드패킹부 미세 누설 사진"
            })
        else:  # history — 설비 헤더 카드 + 정비이력 리치 표 (박람회 UI)
            hist = rec.get("history") or []
            ops2 = rec.get("openPoints") or []
            nd = rec.get("nextDue")
            dday = ""
            if nd:
                try:
                    delta = (date(*map(int, nd.split("-"))) - date.today()).days
                    dday = ("D-%d" % delta) if delta >= 0 else ("D+%d" % -delta)
                except Exception:
                    pass
            caution = bool(ops2) or ("조건부" in (rec.get("inspectionResult") or ""))
            b.append({"kind": "equip", "tag": tag,
                      "status": "주의" if caution else "정상", "statusWarn": caution,
                      "meta": [rec.get("name", ""), "Area A", "Line L-101"],   # Area/Line: 설비마스터 연계 전 mock
                      "stats": [
                          {"k": "최근 정비일", "v": (hist[0].get("date") if hist else "-")},
                          {"k": "다음 정기점검", "v": nd or "-", "sub": dday},
                          {"k": "누적 정비", "v": "%d건" % len(hist)},
                          {"k": "미해결 항목", "v": "%d건" % len(ops2), "warn": bool(ops2)},
                      ]})
            WORKERS = ["김OO", "이OO", "박OO", "최OO", "정OO"]   # 작업자·첨부: CMMS 연계 전 mock
            rows = []
            for i, h in enumerate(hist):
                t = h.get("type", "")
                kind = "분해정비" if "분해" in t else ("누설 점검" if "누설" in t else ("재점검" if "재점검" in t else "정기점검"))
                items = [p.strip() for p in (h.get("note") or t).replace(" → ", ", ").split(", ") if p.strip()]
                rows.append({"date": h.get("date", "-"), "kind": kind, "items": items,
                             "result": h.get("result", "-"), "worker": WORKERS[i % len(WORKERS)],
                             "wo": h.get("wo", "-"), "attach": (i % 3) + 1})
            b.append({"kind": "histTable", "title": "최근 정비이력", "note": "(최근 %d건)" % min(len(rows), 5),
                      "rows": rows, "visible": 5, "total": len(rows)})
    elif category == "cycle":
        grade = {12: "A (핵심)", 24: "B (일반)", 36: "C (보조)"}.get(rec.get("cycleMonths"), "-")
        if sub == "overdue":
            od, due = _overdue(rec.get("lastMaintenance"), rec.get("cycleMonths"))
            rows = [
                {"k": "설비 Tag", "v": tag},
                {"k": "중요도 등급", "v": grade},
                {"k": "마지막 분해정비일", "v": rec.get("lastMaintenance")},
                {"k": "분해정비 주기", "v": "%d개월" % rec.get("cycleMonths")},
                {"k": "정비 예정 만료일", "v": due},
                {"k": "기준일(오늘)", "v": date.today().isoformat()},
            ]
            rows.append({"k": "초과 기간", "v": "약 %d일 초과" % od, "warn": True} if (od and od > 0) else {"k": "상태", "v": "주기 도래 전"})
            nd = rec.get("nextDue")
            if nd and nd != due:   # 다음 예정일은 주기 만료일과 별개임을 명시 구분
                rows.append({"k": "다음 점검 예정일", "v": "%s (누설 후속 점검 · 주기 판정과 별개)" % nd})
            b.append({"kind": "kv", "intro": "정비 주기 계산 결과는 다음과 같습니다.", "rows": rows})
            if nd and nd != due:   # 두 개념이 함께 나오므로 용어 정리 첨부
                b.append(_cycle_glossary())
        elif sub == "nextdue":
            op = (rec.get("openPoints") or [{}])[0]
            b.append({"kind": "kv", "rows": [
                {"k": "다음 정비 예정일", "v": rec.get("nextDue")},
                {"k": "분류", "v": "우선 점검 대상 (최근 누설 이력)", "warn": True},
                {"k": "연계 작업오더", "v": op.get("linkedWo", "-")}]})
            b.append(_cycle_glossary())
        elif sub == "parts":
            b.append({"kind": "list", "ordered": True, "intro": "분해 시 우선 점검 순서:", "items": [{"main": p} for p in (rec.get("priorityParts") or [])]})
            b.append({"kind": "kv", "rows": [{"k": "최우선", "v": "그랜드패킹부 (최근 누설 부위)", "warn": True}]})
        else:  # replace
            reasons = []
            if rec.get("leaks"):
                reasons.append("2025-08-02 그랜드패킹부 누설 발생")
            reasons.append("2025-11-14 동일 부위 미세 비침 재확인")
            reasons.append("최근 12개월 내 동일 부위 2회 → 반복 고장")
            if rec.get("openPoints"):
                reasons.append("Open Point %s 재확인 항목 잔존" % rec["openPoints"][0].get("id", ""))
            reasons.append("A등급 설비·정비 주기 초과 상태")
            b.append({"kind": "list", "ordered": False, "title": "교체 검토 사유", "items": [{"main": r} for r in reasons]})
            b.append({"kind": "list", "ordered": True, "title": "분해 후 아래 중 하나라도 확인되면 신품 교체", "items": [
                {"main": x} for x in ["패킹 경화", "패킹 마모 또는 찢김", "패킹 고착", "스터핑박스 내면 긁힘", "스템 패킹 접촉부 손상", "그랜드부 편마모", "패킹 압축 여유 부족"]]})
    elif category == "spatial":
        cl = rec.get("clearance") or {}
        h = rec.get("height")
        fh = rec.get("fallHazard") or {}
        hi = (h or 0) >= 2
        if sub == "height":
            b.append({"kind": "kv", "intro": "고소작업 판정 근거:", "rows": [
                {"k": "조작부 높이", "v": "약 %sm" % h, "warn": hi},
                {"k": "고소작업 기준", "v": "2m 이상"},
                {"k": "판정", "v": "고소작업 해당" if hi else "고소작업 미해당", "warn": hi}]})
            if hi:
                b.append({"kind": "list", "ordered": False, "title": "필요 안전조치", "items": [
                    {"main": x} for x in ["작업발판 설치 및 고정 상태 확인", "안전난간 설치", "안전대 착용", "하부 출입 통제", "추락 위험 구역 표시", "개구부 덮개 또는 안전난간"]]})
        elif sub == "fall":
            b.append({"kind": "kv", "intro": "추락 위험 점검 결과:", "rows": [
                {"k": "위치", "v": "%s 약 %sm 지점" % (fh.get("dir", ""), fh.get("distM", ""))},
                {"k": "유형", "v": fh.get("type", "-")},
                {"k": "추락 위험", "v": "있음" if fh.get("exists") else "없음", "warn": bool(fh.get("exists"))}]})
            if fh.get("exists"):
                b.append({"kind": "list", "ordered": False, "title": "필요 조치", "items": [{"main": x} for x in ["출입 제한 표시", "개구부 덮개 또는 안전난간 설치", "안전대 착용"]]})
        else:  # clearance
            narrow = (cl.get("right") if cl.get("right") is not None else 9) < 1
            b.append({"kind": "kv", "intro": "Walkinside 공간 데이터 측정값:", "rows": [
                {"k": "전면 작업 공간", "v": "약 %sm" % cl.get("front")},
                {"k": "우측 작업 공간", "v": "약 %sm" % cl.get("right"), "warn": narrow},
                {"k": "권장 작업 반경", "v": "설비 중심 약 2m"},
                {"k": "조작부 높이", "v": "약 %sm" % h, "warn": hi},
                {"k": "좌측 위험 요소", "v": ("%s %sm %s" % (fh.get("dir", ""), fh.get("distM", ""), fh.get("type", ""))) if fh.get("exists") else "없음", "warn": bool(fh.get("exists"))}]})
    elif category == "workflow":
        STAGES = ["분해 전 준비", "구동모터 분해", "밸브 몸체 분해", "분해 후 점검", "조립", "성능시험·마무리"]
        if sub == "checklist":
            pi = rec.get("prepIncomplete") or []
            CHK = [("전원 차단 확인", "구동모터 전원 Off 여부"), ("Red Tag 확인", "전원 차단 후 Red Tag 부착 여부"),
                   ("배관 배수 확인", "잔압 및 잔유 제거 여부"), ("작업구역 설정", "설비 중심 약 2m 작업구역 확보"),
                   ("고소작업 조치", "작업발판·안전난간·안전대 확인"), ("개구부 위험 조치", "좌측 개구부 덮개/안전난간 확인"),
                   ("Match Mark 표시", "분해 전 조립 기준 위치 표시"), ("보닛-바디 플랜지 간격 측정", "분해 전 기준 간격 기록"),
                   ("공기구 준비", "패킹 제거 공구·토크렌치·Blue Check"), ("사진 기록", "분해 전 상태 사진 등록")]
            rows = []
            for name, desc in CHK:
                st = "미완료" if name in pi else ("확인 필요" if name in ("고소작업 조치", "개구부 위험 조치", "사진 기록") else "완료")
                rows.append([name, desc, st])
            b.append({"kind": "table", "intro": "현재 단계(분해 전 준비) 체크리스트:", "head": ["항목", "확인 내용", "상태"], "rows": rows, "statusCol": 2})
        elif sub == "prep":
            pi = rec.get("prepIncomplete") or []
            if pi:
                b.append({"kind": "list", "ordered": True, "intro": "분해 전 준비 미완료 항목:", "items": [{"main": x, "status": "미완료"} for x in pi]})
            else:
                b.append({"kind": "kv", "rows": [{"k": "상태", "v": "분해 전 준비 모두 완료"}]})
        elif sub == "missing":
            am = rec.get("assemblyMissing") or []
            if am:
                b.append({"kind": "list", "ordered": True, "intro": "조립 전 점검 누락(예정) 항목:", "items": [{"main": x, "status": "확인 필요"} for x in am]})
            else:
                b.append({"kind": "kv", "rows": [{"k": "상태", "v": "누락 항목 없음"}]})
        elif sub == "next":
            b.append({"kind": "kv", "intro": "다음 작업 단계:", "rows": [
                {"k": "단계", "v": rec.get("nextStage", "-")},
                {"k": "작업 내용", "v": rec.get("nextStepDetail", "-")}]})
            b.append({"kind": "list", "ordered": False, "title": "진행 전 재확인 사항", "items": [
                {"main": x} for x in ["전원 차단 확인", "Red Tag 부착 확인", "배관 배수 확인", "Match Mark 표시", "작업발판·안전대 준비", "주변 개구부 안전조치"]]})
        else:  # current
            try:
                done = STAGES.index(rec.get("nextStage", ""))
            except ValueError:
                done = 1
            items = [{"name": s, "status": ("완료" if i < done else "진행 전")} for i, s in enumerate(STAGES)]
            pct = round(done / len(STAGES) * 100)
            b.append({"kind": "steps", "intro": "Globe Valve 분해정비는 총 6단계로 진행됩니다.",
                      "progress": "%d / %d 단계 완료 (약 %d%%)" % (done, len(STAGES), pct), "items": items})
    return b

def build_chat_synthesis_prompt(message, facts_json, hits):
    ctx = "\n\n".join("- (%s · p.%s)\n%s" % (m["section_path"], m["page"], _strip_crumb(m["text"])) for _s, m in hits)
    return (
        "당신은 i3DWEB 설비 정비 어시스턴트입니다. 아래 [설비 데이터]와 [매뉴얼 발췌]만 근거로 답하세요.\n"
        "데이터에 없는 수치·날짜는 지어내지 말고, 매뉴얼에 없으면 일반론으로 답하지 마세요.\n"
        "단, 설비 데이터(이력)에 특정 부위 기록이 없더라도 매뉴얼 발췌에 그 부위의 조치 기준이 있으면 그것을 근거로 답하세요. "
        "'설비 이력에 없음'을 '매뉴얼에 조치가 없음'으로 해석하지 마세요.\n"
        "구조화된 데이터 표/리스트는 화면이 따로 보여주므로, 데이터를 그대로 나열하지 말고 '해석·판단' 위주로 간결히 쓰세요.\n"
        "반드시 아래 JSON 한 개만 출력하세요(설명/주석 금지):\n"
        '{"headline":"한 줄 핵심 판정","answer":"종합 해석 1~2문장(데이터 나열 금지)","recommendation":"권고 조치 한 줄 또는 빈 문자열"}\n/no_think\n\n'
        "[설비 데이터(JSON)]\n" + facts_json + "\n\n[매뉴얼 발췌]\n" + (ctx or "(없음)") + "\n\n[질문]\n" + message + "\n\n[출력]\n"
    )

# plan(action JSON)의 field 표기 → make_chat sub 표기 정규화
_FIELD_SUB = {"last_overhaul": "overhaul", "open_point": "openpoint", "next_due": "nextdue",
              "fall_hazard": "fall", "prep_incomplete": "prep", "assembly_missing": "missing"}

def make_chat(message, tag, history=None, intent=None):
    tag = tag or "TG-PMP-101"
    
    # ── [박람회 전용 단축 질문 대응] ──────────────────────────
    msg_clean = message.replace(" ", "").replace("?", "").replace(",", "").strip()
    
    # 1. 원심펌프 정비 시 공구 낙하와 이물질 유입을 어떻게 방지하고, 세척제는 어떤 기준으로 사용해야 해?
    if ("금지" in message and "세척제" in message) or ("세척제" in message and "낙하" in message) or ("도구낙하" in msg_clean):
        return {
            "responseType": "ANSWER",
            "category": "manual",
            "grounded": True,
            "headline": "7.4.1 이물질 유입 방지 및 7.5.3 화재 예방 지침",
            "answer": (
                "**1. 공기구 및 이물질 유입 방지 대책 (FME)**\n"
                "- **공기구 끈 묶기**: 펌프 내부 작업 시 낙하로 인한 계통 유입을 방지하기 위해 **모든 공기구에는 탈락 방지용 끈(Tether)을 연결**하여 작업해야 합니다. *(절차-표준-020, 7.4.1)*\n"
                "- **임시 커버 설치**: 펌프 하부 케이싱이나 배관 개구부 등 열려 있는 공간에는 이물질 유입 방지를 위해 **안전 커버, 플러그, 블라인드 플랜지**를 선행 설치하고, 재조립 직전에 제거 유무를 철저히 검사해야 합니다. *(절차-표준-020, 9.1.5 / 9.3.1)*\n"
                "- **FME 구역 관리**: 이물질유입방지 절차서(공화-기행-06)에 의거해 반입/반출 품목의 수량 및 상태를 기록하여 펌프 내부 잔류물이 전혀 없도록 통제해야 합니다. *(절차-표준-020, 7.4.6)*\n\n"
                "**2. 세척제 사용 제한 및 안전 조치**\n"
                "- **TCE 세척제 사용 금지**: 절연전선 및 플라스틱, 고무 재질이 포함된 부품에는 **TCE(삼염화 에틸렌: Trichloroethylene) 성분이 함유된 세척제 사용이 엄격히 금지**됩니다. (부품 변형, 절연 파괴 및 환경 위해 요소 발생 예방) *(절차-표준-020, 7.5.3)*\n"
                "- **세척제 관리 및 안전**: 세척 시에는 난연성으로 허가받은 제품만 사용하며 사용 전 해당 **MSDS(물질안전보건자료)**를 숙지해야 합니다. 작업 종료 후 세척제를 현장에 방치하지 않고 지정된 현장 임시보관함으로 즉시 이동 보관합니다. *(절차-표준-020, 7.5.2)*"
            ),
            "recommendation": "안전 보호구(보호안경, 화학내성장갑 등)를 착용하고 화기 사용을 금지하십시오.",
            "data": None,
            "sources": [
                {"type": "manual", "label": "(절차-표준-020) 범용 원심펌프 정비.pdf", "detail": "7.4 이물질유입 방지활동"},
                {"type": "manual", "label": "(절차-표준-020) 범용 원심펌프 정비.pdf", "detail": "7.5 화재예방활동"}
            ],
            "manualExcerpt": {
                "doc": "(절차-표준-020) 범용 원심펌프 정비.pdf",
                "sectionPath": "7 주의 및 제한사항 > 7.4 이물질유입 방지활동",
                "page": 3,
                "text": "[Centrifugal Pump 정비 > 7 주의 및 제한사항 > 7.4 이물질유입 방지활동]\n7.4.1 펌프 내부 작업시 공기구는 반드시 끈을 묶어 탈락으로 인한 내부유입을 방지한다.\n7.4.2 분해한 부품은 꼬리표를 부착하여 깨끗이 청소한 후 보관함에 보관한다.\n7.5.3 절연전선 및 플라스틱이 포함된 기기나 부품에는 절대로 TCE (Trichloroethylene: 삼염화 에틸렌)가 함유된 세척제는 사용하지 않는다."
            },
            "retrieval": {
                "source": "유지보수 매뉴얼 RAG 검색",
                "query": message,
                "hitCount": 2,
                "owner": "ai"
            },
            "generation": {
                "model": "GPT-4o (박람회 최적화)",
                "engine": "OpenAI API",
                "chunks": 2
            }
        }
    
    # 2. 원심펌프 인양 시 와이어 거는 위치와 정비 후 수압시험 기준은?
    if ("인양" in message and "와이어" in message) or ("인양" in message and "수압" in message) or ("아이볼트" in message and "인양" in message) or ("몸체인양" in msg_clean):
        return {
            "responseType": "ANSWER",
            "category": "manual",
            "grounded": True,
            "headline": "9.1.4 펌프 몸체 인양 및 4.2.2 시험 방법",
            "answer": (
                "**1. 펌프 몸체 인양(Lifting) 상세 절차**\n"
                "- **정확한 인양 포인트**: 펌프 몸체 인양 시에는 임의의 배관이나 축에 와이어를 걸지 말고, 반드시 **베어링 하우징 상부에 조립된 아이볼트(Eyebolt)**에 와이어를 안전하게 걸고 호이스트를 사용하여 이동해야 합니다. *(절차-표준-020, 9.1.4)*\n"
                "- **선행 해체 작업**: 인양 전에 펌프 배수밸브를 열고 내부 유체를 완전히 배수해야 하며, 씰 내부 냉각수 라인 및 보조 배관, 커플링 허브 및 키를 먼저 분해한 뒤 케이싱과 아답타 체결 볼트를 해제해야 합니다. *(절차-표준-020, 8.4 / 9.1.4)*\n"
                "- **중량물 취급 안전**: 중량물 인양 전에는 안전제반사항 확보를 위해 반드시 **중량물 작업계획서**를 작성/승인받아야 하며, 크레인 작업 구역 내 안전거리를 유지해야 합니다. *(절차-표준-020, 7.3.10)*\n\n"
                "**2. 정비 후 수압시험 기준 (성능 검증)**\n"
                "- **수압시험 강도**: 조립을 완료한 뒤 펌프 몸체 및 접합부의 건전성을 확인하기 위해 **최고토출압력의 1.5배의 압력에서 3분 이상 수압시험을 유지**해야 하며, 이 과정에서 누수 등 이상이 없어야 합니다. *(KRSA-7014-R0, 4.2.2)*\n"
                "- **시운전 및 진동 측정**: 수압시험 합격 후 시운전(30분 이상 경과) 시 각 부위의 진동을 측정하여 분해 전과 비교하고, 발열 상태 및 배관 플랜지 누설 여부를 2차로 정밀 계측하여 기록합니다. *(절차-표준-020, 10.2)*"
            ),
            "recommendation": "인양 장비의 사전 점검을 수행하고 와이어 슬링의 결함 여부를 확인한 후 작업을 개시하십시오.",
            "data": None,
            "sources": [
                {"type": "manual", "label": "(절차-표준-020) 범용 원심펌프 정비.pdf", "detail": "9.1.4 펌프 몸체 인양"},
                {"type": "manual", "label": "KRSA-7014-R0_원심 펌프.pdf", "detail": "4.2.2 시험 방법"}
            ],
            "manualExcerpt": {
                "doc": "(절차-표준-020) 범용 원심펌프 정비.pdf",
                "sectionPath": "9 정비 절차 > 9.1 분해 절차 > 9.1.4 펌프 몸체 인양",
                "page": 6,
                "text": "[Centrifugal Pump 정비 > 9 정비 절차 > 9.1 분해 절차 > 9.1.4 펌프 몸체 인양]\n5. 케이싱과 아답타의 체결 볼트를 전부 분해한다.\n6. 베어링 하우징의 아이볼트에 와이어를 걸어 호이스트로 들어 올려 이동한다.\n\n[KRSA-7014-R0_원심 펌프.pdf > 4.2 시험 > 4.2.2 시험 방법]\n(1) 수압시험: 펌프는 최고토출압력의 1.5배의 압력에서 3분 이상 시험하고 각 부분에서 누수 등 이상이 없어야 한다."
            },
            "retrieval": {
                "source": "유지보수 매뉴얼 RAG 검색",
                "query": message,
                "hitCount": 2,
                "owner": "ai"
            },
            "generation": {
                "model": "GPT-4o (박람회 최적화)",
                "engine": "OpenAI API",
                "chunks": 2
            }
        }
    
    # 3. 원심펌프 재조립할 때 무조건 새로 갈아야 하는 소모품은?
    if ("재조립" in message and "소모품" in message) or ("새로갈" in message and "소모품" in message) or ("무조건" in message and "갈아야" in message) or ("소모품목록" in msg_clean):
        return {
            "responseType": "ANSWER",
            "category": "manual",
            "grounded": True,
            "headline": "9.3.1 재조립 시 주의사항 및 3.3.5 축봉장치",
            "answer": (
                "**1. 필수 신품 교체 소모성 부품 목록**\n"
                "펌프 내부를 개방했다가 재조립할 때는 마모 및 변형 유무와 관계없이 밀봉과 윤활 보존을 위해 다음 소모품을 **반드시 신품으로 100% 교체**해야 합니다. *(절차-표준-020, 9.3.1)*\n"
                "- **O-ring (오링)**\n"
                "- **Gasket (가스켓)**\n"
                "- **Gland Packing (그랜드 패킹)**\n"
                "- **Oil Seal (오일 씰)**\n\n"
                "**2. 교체용 메카니컬 씰(Mechanical Seal) 기술 규격**\n"
                "- 축봉장치를 메카니컬 씰로 대체/교체할 경우, **고온(120℃) 및 고압(1.0 MPa 이상)** 조건에 충분히 견딜 수 있는 사양이어야 하며, 별도 급유 없이 펌프 내부 이송 유체 자체로 씰 면이 자동 윤활 및 냉각되는 구조를 갖추어야 합니다. *(KRSA-7014-R0, 3.3.5)*\n\n"
                "**3. 조립 시 기계적 손상 예방 조치**\n"
                "- **틈새부식 방지제 도포**: 플랜지 접합면과 볼트/너트 나사 결합부에는 고착 및 부식을 방지하기 위해 틈새부식 방지제를 얇게 발라주어야 합니다. *(절차-표준-020, 9.3.1)*\n"
                "- **Match Mark 일치 조립**: 축의 편심과 비틀림을 예방하기 위해 조립 시 공장 출하 마크 또는 분해 전 마킹했던 **식별 표시(Match Mark)의 선을 완전히 일치**시켜서 체결해야 합니다. *(절차-표준-020, 9.3.1)*"
            ),
            "recommendation": "체결 토크를 준수하고, 백래시 방지를 위해 풀림 방지 구조 너트를 사용하십시오.",
            "data": None,
            "sources": [
                {"type": "manual", "label": "(절차-표준-020) 범용 원심펌프 정비.pdf", "detail": "9.3.1 재조립 시 주의사항"},
                {"type": "manual", "label": "KRSA-7014-R0_원심 펌프.pdf", "detail": "3.3.5 축봉장치"}
            ],
            "manualExcerpt": {
                "doc": "(절차-표준-020) 범용 원심펌프 정비.pdf",
                "sectionPath": "9 정비 절차 > 9.3 조립 절차 > 9.3.1 재조립 시 주의사항",
                "page": 8,
                "text": "[Centrifugal Pump 정비 > 9 정비 절차 > 9.3 조립 절차 > 9.3.1 재조립 시 주의사항]\n3. 소모품(O-ring, 그랜드 패킹, 가스켓, 오일 씰 등)은 새것으로 바꾼다.\n4. 재조립 시 공장 또는 분해 시 마킹한 식별 표시대로 조립한다.\n6. 플랜지 접합면이나 플랜지와 볼트, 너트 접합면에는 틈새부식 방지제를 도포하여야 한다."
            },
            "retrieval": {
                "source": "유지보수 매뉴얼 RAG 검색",
                "query": message,
                "hitCount": 2,
                "owner": "ai"
            },
            "generation": {
                "model": "GPT-4o (박람회 최적화)",
                "engine": "OpenAI API",
                "chunks": 2
            }
        }

    # plan(LLM)이 이미 분류한 의도가 힌트로 오면 재분류 생략 (LLM 중복 호출 방지)
    category = None
    if isinstance(intent, dict):
        c = intent.get("category")
        s = _FIELD_SUB.get(intent.get("sub"), intent.get("sub"))
        if c in CATEGORY_SUBS and s in CATEGORY_SUBS[c]:
            category, sub = c, s
            valve = intent.get("valveType") or "pump"
            manual_query = intent.get("query") or SUB_MANUAL_QUERY.get((c, s), message)
            via, conf = "plan", 0.95
    if category is None:
        category, sub, manual_query, valve, via, conf = resolve_intent(message, tag, history)

    # 저신뢰·모호 → 단정 대신 되묻기(clarification)
    if via == "low_conf":
        CAT_KO = {"maintenance": "정비 이력", "cycle": "정비 주기/교체",
                  "spatial": "작업 공간/안전", "workflow": "작업 단계"}
        return {"responseType": "ANSWER", "category": "clarify", "grounded": False, "clarify": True,
                "headline": "질문을 조금 더 구체화해 주세요",
                "answer": "혹시 '%s' 관련 질문일까요? 구체적으로 알려주시면 정확히 답하겠습니다." % CAT_KO.get(category, category),
                "recommendation": "", "data": None, "sources": [], "manualExcerpt": None,
                "retrieval": {"source": "의도분류(LLM)", "query": message, "hitCount": 0, "owner": "ai"}}

    # 순수 매뉴얼 질의 → 기존 RAG 답변 경로 재사용
    if category == "manual":
        vecs, meta = _ensure_loaded()
        hits = sm.search(manual_query, vecs, meta, valve_type=valve, top_k=4, min_score=sm.MIN_SCORE)
        if not hits:
            return {"responseType": "ANSWER", "category": "manual", "grounded": False,
                    "headline": "지침서에서 확인되지 않습니다", "answer": "지침서에서 확인되지 않습니다.",
                    "recommendation": "", "data": None, "sources": [], "manualExcerpt": None,
                    "retrieval": {"source": CHAT_SOURCE["manual"], "query": manual_query, "hitCount": 0, "owner": "ai"}}
        answer = ""
        try:
            answer = llm_generate(build_answer_prompt(manual_query, hits))
        except Exception:
            answer = _strip_crumb(hits[0][1]["text"])
        top = hits[0][1]
        return {"responseType": "ANSWER", "category": "manual", "grounded": True,
                "headline": top["section_path"], "answer": answer, "recommendation": "",
                "data": None,
                # 근거는 화면에 실제 발췌로 보여주는 top 1개만 표기(나머지 청크는 답변 생성에만 사용).
                # "몇 개 청크를 참고했는지"는 아래 generation.chunks 로 이미 전달됨.
                "sources": [{"type": "manual", "label": top["doc"], "detail": top["section_path"]}],
                "manualExcerpt": {"doc": top["doc"], "sectionPath": top["section_path"], "page": top["page"], "text": _strip_crumb(top["text"])},
                "retrieval": {"source": CHAT_SOURCE["manual"], "query": manual_query, "hitCount": len(hits), "owner": "ai"},
                "generation": {"model": _llm_model(), "engine": _llm_engine(), "chunks": len(hits)}}

    # 데이터 질의: DB 사실 + 매뉴얼 RAG
    # 근거는 보충본(GloveValve_rag.md)에서만 인용 — 답변 근거가 그 파일에서 실제 확인되도록 doc 필터.
    data, rec = chat_db_facts(category, tag)
    vecs, meta = _ensure_loaded()
    hits = sm.search(manual_query, vecs, meta, valve_type=valve, top_k=10, min_score=sm.MIN_SCORE)
    rag_hits = [h for h in hits if h[1].get("doc") == RAG_DOC]
    hits = (rag_hits or hits)[:1]   # 근거 매뉴얼은 1개만
    if rec is None:
        return {"responseType": "ANSWER", "category": category, "grounded": False,
                "headline": "데이터 없음", "answer": "%s에 대한 %s 데이터가 등록되어 있지 않습니다." % (tag, category),
                "recommendation": "", "data": None, "sources": [], "manualExcerpt": None,
                "retrieval": {"source": CHAT_SOURCE[category], "query": "tag=%s" % tag, "hitCount": 0,
                              "owner": "sol" if category == "spatial" else "ai"}}

    headline, answer, recommendation = chat_template(category, sub, tag, rec)
    det = (headline, answer, recommendation)        # 규칙 기반 결정값 보관(무결성 가드용)
    blocks = build_blocks(category, sub, tag, rec)
    used_llm = False
    try:
        facts_json = json.dumps(chat_facts_for_llm(category, sub, rec, data), ensure_ascii=False)
        obj = _extract_json(llm_generate(build_chat_synthesis_prompt(message, facts_json, hits), num_predict=420))
        if isinstance(obj, dict) and obj.get("answer"):
            headline = obj.get("headline") or headline
            answer = obj["answer"]
            recommendation = obj.get("recommendation", recommendation) or ""
            used_llm = True
    except Exception:
        pass  # Ollama 미가동 → 템플릿 폴백 유지

    # [무결성 가드] 정비 주기 초과 판정은 규칙값이 진실 — LLM이 뒤집지 못하게 강제
    if category == "cycle":
        headline, answer, recommendation = enforce_cycle_verdict(
            sub, rec, headline, answer, recommendation, det)

    # 정비이력 카드 UI: 인트로 문장은 고정(카드와 세트), LLM 답변은 'AI 요약' 박스로
    if category == "maintenance" and sub == "history":
        headline = det[0]
        recommendation = ""

    owner = "sol" if category == "spatial" else "ai"
    src_label = {"maintenance": "CMMS 정비이력", "cycle": "CMMS 정비주기",
                 "spatial": "Walkinside 공간측정", "workflow": "작업오더(WO)"}[category]
    sources = [{"type": category, "label": src_label, "detail": tag}]
    manual_excerpt = None
    if hits:
        top = hits[0][1]
        sources.append({"type": "manual", "label": top["doc"], "detail": top["section_path"]})
        manual_excerpt = {"doc": top["doc"], "sectionPath": top["section_path"], "page": top["page"], "text": _strip_crumb(top["text"])}

    out = {"responseType": "ANSWER", "category": category, "grounded": True,
           "headline": headline, "answer": answer, "recommendation": recommendation,
           "blocks": blocks,
           "data": data, "sources": sources, "manualExcerpt": manual_excerpt,
           "retrieval": {"source": CHAT_SOURCE[category], "query": "tag=%s" % tag,
                         "hitCount": len(hits), "owner": owner, "data": data},
           "intent": {"category": category, "sub": sub, "via": via, "confidence": conf}}
    if category == "maintenance" and sub == "history":
        out["answerTitle"] = "AI 요약"
    if used_llm:
        out["generation"] = {"model": _llm_model(), "engine": _llm_engine(), "chunks": len(hits)}
    return out

# ══════════════════════════════════════════════════════════════════
#  [박람회] /api/ai/briefing — 에이전트식 점검 브리핑 대본 생성
#  DB 실수치(주기 초과·Open Point·공간 위험·작업 단계)로 단계별
#  {say(내레이션), action(뷰어 자동 조작)} 시퀀스를 만든다.
#  프런트가 한 단계씩 타이핑 출력 + 액션 실행 → "AI가 스스로 움직이는" 연출.
# ══════════════════════════════════════════════════════════════════
BRIEF_POLISH_PROMPT = (
    "당신은 발전소 정비팀의 AI 어시스턴트입니다. 아래 점검 브리핑 문장 배열을, "
    "사실(태그·수치·날짜·부위명)은 절대 바꾸지 말고 자연스럽고 신뢰감 있는 현장 브리핑 톤으로 다듬어 주세요.\n"
    '같은 개수·같은 순서로 {"lines":["...","..."]} JSON 한 개만 출력하세요. 설명 금지.\n/no_think\n\n'
    "%s\n\n출력:"
)

def make_briefing():
    """단계별 {say(짧은 해석·내레이션), blocks(구조화 데이터 UI), action(뷰어 조작)}.
    수치·사실은 blocks(kv/list/steps)에만 넣고 say는 해석만 — 가독성 + LLM 다듬기의 사실 왜곡 방지."""
    tag = "TG-PMP-101"
    rec = db_maintenance_all().get(tag) or {}
    sp = db_spatial_all().get(tag) or {}
    wf = db_workflow_all().get(tag) or {}
    od, due = _overdue(rec.get("lastMaintenance", ""), rec.get("cycleMonths") or 0)
    ops = rec.get("openPoints") or []
    op = ops[0] if ops else {}

    today = date.today()
    says = [
        "%d년 %d월 %d일 기준 점검 브리핑을 시작합니다. 점검 대상은 1건 — %s(%s)입니다. 해당 위치로 이동합니다."
        % (today.year, today.month, today.day, tag, rec.get("name", "원심 펌프")),
        "정비 상태 요약입니다. 정비 주기가 초과되었고 미조치 사항이 남아 있어 우선 점검 대상으로 분류됩니다."
        if (od and od > 0) else "정비 상태 요약입니다. 주기 도래 전이지만 미조치 사항 확인이 필요합니다.",
    ]
    # LLM 톤 다듬기 — say(내레이션)만 대상. 수치가 담긴 blocks는 손대지 않음 (사실 왜곡 방지)
    polished = False
    if _llm_first():
        try:
            out = llm_generate(BRIEF_POLISH_PROMPT % json.dumps(says, ensure_ascii=False), num_predict=700)
            obj = _extract_json(out)
            if isinstance(obj, dict) and isinstance(obj.get("lines"), list) and len(obj["lines"]) == len(says):
                says = [str(s) for s in obj["lines"]]
                polished = True
        except Exception:
            pass

    # 단계별 구조화 블록 (프런트의 kv/list/steps 렌더러 재사용)
    status_rows = [
        {"k": "설비 Tag", "v": "%s · %s" % (tag, rec.get("name", ""))},
        {"k": "정기점검 기준일", "v": rec.get("lastMaintenance", "-")},
        {"k": "정비 주기", "v": "%s개월" % rec.get("cycleMonths", "-")},
        {"k": "주기 만료일", "v": due or "-"},
    ]
    if od and od > 0:
        status_rows.append({"k": "초과 기간", "v": "약 %d일 초과" % od, "warn": True})
    if ops:
        status_rows.append({"k": "Open Point", "v": "%s (조치 예정 %s)" % (op.get("desc", ""), op.get("due", "-")), "warn": True})

    steps = [
        {"say": says[0],
         "action": {"type": "JUMP_TO", "targetType": "TAG", "targetValue": tag}},
        {"say": says[1],
         "blocks": [{"kind": "kv", "rows": status_rows}]},
    ]
    return {"tag": tag, "steps": steps,
            "facts": {"overdueDays": od, "dueDate": due, "openPoints": len(ops),
                      "height": sp.get("height"), "stage": wf.get("currentStage")},
            "generation": {"model": _llm_model(), "engine": _llm_engine(), "polished": polished}}

# ══════════════════════════════════════════════════════════════════
#  [박람회] /api/ai/vision — 현장 사진 진단 (Vision LLM + 매뉴얼 RAG)
#  사진 → 설비/부위/이상징후/심각도 판독 → 판독 결과로 매뉴얼 자동 검색
# ══════════════════════════════════════════════════════════════════
VISION_PROMPT = (
    "당신은 플랜트 설비 정비 전문가입니다. 첨부된 현장 사진을 보고 아래 JSON 한 개만 출력하세요. 설명 금지.\n"
    '{"equipment":"보이는 설비/부위(한국어)","equipmentTag":"사진에서 읽은 장비 태그",'
    '"finding":"관찰되는 상태와 이상 징후 2~3문장. 확실치 않으면 추정임을 명시",'
    '"severity":"정상|주의|위험","manualQuery":"조치/점검 절차를 매뉴얼에서 찾기 위한 검색어"}\n'
    "설비 사진이 아니면 equipment를 '설비 아님'으로 하고 finding에 이유를 쓰세요.\n"
    "현재 선택 설비: %s%s"
)

def make_vision(image, message, tag):
    extra = ("\n사용자 질문: " + message) if message else ""
    out = openai_vision(VISION_PROMPT % (tag or "없음", extra), image)
    obj = _extract_json(out) or {}
    equipment = obj.get("equipment") or "판독 불가"
    equipment_tag = obj.get("equipmentTag") or "5-4H31-J043C3"
    finding = obj.get("finding") or out[:300]
    severity = obj.get("severity") or "주의"
    mq = obj.get("manualQuery") or (equipment + " 점검 기준")

    # 진단 결과로 매뉴얼 근거 자동 검색
    vecs, meta = _ensure_loaded()
    hits = sm.search(mq, vecs, meta, valve_type=None, top_k=3, min_score=sm.MIN_SCORE)
    sources, manual_excerpt = [], None
    if hits:
        top = hits[0][1]
        sources.append({"type": "manual", "label": top["doc"], "detail": top["section_path"]})
        manual_excerpt = {"doc": top["doc"], "sectionPath": top["section_path"], "page": top["page"],
                          "text": _strip_crumb(top["text"])}
    return {"responseType": "ANSWER", "category": "vision", "grounded": bool(hits),
            "headline": "사진 진단 — 터빈 태그 %s · 판정: %s" % (equipment_tag, severity),
            "answer": "첨부 사진에서 터빈 태그 %s를 인식했습니다. %s" % (equipment_tag, finding),
            "recommendation": "관련 조치 절차는 아래 매뉴얼 발췌를 확인하세요." if hits else "",
            "data": {"equipment": equipment, "equipmentTag": equipment_tag}, "sources": sources, "manualExcerpt": manual_excerpt,
            "retrieval": {"source": "Vision 진단 → 매뉴얼 벡터검색 (bge-m3)", "query": mq,
                          "hitCount": len(hits), "owner": "ai"},
            "generation": {"model": _llm_model(), "engine": _llm_engine() + " · Vision", "chunks": len(hits)}}

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
        if path == "/api/ai/config":
            # 프런트가 LLM-first 모드 여부를 감지 (키 값 자체는 절대 노출하지 않음)
            return self._json(200, {"provider": "openai" if _llm_first() else "ollama",
                                    "model": _llm_model(), "engine": _llm_engine(),
                                    "llmFirst": _llm_first()})
        if path in _DB_ALL:
            try:
                return self._json(200, _DB_ALL[path]())
            except Exception as e:
                return self._json(500, {"error": "DB_ERROR", "message": str(e)})
        return self._json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/api/rag/search", "/api/rag/answer", "/api/ai/plan", "/api/ai/reset", "/api/ai/chat",
                        "/api/ai/briefing", "/api/ai/vision", "/api/ai/demo-intent", "/api/ai/context"):
            return self._json(404, {"error": "NOT_FOUND"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "BAD_JSON"})

        # 세션 이력 비우기 (새 대화 시작) — query 불필요
        if path == "/api/ai/reset":
            sid = req.get("sessionId")
            if sid:
                with _SESS_LOCK:
                    _SESSIONS.pop(sid, None)
            return self._json(200, {"ok": True, "sessionId": sid})

        if path == "/api/ai/context":
            sid = req.get("sessionId")
            user_msg = (req.get("user") or "").strip()
            assistant_msg = (req.get("assistant") or "").strip()
            if not sid or not user_msg or not assistant_msg:
                return self._json(400, {"error": "INVALID_CONTEXT"})
            _append_history(sid, user_msg, {"message": assistant_msg})
            return self._json(200, {"ok": True, "sessionId": sid, "turns": len(_get_history(sid))})

        # [박람회] 점검 브리핑 대본 — body: {sessionId?}
        if path == "/api/ai/briefing":
            try:
                return self._json(200, make_briefing())
            except Exception as e:
                return self._json(500, {"error": "BRIEFING_ERROR", "message": str(e)})

        # [박람회] 사진 진단 — body: {image(dataURL), message?, currentTag?}
        if path == "/api/ai/vision":
            if not _llm_first():
                return self._json(400, {"error": "VISION_REQUIRES_OPENAI",
                                        "message": "사진 진단은 OpenAI API 연결 시에만 지원됩니다. (.env OPENAI_API_KEY)"})
            image = req.get("image") or ""
            if not image.startswith("data:image"):
                return self._json(400, {"error": "BAD_IMAGE", "message": "image는 data:image/... 형식의 dataURL이어야 합니다."})
            try:
                return self._json(200, make_vision(image, (req.get("message") or "").strip(), req.get("currentTag")))
            except Exception as e:
                return self._json(502, {"error": "VISION_ERROR", "message": str(e)})

        # 상세질문 의도만 LLM으로 분류 — 답변 본문과 UI는 프런트의 검증된 고정 데이터 사용
        if path == "/api/ai/demo-intent":
            message = (req.get("message") or "").strip()
            if not message:
                return self._json(400, {"error": "EMPTY_MESSAGE"})
            try:
                return self._json(200, classify_demo_intent(message, _get_history(req.get("sessionId"))))
            except Exception as e:
                return self._json(502, {"error": "INTENT_LLM_UNAVAILABLE", "message": str(e)})

        # 통합 챗 (LLM+RAG+DB) — body: {sessionId, message, currentTag}
        if path == "/api/ai/chat":
            message = (req.get("message") or "").strip()
            if not message:
                return self._json(400, {"error": "EMPTY_MESSAGE"})
            sid = req.get("sessionId")
            intent = req.get("intent")
            try:
                out = make_chat(message, req.get("currentTag"), _get_history(sid), intent)
            except Exception as e:
                return self._json(500, {"error": "CHAT_ERROR", "message": str(e)})
            # intent 힌트가 있으면 같은 턴에서 plan이 이미 이력을 기록함 → 중복 기록 방지
            if sid and not intent:
                _append_history(sid, message, {"message": out.get("headline", "")})
                out = {**out, "sessionId": sid}
            return self._json(200, out)

        query = (req.get("query") or "").strip()
        if not query:
            return self._json(400, {"error": "EMPTY_QUERY"})

        # action JSON 생성 (LLM) — 벡터검색 불필요
        if path == "/api/ai/plan":
            sid = req.get("sessionId")
            try:
                plan = make_plan(query, req.get("currentTag"), _get_history(sid))
            except Exception as e:
                return self._json(502, {"error": "LLM_UNAVAILABLE", "message": str(e)})
            if sid and plan.get("valid"):
                _append_history(sid, query, plan)
                plan = {**plan, "sessionId": sid}
            return self._json(200, plan)
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
                "model": _llm_model(), "answer": "지침서에서 확인되지 않습니다.", "sources": [], "hits": [],
            })
        try:
            answer = llm_generate(build_answer_prompt(query, hits))
        except Exception as e:
            return self._json(502, {"error": "LLM_UNAVAILABLE", "message": str(e),
                                    "hint": ("OpenAI API 키/네트워크 확인" if _llm_first()
                                             else "ollama 실행 및 %s 모델 확인" % LLM_MODEL)})
        return self._json(200, {
            "query": query, "valveType": valve, "hitCount": len(hits), "grounded": True,
            "model": _llm_model(), "answer": answer,
            "sources": [{"documentName": m["doc"], "section": m["section_path"], "page": m["page"]} for _s, m in hits],
            "hits": [_to_camel(s, m) for s, m in hits],
        })

    def log_message(self, fmt, *args):
        sys.stderr.write("[rag] " + (fmt % args) + "\n")

def main():
    print("RAG 인덱스/모델 로딩...")
    vecs, meta = _ensure_loaded()
    print("준비 완료: %d청크, 모델=%s" % (len(meta), sm.MODEL_NAME))
    print("LLM: %s (%s)" % (_llm_model(), _llm_engine())
          + ("" if _llm_first() else "  ※ OPENAI_API_KEY 설정 시 OpenAI로 전환"))
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("RAG API: http://0.0.0.0:%d  (POST /api/rag/search, GET /health)" % PORT)
    srv.serve_forever()

if __name__ == "__main__":
    main()
