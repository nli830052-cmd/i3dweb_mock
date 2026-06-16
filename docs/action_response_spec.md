# AI Action Response 임시 명세 (1차)

> 솔루션팀 Action 명세 수령 전, AI팀 기준으로 정의한 1차 테스트용 응답 포맷입니다.
> 현재는 `JUMP_TO` / `TAG`만 mock으로 구현하며, 추후 실제 Viewer API 명세 수령 시
> `executeAction` 내부 함수만 교체하는 구조로 진행합니다.

---

## 0. 통신 구조 / 팀 영역

연동에는 **두 종류의 통신**이 있고, 소유 팀이 다릅니다.

| 구간 | 통신 방식 | 소유 팀 | 계약 |
|---|---|---|---|
| Frontend ⇄ AI 백엔드 | HTTP (REST) | **AI팀** | `POST /api/ai/chat` |
| Frontend ⇄ i3DWEB Viewer | 브라우저 내 SDK 호출 | **솔루션팀** | `i3dwebViewer.jumpToTag(...)` 등 |

```
[사용자] → Frontend
            │  (1) POST /api/ai/chat            ── AI팀 (HTTP)
            ▼
        AI 백엔드 ── responseType 분류 + JSON 생성
            │  (2) 200 OK (응답 JSON)            ── AI팀 (HTTP)
            ▼
        Frontend ── responseType 분기
            │  (3) i3dwebViewer.jumpToTag(tag)  ── 솔루션팀 (SDK)
            ▼
        i3DWEB Viewer
            │  (4) callback {ok:...}            ── 솔루션팀 (SDK)
            ▼
        Frontend (화면/로그 갱신)
```

---

## 1. responseType

| 값 | 의미 |
|---|---|
| `ANSWER` | 챗봇 답변만 제공한다. |
| `ACTION` | Viewer 조작만 수행한다. |
| `ANSWER_WITH_ACTION` | 챗봇 답변과 Viewer 조작을 함께 수행한다. |

## 2. action type

1차 확장(설비 찾기/조작)까지 지원하는 액션:

| type | 설명 | 주요 필드 | SDK 매핑 |
|---|---|---|---|
| `JUMP_TO` | 태그 위치로 이동 | `targetType:"TAG"`, `targetValue` | `jumpToTag(tag)` |
| `SEARCH_EQUIPMENT` | 이름/타입으로 설비 검색 | `query` | `searchEquipment(query)` |
| `ROTATE_VIEW` | 시점 회전 | `params:{direction, angle}` | `rotateView(dir, angle)` |
| `HIDE_OBJECT` | 객체 숨김 | `targetType:"TYPE"\|"TAG"`, `targetValue` | `hide({by,value})` |
| `SHOW_OBJECT` | 객체 다시 표시 | `targetType:"TYPE"\|"TAG"\|"ALL"`, `targetValue` | `show({by,value})` |
| `ISOLATE_SYSTEM` | 특정 계통만 표시 | `targetValue`(계통, null이면 현재 선택) | `isolateSystem(system)` |
| `FILTER_BY_TYPE` | 특정 타입만 표시 | `targetValue`(PUMP/VALVE/...) | `filterByType(type)` |

> 액션별 SDK 매핑은 `src/core/actionExecutor.js` 레지스트리에서 관리한다(신규 추가 = register 한 줄).
> `targetType`(TAG/TYPE/ALL), 타입코드(PUMP/VALVE/MOTOR/BEARING/HEATEX/TANK)는 mock 기준.

### 액션 JSON 예시 (1차 확장)
```json
// 검색
{ "type": "SEARCH_EQUIPMENT", "query": "터빈 윤활유 펌프", "params": {} }
// 회전
{ "type": "ROTATE_VIEW", "params": { "direction": "back", "angle": 180 } }
// 타입 숨김
{ "type": "HIDE_OBJECT", "targetType": "TYPE", "targetValue": "VALVE", "params": {} }
// 계통 격리
{ "type": "ISOLATE_SYSTEM", "targetValue": "터빈 윤활유 계통", "params": {} }
// 타입 필터
{ "type": "FILTER_BY_TYPE", "targetValue": "PUMP", "params": {} }
```

## 3. targetType

1차 테스트에서는 `TAG`만 지원한다.

- `TAG` — 설비 Tag 번호 기준으로 대상을 찾는다.

## 4. targetValue

실제 이동 대상 Tag 값. 예: `TG-BRG-002`

## 5. params

