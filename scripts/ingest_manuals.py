# -*- coding: utf-8 -*-
"""
유지보수 절차서(PDF) → 섹션 기반 청크(JSON) 변환.  [RAG 1단계: 파싱 + 청킹]

- PyMuPDF로 텍스트 추출 (한글 OK, OCR 불필요)
- 페이지 반복 헤더/푸터 제거
- 번호 체계(1.0 / 6.3.4 / 8.1.1)로 섹션 단위 분리
- 섹션 경로(빵부스러기) + 메타데이터(valve_type 등) 부착
- 너무 작은 항목은 형제끼리 병합, 너무 큰 항목은 오버랩 분할
- 임베딩 전에 청크 품질을 눈으로 확인하는 용도

usage:  python scripts/ingest_manuals.py
out:    data/manual_chunks.json  (+ 콘솔 미리보기)
"""
import fitz, re, json, os, glob, html

MANUAL_DIR = "유지보수메뉴얼"
OUT_PATH = "data/manual_chunks.json"

MIN_CHARS = 200   # 이보다 작은 청크는 형제와 병합 시도
MAX_CHARS = 900   # 이보다 큰 청크는 분할
OVERLAP = 80      # 분할 시 겹침(자)

HEADING = re.compile(r'^(\d+(?:\.\d+)*)\s+(\S.*)$')   # "8.1.1 분해 전 준비"

def valve_type_of(fname):
    n = fname.lower()
    if "gate" in n:
        return "gate"
    if "globe" in n or "glove" in n:   # 'glove'는 globe 오타 허용
        return "globe"
    if "pump" in n or "펌프" in n:
        return "pump"
    return "unknown"

