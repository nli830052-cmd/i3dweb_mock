# 전체 디렉토리 & 파일별 역할 및 담당 팀 구분

이 문서는 i3DWEB 챗봇 연동 프로젝트의 디렉토리 구조와 파일별 역할, 그리고 각 담당 팀(AI팀 / 솔루션팀)의 영역을 정리한 문서입니다.

---

## 1. 🤖 AI팀 영역 (지능형 서비스 및 백엔드)
자연어 분석, LLM 백엔드, RAG 검색, 정비 데이터베이스(CMMS) 등을 담당하는 폴더들입니다.

* **`backend/`** (백엔드 서버 폴더)
  * **[rag_server.py](file:///C:/lyn/i3dweb_mock/backend/rag_server.py)**: 로컬 LLM 및 벡터 검색을 실행하는 파이썬 서버
* **`src/ai/`** (AI 연동 폴더)
  * **[classifier.js](file:///C:/lyn/i3dweb_mock/src/ai/classifier.js)**: 자연어 의도 분석 및 규칙 검사기 (키워드 매핑)
  * **[ragClient.js](file:///C:/lyn/i3dweb_mock/src/ai/ragClient.js)**: AI 백엔드 서버와 통신하는 API 클라이언트
  * **[maintenanceDb.js](file:///C:/lyn/i3dweb_mock/src/ai/maintenanceDb.js)**: 모의 정비이력(CMMS) 상태 DB
  * **[workflowDb.js](file:///C:/lyn/i3dweb_mock/src/ai/workflowDb.js)**: 모의 작업오더(WO) 상태 DB

---

## 2. 🖥️ 솔루션팀 영역 (3D 화면 제어 및 공간 정보)
3D 플랜트 디지털 트윈 화면을 조작하고 3D 공간의 측량 정보를 담당하는 폴더입니다.

* **`src/viewer/`** (3D 뷰어 관련 폴더)
  * **[mockViewer.js](file:///c:/lyn/i3dweb_mock/src/viewer/mockViewer.js)**: 3D Viewer SDK 인터페이스 및 실제 이동/회전/숨김 수행 본체
  * **[spatialDb.js](file:///c:/lyn/i3dweb_mock/src/viewer/spatialDb.js)**: Walkinside 공간 데이터(높이, 주변 추락 위험 공간 등) 모의 DB

---

## 3. 🌉 두 팀의 교차점 (Frontend 및 연동 코어)
AI팀의 분석 결과와 솔루션팀의 3D 기능을 서로 이어주는 공통 영역입니다.

* **`src/core/`** (통역사 폴더)
  * **[actionExecutor.js](file:///c:/lyn/i3dweb_mock/src/core/actionExecutor.js)**: AI의 액션 명령을 솔루션팀 3D 함수(ViewerSDK)로 번역해주는 파일
* **`src/ui/`** (메인 UI 폴더)
  * **[app.js](file:///c:/lyn/i3dweb_mock/src/ui/app.js)**: 챗봇 UI 화면 구성 및 대화 흐름 중개
  * **[styles.css](file:///c:/lyn/i3dweb_mock/src/ui/styles.css)**: 화면 레이아웃 및 디자인 CSS 파일

---

## 💡 협업 가이드 요약
각 팀이 집중해야 할 폴더가 확실히 나누어져 있어, 협업할 때 **AI팀은 `src/ai/`와 `backend/` 폴더**만 신경 쓰고, **솔루션팀은 `src/viewer/` 폴더**만 빌드해서 전달해주면 되는 매우 이상적인 아키텍처 구조입니다.
