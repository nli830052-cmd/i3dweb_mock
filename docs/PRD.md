# PRD — i3DWEB AI Action 연동 1차 데모

| 항목 | 내용 |
|---|---|
| 문서명 | i3DWEB AI Viewer Action 연동 1차 테스트 PRD |
| 작성자 | AI팀 (김린) |
| 작성일 | 2026-06-16 |
| 데모 목표일 | 2026-06-25 |
| 상태 | Draft (솔루션팀 Action 명세 미수령) |

---

## 1. 배경 / 문제 정의

원래 역할 분담은 다음과 같았다.

- **솔루션팀 / Viewer팀**: Viewer가 받을 수 있는 action 명세 정의(JUMP_TO, HIGHLIGHT, SHOW_POPUP 등) 및 실제 Viewer API 함수 제공
- **AI팀 / 김린**: 사용자 자연어 해석 → `responseType` 분류 → action JSON 생성 → Viewer로 전달

그러나 현재 솔루션팀의 Action 명세 및 실제 Viewer API가 전달되지 않아 AI팀 작업이 블로킹된 상태다.

**해결 방향:** 솔루션팀을 기다리지 않고, AI팀이 **임시 Action 명세를 직접 정의**하고 **실제 Viewer가 없어도 검증 가능한 Mock Viewer**를 만들어 연동 구조를 먼저 완성한다.

---

## 2. 목표 (1차 범위)

> 사용자가 채팅창에 명령을 입력하면 AI가 응답 타입(`responseType`)을 판단하고, `JUMP_TO` 액션 JSON을 생성한 뒤, 테스트 페이지에서 해당 액션이 Mock Viewer에서 실행되는 흐름을 보여준다.

이 단계의 핵심 산출물은 **"실제 Viewer 연동 완성"이 아니라 "Viewer 연동이 가능한 AI 응답 구조 + 테스트 페이지"** 이다.

### 비목표 (1차에서 하지 않음)
- 실제 i3DWEB Viewer 연동
- JUMP_TO 외 모든 Action 타입 정의
- 실제 설비 DB 연동 / 문서 RAG 연동
- 정비 절차 정확 답변, 복잡한 화면 제어

---

## 3. 핵심 설계 원칙

**AI 응답 생성과 Viewer 실행을 분리한다.**

- ❌ 나쁜 구조: AI가 직접 Viewer API 호출
- ✅ 좋은 구조: AI는 JSON만 생성 → 프론트/중계 레이어가 JSON을 보고 Viewer API 호출

```
AI 역할       : 자연어 → 의도 분류 → JSON 생성
Frontend 역할 : JSON 확인 → responseType 분기 → actionExecutor 호출
Viewer 역할   : actionExecutor가 호출한 실제 화면 조작 수행
```

이 분리 덕분에 추후 Viewer API가 바뀌어도 AI 쪽은 크게 바꾸지 않아도 된다. 실제 연동 시 `jumpToTarget()` 내부만 교체한다.

---

## 4. 표준 정의

### 4-1. responseType (3종 고정)

| 값 | 의미 | 사용자 입력 예 |
|---|---|---|
| `ANSWER` | 챗봇 답변만 필요 | "TG-BRG-002가 어떤 설비야?" |
| `ACTION` | Viewer 조작만 필요 | "TG-BRG-002로 이동해줘." |
| `ANSWER_WITH_ACTION` | 답변 + Viewer 조작 둘 다 | "TG-BRG-002로 이동하고 점검 절차도 알려줘." |

### 4-2. 공통 응답 JSON

```json
{
  "responseType": "ACTION",
  "message": "사용자에게 보여줄 메시지",
  "answer": null,
  "actions": [
    {
      "type": "JUMP_TO",
      "targetType": "TAG",
      "targetValue": "TG-BRG-002",
      "params": {}
    }
  ],
  "confidence": 0.92
}
```

| 필드 | 설명 |
|---|---|
| `responseType` | 답변/액션/둘 다 구분 |
| `message` | 채팅창에 보여줄 짧은 안내 문구 |
| `answer` | 실제 답변 내용 (ACTION일 때 null 가능) |
| `actions` | Viewer가 실행할 액션 목록 |
| `confidence` | AI 판단 확신도 (디버깅용, 초기엔 선택) |

### 4-3. Action (1차: JUMP_TO 하나만)

| 필드 | 1차 허용값 | 설명 |
|---|---|---|
| `type` | `JUMP_TO` | 동작 종류 |
| `targetType` | `TAG` | 이동 기준 |
| `targetValue` | 예: `TG-BRG-002` | 실제 태그 값 |
| `params` | `{}` | 확장용 (zoomLevel, viewMode, highlight 등 추후) |

