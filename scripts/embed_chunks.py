# -*- coding: utf-8 -*-
"""
청크(JSON) → bge-m3 임베딩 → 경량 인덱스 저장.  [RAG 2단계: 임베딩]

- i3dweb_chatbot과 동일 모델: BAAI/bge-m3 (로컬, L2 정규화 → cosine=dot)
- chroma 없이 numpy(.npy) + 메타(.json)로 저장 (코퍼스 작아 flat 검색 충분)

usage:  python scripts/embed_chunks.py
in:     data/manual_chunks.json
out:    data/manual_index.npy (벡터), data/manual_index.meta.json (메타)
"""
import json, os
import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_NAME = "BAAI/bge-m3"     # i3dweb_chatbot과 동일
CHUNKS = os.path.join(_ROOT, "data", "manual_chunks.json")
VEC_OUT = os.path.join(_ROOT, "data", "manual_index.npy")
META_OUT = os.path.join(_ROOT, "data", "manual_index.meta.json")
META_KEYS = ("id", "valve_type", "doc", "section_no", "section_path", "page", "revision", "heading", "text")

def main():
    chunks = json.load(open(CHUNKS, encoding="utf-8"))
    texts = [c["text"] for c in chunks]
    print("청크 %d개 임베딩 시작 (모델 %s, 최초 1회 ~2GB 다운로드)..." % (len(texts), MODEL_NAME))

    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL_NAME)
    emb = model.encode(texts, batch_size=16, normalize_embeddings=True, show_progress_bar=True)
    emb = np.asarray(emb, dtype=np.float32)

    np.save(VEC_OUT, emb)
    meta = [{k: c.get(k) for k in META_KEYS} for c in chunks]
    json.dump(meta, open(META_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print("완료 → %s %s | %s (%d개)" % (VEC_OUT, emb.shape, META_OUT, len(meta)))

if __name__ == "__main__":
    main()
