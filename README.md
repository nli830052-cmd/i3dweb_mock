# RAG 챗봇 파이썬 구동 방법

`backend/rag_server.py` — 로컬 LLM + 매뉴얼 벡터검색(RAG) + 정형 DB 조회를 합쳐
챗봇 응답을 생성하는 파이썬 API 서버입니다. 프런트(`src/ai/ragClient.js`)가
기본적으로 AI팀 데스크톱 서버 주소(`http://192.168.0.210:8090`)로 호출하도록 설정되어 있습니다.

> 용어: **RAG**(Retrieval-Augmented Generation) = 문서에서 관련 내용을 *검색(Retrieval)* 해
> 그 근거만으로 LLM이 *답변 생성(Generation)* 하는 방식. 환각(없는 사실 지어내기)을 줄이는 구조입니다.

---

## 1. 사전 준비물

| 구분          | 항목                                                      | 비고                                                                       |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| 언어          | Python 3.10+                                              | 3.10.11에서 검증                                                           |
| 파이썬 패키지 | `numpy`, `sentence-transformers`(+torch), `PyMuPDF` | `backend/requirements.txt`                                               |
| 임베딩 모델   | `BAAI/bge-m3`                                           | 최초 실행 시 자동 다운로드(~2GB)                                           |
| LLM 런타임    | **Ollama** (https://ollama.com)                     | `http://localhost:11434`                                                 |
| LLM 모델      | `qwen3.5:9b`                                            | `ollama pull` 필요 · `rag_server.py`의 `LLM_MODEL` 값과 일치해야 함 |

> 💡 **RAG 인덱스 및 DB 포함 안내:**
> RAG 인덱스와 DB(`data/` 폴더)는 현재 Git 저장소에 함께 업로드되어 있습니다.
> 따라서 최초 실행 시 별도로 데이터를 빌드할 필요 없이 바로 서버를 실행할 수 있습니다.

---

## 2. 설치

```bash
# (권장) 가상환경
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# (참고) bash/macOS:  source .venv/bin/activate

# 파이썬 패키지
pip install -r backend/requirements.txt

# LLM 런타임/모델 (Ollama 설치 후)
ollama pull qwen3.5:9b
```

---

## 3. 데이터 빌드 (매뉴얼 원본 변경 시에만 실행)

모든 명령은 **프로젝트 루트**(`i3dweb_mock/`)에서 실행합니다. 경로가 상대경로라 루트 기준이어야 합니다.

```bash
# (권장) 가상환경
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# (참고) bash/macOS:  source .venv/bin/activate

# 파이썬 패키지
pip install -r backend/requirements.txt

# LLM 런타임/모델 (Ollama 설치 후)
ollama pull qwen3.5:9b
```

생성 결과(`data/`):

| 파일                       | 만든 스크립트         | 용도                            |
| -------------------------- | --------------------- | ------------------------------- |
| `app.db`                 | `build_db.py`       | 정비이력·공간·작업오더 SQLite |
| `manual_chunks.json`     | `ingest_manuals.py` | 절차서 청크(중간 산출물)        |
| `manual_index.npy`       | `embed_chunks.py`   | 청크 임베딩 벡터                |
| `manual_index.meta.json` | `embed_chunks.py`   | 청크 메타데이터                 |

---

## 4. 서버 실행

```bash
# (권장) 가상환경
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# (참고) bash/macOS:  source .venv/bin/activate

# 파이썬 패키지
pip install -r backend/requirements.txt

# LLM 런타임/모델 (Ollama 설치 후)
ollama pull qwen3.5:9b
```

정상 기동 로그:

```bash
# (권장) 가상환경
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# (참고) bash/macOS:  source .venv/bin/activate

# 파이썬 패키지
pip install -r backend/requirements.txt

# LLM 런타임/모델 (Ollama 설치 후)
ollama pull qwen3.5:9b
```

헬스 체크 (솔루션팀 PC 등 외부에서 테스트 시 자신의 IP 사용):

```bash
# (권장) 가상환경
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# (참고) bash/macOS:  source .venv/bin/activate

# 파이썬 패키지
pip install -r backend/requirements.txt

# LLM 런타임/모델 (Ollama 설치 후)
ollama pull qwen3.5:9b
```

---

## 5. 엔드포인트 (프런트가 호출하는 API)

| 메서드 · 경로           | 요청 body                              | 호출 위치(프런트)                             |
| ------------------------ | -------------------------------------- | --------------------------------------------- |
| `GET  /health`         | —                                     | 상태 확인                                     |
| `POST /api/ai/chat`    | `{message, currentTag?, sessionId?}` | `RagClient.chat()` — 통합 답변(LLM+RAG+DB) |
| `POST /api/ai/plan`    | `{query, currentTag?}`               | `RagClient.plan()` — action JSON 생성      |
| `POST /api/ai/reset`   | `{sessionId}`                        | 세션 대화이력 초기화                          |
| `POST /api/rag/search` | `{query, valveType?, topK?}`         | `RagClient.search()` — 청크 검색만         |
| `POST /api/rag/answer` | `{query, valveType?, topK?}`         | `RagClient.answer()` — 검색+LLM 종합       |

- **CORS**: 브라우저 mock(`file://`)에서 호출 가능하도록 `*` 허용.
- **세션**: 프런트는 `sessionId`만 전달, 대화 이력은 서버가 보관(최근 6턴, 1시간 TTL).
- **포트**: `8090` (8000=다른 챗봇 / 11434=Ollama 회피). `rag_server.py`의 `PORT` 상수.

---

## 6. 클라이언트 호출 주소 설정

프런트엔드의 호출 주소는 다음과 같이 `src/ai/ragClient.js`에 설정되어 있습니다.
(AI팀 오픈 주소인 `192.168.0.210`이 기본으로 반영되어 있습니다.)

```bash
# (권장) 가상환경
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# (참고) bash/macOS:  source .venv/bin/activate

# 파이썬 패키지
pip install -r backend/requirements.txt

# LLM 런타임/모델 (Ollama 설치 후)
ollama pull qwen3.5:9b
```

솔루션팀은 별도의 코드 수정 없이 그대로 `git pull`을 받아 사용하시면 됩니다. 만약 배포 환경 등에서 서버 주소가 변경된다면 `window.AI_SERVER_BASE_URL` 전역 변수를 주입하여 코드를 수정하지 않고 유연하게 변경할 수 있습니다.

---

## 7. 자주 나는 문제

| 증상                               | 원인 / 조치                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| 서버 시작 시 인덱스 로드 실패      | `data/manual_index.*` 파일 누락 여부 확인 (`git pull` 정상 완료되었는지 확인) |
| 답변이`LLM_UNAVAILABLE`(502)     | Ollama 미실행 또는 모델 없음 →`ollama pull qwen3.5:9b`, Ollama 기동 확인       |
| 프런트는 뜨는데 근거형 답변이 mock | 서버 미가동 → 프런트가 자동으로 규칙기반(브라우저)으로 폴백한 상태               |
| `fitz` import 에러               | `pip install PyMuPDF` (인덱스 생성 시에만 필요)                                 |
| 최초 실행이 매우 느림              | bge-m3(~2GB) 최초 다운로드 중 — 1회성                                            |