---

## 5. 기능 요구사항

| ID | 요구사항 | 우선순위 |
|---|---|---|
| F-1 | 사용자 채팅 입력창 + Send 버튼 | 필수 |
| F-2 | 자연어 → responseType 분류 | 필수 |
| F-3 | 응답 JSON 생성 (공통 스키마) | 필수 |
| F-4 | responseType 분기 로직 | 필수 |
| F-5 | JUMP_TO action 파싱 + executeAction 디스패치 | 필수 |
| F-6 | mock JUMP_TO 함수 (jumpToTarget) | 필수 |
| F-7 | Action 실행 로그 출력 | 필수 |
| F-8 | Mock Viewer 영역 (현재 TAG / 상태 표시) | 필수 |
| F-9 | JSON 응답 표시 영역 | 필수 |
| F-10 | 챗봇 답변 표시 영역 | 필수 |
| F-11 | API 흐름 패널 (요청/응답 시퀀스 + 팀 영역 표시) | 필수 |
| F-12 | 에러 케이스 처리 (HTTP 500 / Viewer 실패 콜백) | 필수 |

### 분류 로직 (1차 mock 기준)
- 태그 추출: 정규식 `[A-Z]{2,}-[A-Z]{2,}-\d+` (예: TG-BRG-002)
- ACTION 의도어: 이동/찾아/보여/선택/위치로 ... (+ 태그 존재 시)
- ANSWER 의도어: 뭐야/어떤/알려/절차/방법/의미/원인/왜/어떻게 ...
- 둘 다 → `ANSWER_WITH_ACTION`, 액션만 → `ACTION`, 그 외 → `ANSWER`

---

## 6. 화면 구성

```
[i3DWEB AI Action Test Page]
1. 사용자 입력창 + [Send] / 예시 버튼(정상 + 에러 케이스)
2. API 흐름 패널 (요청/응답 시퀀스, 팀 영역 칩, payload 펼침)
3. 챗봇 응답 영역
4. AI 응답 JSON 영역
5. Action 실행 로그
6. Mock Viewer 영역 (현재 선택된 TAG / 상태: moved | failed)
```

실제 3D Viewer 없이 오른쪽 박스로 `현재 위치: TG-BRG-002 / 상태: JUMP_TO executed` 표시.
실패 시 빨간 상태 + shake로 구분.

---

## 7. 통신 구조 / 팀 영역

연동에는 두 종류 통신이 있고, 소유 팀이 다르다. API 흐름 패널은 각 단계에 팀 칩을 표시한다.

| 구간 | 통신 | 소유 팀 | 계약 |
|---|---|---|---|
| Frontend ⇄ AI 백엔드 | HTTP | **AI팀** | `POST /api/ai/chat` |
| Frontend ⇄ i3DWEB Viewer | SDK 호출 | **솔루션팀** | `i3dwebViewer.jumpToTag(...)` |

### 처리 흐름 (정상)
```
(1) Frontend → AI 백엔드   POST /api/ai/chat            [AI팀/HTTP]
(2) AI 백엔드 → Frontend   200 OK (응답 JSON)            [AI팀/HTTP]
    └ responseType 분기
(3) Frontend → Viewer      i3dwebViewer.jumpToTag(tag)  [솔루션팀/SDK]  ← ACTION 계열만
(4) Viewer → Frontend      callback {ok:true,...}        [솔루션팀/SDK]
    └ (현재) mock / (추후) 실제 i3DWEB Viewer API
```

> API 계약 상세(요청/응답/콜백 스키마)는 `docs/action_response_spec.md` 참조.

---

## 7-1. 에러 처리

| 코드 | 구간 | 소유 팀 | 동작 |
|---|---|---|---|
| `INTERNAL_ERROR` (HTTP 500) | AI 백엔드 응답 | AI팀 | 챗봇에 오류 표시, 액션 미실행 |
| `TAG_NOT_FOUND` | Viewer 콜백 | 솔루션팀 | Viewer 실패 상태(빨강) + 로그 실패 표기 |
| `UNSUPPORTED_ACTION` | Frontend 디스패치 | 공통 | 미지원 action type 경고 |

> mock 기준: Viewer 로드 태그 목록(`KNOWN_TAGS`)에 없는 태그로 JUMP_TO 시 `TAG_NOT_FOUND`.
> 예: TG-BRG-002 / TG-PMP-101 / TG-VLV-205 / TG-MOT-310 / TG-TNK-007

