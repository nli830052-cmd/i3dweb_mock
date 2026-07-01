# -*- coding: utf-8 -*-
"""
매뉴얼 인덱스 코사인 검색 (미리보기/CLI).  [RAG 3단계: 검색]

- bge-m3로 쿼리 임베딩 → 벡터 내적(=cosine, 정규화됨)
- valve_type 필터 + min_score 게이트 (i3dweb_chatbot과 동일 임계값)

usage:
  python scripts/search_manuals.py                      # 샘플 질의 데모
  python scripts/search_manuals.py "그랜드패킹 교체 기준" globe
"""
import json, os, sys
import numpy as np

# 실행 위치(cwd)와 무관하게 repo 루트의 data/ 를 찾도록 스크립트 기준 절대경로 사용
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_NAME = "BAAI/bge-m3"
VEC = os.path.join(_ROOT, "data", "manual_index.npy")
META = os.path.join(_ROOT, "data", "manual_index.meta.json")
TOP_K = 5
MIN_SCORE = 0.30   # i3dweb_chatbot 동일

_model = None
def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME)
    return _model

def load_index():
    return np.load(VEC), json.load(open(META, encoding="utf-8"))

def search(query, vecs, meta, valve_type=None, top_k=TOP_K, min_score=MIN_SCORE):
    q = _get_model().encode([query], normalize_embeddings=True)[0].astype(np.float32)
    sims = vecs @ q                       # 정규화됨 → 내적 = cosine
    order = np.argsort(-sims)
    hits = []
    for i in order:
        if valve_type and meta[i]["valve_type"] != valve_type:
            continue
        score = float(sims[i])
        if score < min_score:
            break                          # 정렬돼 있으니 이하 전부 탈락
        hits.append((score, meta[i]))
        if len(hits) >= top_k:
            break
    return hits

def _demo():
    vecs, meta = load_index()
    samples = [
        ("그랜드패킹 교체 기준 알려줘", "globe"),
        ("정비 주기가 어떻게 돼?", "gate"),
        ("분해 전 준비 절차", "globe"),
        ("밸브 시트 누설 시 조치", "gate"),
        ("2m 이상 고소작업 안전조치", "globe"),
    ]
    for q, vt in samples:
        print("\n" + "=" * 72)
        print("Q: %s   (valve=%s)" % (q, vt))
        for score, m in search(q, vecs, meta, valve_type=vt):
            src = "보충md" if m.get("revision") == "추가" else "PDF"
            print("  [%.3f] %-6s %s | p.%s | %s" % (score, src, m["id"], m["page"], m["heading"][:42]))
    print()

if __name__ == "__main__":
    if len(sys.argv) >= 2:
        vecs, meta = load_index()
        q = sys.argv[1]
        vt = sys.argv[2] if len(sys.argv) >= 3 else None
        for score, m in search(q, vecs, meta, valve_type=vt):
            print("[%.3f] %s | p.%s\n   %s\n" % (score, m["id"], m["page"], m["text"][:240]))
    else:
        _demo()