def clean_html(text):
    """ChatGPT 복사 시 딸려온 HTML(pre/span/br) 제거 → 순수 텍스트."""
    t = re.sub(r'<br\s*/?>', '\n', text)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    t = re.sub(r'[ \t]+\n', '\n', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()

def doc_id_of(fname):
    m = re.search(r'표준-(\d+)', fname)
    return ("절차-표준-" + m.group(1)) if m else os.path.basename(fname)

def is_noise(line):
    s = line.strip()
    if not s:
        return True
    if s in ("유지보수절차서", "절차서 No.", "개정번호", "01"):
        return True
    if s.startswith("유지보수절차-표준-"):
        return True
    if re.match(r'^(Gate|Globe)\s*Valve\s*정비$', s, re.I):
        return True
    return False

def norm_num(num):
    """'8.0' -> '8' (대분류 통일), 그 외는 그대로."""
    return num[:-2] if num.endswith(".0") else num

def prefixes(num):
    """'8.1.1' -> ['8','8.1','8.1.1']"""
    parts = num.split(".")
    return [".".join(parts[:i]) for i in range(1, len(parts) + 1)]

def extract_items(doc):
    """PDF -> [{num, title, body, page}] (번호 항목 단위)"""
    # 1) 노이즈 제거한 (line, page) 수집
    lines = []
    for pno, page in enumerate(doc, start=1):
        for raw in page.get_text().splitlines():
            if not is_noise(raw):
                lines.append((raw.rstrip(), pno))

    # 2) 헤딩 기준으로 항목 분리
    items, cur = [], None
    for text, pno in lines:
        m = HEADING.match(text.strip())
        if m:
            if cur:
                items.append(cur)
            num = norm_num(m.group(1))
            cur = {"num": num, "title": m.group(2).strip(), "body": [], "page": pno}
        elif cur:
            cur["body"].append(text.strip())
        # 헤딩 이전의 본문(표지 등)은 버림
    if cur:
        items.append(cur)
    return items

def build_chunks(items, valve_type, doc_id, valve_label):
    # 섹션 제목 사전 (경로 구성용)
    titles = {it["num"]: it["title"] for it in items}

    def section_path(num):
        segs = []
        for p in prefixes(num):
            t = titles.get(p, "")
            segs.append((p + " " + t).strip())
        return " > ".join(segs)

    # 항목 -> 1차 청크(헤딩+본문)
    base = []
    for it in items:
        body = " ".join(x for x in it["body"] if x).strip()
        head = it["num"] + " " + it["title"]
        base.append({
            "num": it["num"], "head": head, "path": section_path(it["num"]),
            "page": it["page"], "body": body,
            "text_len": len(head) + len(body)
        })

    # 작은 형제 병합 (같은 부모 prefix 연속)
    def parent(num):
        return ".".join(num.split(".")[:-1]) or num

    merged, buf = [], None
    for b in base:
        if buf is None:
            buf = dict(b); buf["heads"] = [b["head"]]; continue
        same_parent = parent(buf["num"]) == parent(b["num"])
        if buf["text_len"] < MIN_CHARS and same_parent and (buf["text_len"] + b["text_len"]) <= MAX_CHARS:
            buf["body"] = (buf["body"] + " " + b["head"] + " " + b["body"]).strip()
            buf["heads"].append(b["head"])
            buf["text_len"] += b["text_len"]
        else:
            merged.append(buf); buf = dict(b); buf["heads"] = [b["head"]]
    if buf:
        merged.append(buf)

    # 큰 청크 분할 + 최종 포맷
    chunks = []
    for m in merged:
        crumb = "[" + valve_label + " > " + m["path"] + "]"
        full = m["head"] + "\n" + m["body"] if m["body"] else m["head"]
        parts = split_text(full, MAX_CHARS, OVERLAP)
        for i, ptxt in enumerate(parts):
            suffix = "" if len(parts) == 1 else "#p%d" % (i + 1)
            chunks.append({
                "id": doc_id + "#" + m["num"] + suffix,
                "valve_type": valve_type,
                "doc": doc_id,
                "section_no": m["num"],
                "section_path": m["path"],
                "page": m["page"],
                "revision": "01",
                "heading": m["head"],
                "text": crumb + "\n" + ptxt,
                "n_chars": len(crumb) + 1 + len(ptxt)
            })
    return chunks

def process_md(path):
    """보충 표준 .md (권장 주기/교체 기준 등) → 헤딩(#~###) 섹션 단위 청크."""
    raw = open(path, encoding="utf-8").read()
    if not raw.strip():
        return [], 0   # 빈 파일
    text = clean_html(raw)
    fname = os.path.basename(path)
    vt = valve_type_of(fname)
    vlabel = ("Gate" if vt == "gate" else "Globe" if vt == "globe" else "Centrifugal Pump" if vt == "pump" else "?") + " 보충기준"
    doc = os.path.splitext(fname)[0]

    # H2 제목(있으면) + 헤딩(#/##/###) 섹션 분리
    h2 = ""
    mh2 = re.search(r'(?m)^##\s+(.+)$', text)
    if mh2:
        h2 = mh2.group(1).strip()
    secs = list(re.finditer(r'(?m)^#{1,4}\s+(.+)$', text))
    chunks = []
    for i, m in enumerate(secs):
        title = m.group(1).strip()
        start = m.end()
        end = secs[i + 1].start() if i + 1 < len(secs) else len(text)
        body = text[start:end].strip().strip("-").strip()
        if not body:
            continue   # 본문 없는 상위 컨테이너 헤더(예: '# 10.0 …')는 스킵
        msec = re.match(r'^(\d+(?:\.\d+)*)', title)   # '10.2' 같은 점 포함 번호 보존(중복 id 방지)
        sec_no = msec.group(1) if msec else str(i + 1)
        path_str = title   # 인용 경로는 섹션 제목만(예: '19.2 고소작업 판단 기준')
        crumb = "[%s > %s]" % (vlabel, title)
        full = title + "\n" + body
        for j, ptxt in enumerate(split_text(full, MAX_CHARS, OVERLAP)):
            suffix = "" if j == 0 else "#p%d" % (j + 1)
            chunks.append({
                "id": doc + "#md" + sec_no + suffix,
                "valve_type": vt, "doc": doc,
                "section_no": "보충 " + sec_no, "section_path": path_str,
                "page": None, "revision": "추가",
                "heading": title,
                "text": crumb + "\n" + ptxt,
                "n_chars": len(crumb) + 1 + len(ptxt)
            })
    return chunks, len(secs)

def split_text(text, max_chars, overlap):
    if len(text) <= max_chars:
        return [text]
    out, start = [], 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        out.append(text[start:end])
        if end == len(text):
            break
        start = end - overlap
    return out

def main():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    all_chunks = []
    files = sorted(glob.glob(os.path.join(MANUAL_DIR, "*.pdf")))
    print("발견된 PDF: %d개\n" % len(files))
    for f in files:
        fname = os.path.basename(f)
        vt = valve_type_of(fname)
        did = doc_id_of(fname)
        vlabel = ("Gate" if vt == "gate" else "Globe" if vt == "globe" else "Centrifugal Pump" if vt == "pump" else "?") + " 정비"
        doc = fitz.open(f)
        items = extract_items(doc)
        chunks = build_chunks(items, vt, did, vlabel)
        if not chunks:
            print("=" * 70)
            print("%s  (valve=%s, doc=%s, pages=%d) - 0 chunks, skipped" % (fname, vt, did, doc.page_count))
            continue
        all_chunks.extend(chunks)
        sizes = [c["n_chars"] for c in chunks]
        print("=" * 70)
        print("%s  (valve=%s, doc=%s, pages=%d)" % (fname, vt, did, doc.page_count))
        print("  항목 %d → 청크 %d개 | 크기 min/avg/max = %d/%d/%d자"
              % (len(items), len(chunks), min(sizes), sum(sizes) // len(sizes), max(sizes)))

    # 보충 .md 표준 문서
    for f in sorted(glob.glob(os.path.join(MANUAL_DIR, "*.md"))):
        fname = os.path.basename(f)
        chunks, nsec = process_md(f)
        print("=" * 70)
        if not chunks:
            print("%s  ⚠ 비어 있음(0바이트) → 스킵. 내용 추가 필요." % fname)
            continue
        all_chunks.extend(chunks)
        sizes = [c["n_chars"] for c in chunks]
        print("%s  (valve=%s)" % (fname, valve_type_of(fname)))
        print("  섹션 %d → 청크 %d개 | 크기 min/avg/max = %d/%d/%d자"
              % (nsec, len(chunks), min(sizes), sum(sizes) // len(sizes), max(sizes)))

    with open(OUT_PATH, "w", encoding="utf-8") as fp:
        json.dump(all_chunks, fp, ensure_ascii=False, indent=2)
    print("\n저장: %s (총 청크 %d개)" % (OUT_PATH, len(all_chunks)))

    # 미리보기: 핵심 섹션 샘플
    print("\n" + "#" * 70 + "\n# 청크 샘플 미리보기\n" + "#" * 70)
    want = ["8.1.1", "8.2.2", "6.3.4", "5.1"]
    shown = 0
    for c in all_chunks:
        if c["valve_type"] == "globe" and any(c["section_no"].startswith(w) for w in want):
            print("\n--- id=%s | page=%d | %d자 ---" % (c["id"], c["page"], c["n_chars"]))
            print(c["text"][:500])
            shown += 1
            if shown >= 4:
                break

if __name__ == "__main__":
    main()