---

## 8. 데모 시나리오 (6/25)

| # | 입력 | 기대 결과 |
|---|---|---|
| 데모1 ACTION | "TG-BRG-002 위치로 이동해줘" | responseType=ACTION, JUMP_TO 실행, Mock Viewer 위치=TG-BRG-002 |
| 데모2 ANSWER | "TG-BRG-002가 어떤 설비야?" | responseType=ANSWER, 챗봇 답변만, Viewer 동작 없음 |
| 데모3 둘 다 | "TG-BRG-002로 이동하고 점검 절차도 알려줘" | responseType=ANSWER_WITH_ACTION, 답변 출력 + JUMP_TO 실행 |
| 데모4 Viewer 실패 | "TG-XXX-999로 이동해줘" | 200 OK → Viewer 콜백 `TAG_NOT_FOUND`, Viewer 빨간 상태 |
| 데모5 백엔드 에러 | (백엔드 500 버튼) | HTTP 500 `INTERNAL_ERROR`, 챗봇 오류 표시, 액션 미실행 |

각 데모는 API 흐름 패널에서 단계별 요청/응답 + 팀 영역(AI팀/솔루션팀)으로 확인 가능.

---

## 9. 산출물 / 구조

레이어별로 파일을 분리했다. **파일 1개 = 책임 1개 = 소유 팀 1개** 원칙.

```
i3dweb_mock/
 ├─ index.html                    # 화면 골격(shell) + 모듈 로드만
 ├─ src/
 │   ├─ ai/
 │   │   └─ classifier.js         # [AI팀]   AiBackend — 자연어→responseType/JSON  ★고도화 지점
 │   ├─ viewer/
 │   │   └─ mockViewer.js         # [솔루션팀] ViewerSDK — jumpToTag mock          ★실제 API 교체 지점
 │   ├─ core/
 │   │   └─ actionExecutor.js     # [연결고리] ActionExecutor — type→SDK 매핑       ★신규 action 등록 지점
 │   └─ ui/
 │       ├─ app.js                # [Front] 진입점/오케스트레이션/렌더링/API흐름 패널
 │       └─ styles.css            # 스타일
 ├─ 기획서.md                      # 원본 기획서
 └─ docs/
     ├─ PRD.md                    # 본 문서
     ├─ action_response_spec.md   # 솔루션팀 공유용 임시 명세서
     └─ test_cases.md             # 분류 테스트 케이스
```

> 실행: `index.html` 더블클릭(빌드/서버 불필요). 모듈은 전역 네임스페이스(`window.AiBackend` 등)로 연결 — `file://`에서도 동작.

### 확장 지점 (어디를 건드릴지)
| 하고 싶은 일 | 손댈 파일 | 방법 |
|---|---|---|
| 실제 LLM/RAG 연동, responseType 추가 | `src/ai/classifier.js` | `requestAiResponse()` 본문을 fetch/LLM 호출로 교체 |
| 새 Action 타입(HIGHLIGHT 등) | `src/core/actionExecutor.js` | `ActionExecutor.register("HIGHLIGHT", ...)` 추가 |
| 실제 Viewer SDK 연동 | `src/viewer/mockViewer.js` | `jumpToTag()` 내부를 실제 SDK 호출로 교체 |
| 화면/패널 변경 | `src/ui/app.js`, `styles.css` | 렌더링 함수 수정 |

> 인터페이스(공개 API 시그니처)만 유지하면 한 파일만 바꿔도 나머지는 영향 없음.

---

## 10. 완료 기준 (DoD)

- [x] responseType 3종 분류 동작
- [x] JUMP_TO action JSON 생성
- [x] responseType 분기 → executeAction → mock 실행
- [x] Action 실행 로그 + Mock Viewer 상태 갱신
- [x] API 흐름 패널 (요청/응답 시퀀스 + 팀 영역 표시)
- [x] 에러 케이스 (HTTP 500 / TAG_NOT_FOUND) 처리
- [x] 데모 5종 시나리오 동작 (정상 3 + 에러 2)
- [x] 솔루션팀 공유용 임시 명세서 작성

---

## 11. 리스크 / 가정

| 항목 | 내용 |
|---|---|
| 가정 | 솔루션팀 실제 API 수령 시 `executeAction` 내부 함수만 교체로 연동 가능 |
| 리스크 | 솔루션팀 실제 명세가 본 임시 스키마와 다를 수 있음 → 필드 매핑 레이어 필요 가능성 |
| 완화 | actions를 배열·type 기반으로 설계해 확장 시 케이스 추가만으로 대응 |