확장용 옵션 객체. 1차에서는 빈 객체 `{}`. (추후 zoomLevel, viewMode, highlight 등)

---

## 6. HTTP API 계약 (AI팀 영역)

### 요청 — `POST /api/ai/chat`
```json
{
  "sessionId": "sess-ab12cd",
  "message": "TG-BRG-002 위치로 이동해줘",
  "viewerContext": { "currentTag": null }
}
```
- `viewerContext.currentTag` : 현재 Viewer가 보고 있는 태그(없으면 null). 맥락 활용용.

### 정상 응답 — `200 OK`
```json
{
  "responseType": "ACTION",
  "message": "TG-BRG-002 위치로 이동합니다.",
  "answer": null,
  "actions": [
    {
      "type": "JUMP_TO",
      "targetType": "TAG",
      "targetValue": "TG-BRG-002",
      "params": {}
    }
  ],
  "confidence": 0.95
}
```

### 에러 응답 — `500 Internal Server Error`
```json
{
  "error": "INTERNAL_ERROR",
  "message": "AI 응답 생성 중 오류가 발생했습니다.",
  "requestId": "sess-ab12cd-1718500000000"
}
```
- 프론트는 500 수신 시 챗봇에 오류 메시지를 표시하고 **액션을 실행하지 않는다.**

---

## 7. Viewer SDK 계약 (솔루션팀 영역)

### 호출 (요청)
```js
i3dwebViewer.jumpToTag("TG-BRG-002");
// 내부 인자 구조
{ "method": "jumpToTag",
  "args": { "targetType": "TAG", "targetValue": "TG-BRG-002", "params": {} } }
```

### 성공 콜백
```json
{ "ok": true, "action": "JUMP_TO", "movedTo": "TG-BRG-002", "status": "moved" }
```

### 실패 콜백
```json
{ "ok": false, "action": "JUMP_TO", "error": "TAG_NOT_FOUND",
  "message": "TG-XXX-999 태그를 Viewer에서 찾을 수 없습니다." }
```

---

## 8. 에러 코드 정의

| 코드 | 발생 구간 | 소유 팀 | 의미 |
|---|---|---|---|
| `INTERNAL_ERROR` | HTTP 500 | AI팀 | AI 백엔드 응답 생성 실패 |
| `TAG_NOT_FOUND` | Viewer 콜백 | 솔루션팀 | Viewer에 해당 태그가 없음(미로드/오타) |
| `UNSUPPORTED_ACTION` | Frontend 디스패치 | (공통) | 정의되지 않은 action type 수신 |

> mock 기준: Mock Viewer가 로드한 것으로 간주하는 태그 목록(`KNOWN_TAGS`)에 없는 값으로 JUMP_TO 시 `TAG_NOT_FOUND` 반환.
> 예시 로드 태그: TG-BRG-002 / TG-PMP-101 / TG-VLV-205 / TG-MOT-310 / TG-TNK-007

---

## 9. 연동 구조 / 교체 지점

```js
function jumpToTarget(targetType, targetValue, params) {
  // 1차(mock):
  if (!KNOWN_TAGS.has(targetValue)) {
    return { ok: false, error: "TAG_NOT_FOUND", message: `${targetValue} ...` };
  }
  console.log(`[MOCK] ${targetType}: ${targetValue} 이동`);
  return { ok: true, movedTo: targetValue, status: "moved" };

  // 실제 API 수령 시: 위 mock 대신
  // return i3dwebViewer.jumpToTag(targetValue);
}
```

---

## 10. 솔루션팀 공유 메시지(초안)

> 솔루션팀 Action 명세가 나오기 전까지 우선 AI팀 기준으로 1차 테스트용 응답 포맷을 임시 정의해 진행합니다.
> 현재 범위는 responseType 3종(ANSWER / ACTION / ANSWER_WITH_ACTION)과 JUMP_TO 1개 액션입니다.
> AI는 사용자 자연어를 분석해 `POST /api/ai/chat` 응답 JSON을 반환하고(AI팀 영역),
> 프론트에서는 responseType·actions 값을 기준으로 Viewer SDK(`jumpToTag`)를 호출하는 구조입니다(솔루션팀 영역).
> 정상/에러(500, TAG_NOT_FOUND) 응답 포맷까지 임시 정의해 두었으니, 실제 Viewer API·에러 코드 체계를 주시면
> `executeAction` 내부와 에러 매핑만 교체해 연동하겠습니다.
