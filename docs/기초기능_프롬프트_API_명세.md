# 챗봇 기초기능 — 프롬프트 & API 전달 명세

> i3DWEB 화면을 **직접 조작해서 보여주는** 기본 기능(Viewer 조작 / 작업 위치 안내)만 정리한 문서.
> 각 기능별로 ① 사용자 프롬프트 → ② AI팀 API(요청/응답 JSON) → ③ 솔루션팀 API(Viewer SDK 호출/콜백) 순서로 어떻게 전달되는지 보여준다.
> (정비이력·주기·공간·작업단계·매뉴얼 RAG 같은 "근거형 답변" 기능은 별도 문서 참고. 이 문서는 화면을 움직이는 ACTION 계열만.)

---

## 0. 공통 전달 구조 (모든 기능 공통)

한 번의 대화에서 데이터는 **4단계**로 흐른다. (구현: `src/ui/app.js` `onSend()`)

```
[1] Frontend ─(HTTP 요청)→ AI 백엔드        POST /api/ai/chat
[2] AI 백엔드 ─(HTTP 응답)→ Frontend        { responseType, actions[...] }
[3] Frontend ─(SDK 호출)→ i3DWEB Viewer     i3dwebViewer.<method>(args)
[4] Viewer ─(콜백)→ Frontend                { ok, ... }
```

| 단계 | 주체 | 전송 방식 | 담당 |
|---|---|---|---|
| [1][2] | Frontend ↔ AI 백엔드 | **HTTP / JSON** | **AI팀** |
| [3][4] | Frontend ↔ Viewer | **Viewer SDK 호출 / 콜백** | **솔루션팀** |

### [1] Frontend → AI 백엔드 (공통 요청 형식)
```json
{
  "sessionId": "sess-ab12cd",
  "message": "사용자가 입력한 자연어 문장",
  "viewerContext": { "currentTag": "GV-101A" }
}
```
- `viewerContext.currentTag`: 현재 화면에서 선택/이동되어 있는 설비 태그. 문장에 태그가 없을 때 "이 설비"의 기준이 된다. (선택 없으면 `null`)

### [2] AI 백엔드 → Frontend (공통 응답 형식)
```json
{
  "responseType": "ACTION",
  "message": "사용자에게 보여줄 한 줄 설명",
  "answer": null,
  "actions": [ { "type": "<액션타입>", "...": "..." } ],
  "confidence": 0.93
}
```
- **`responseType`**
  - `ACTION` : 화면 조작만 (이 문서의 기초기능 대부분)
  - `ANSWER` : 답변만 (화면 동작 없음)
  - `ANSWER_WITH_ACTION` : 답변 + 화면 조작 동시
- **`actions[]`** : 솔루션팀 Viewer SDK로 번역할 명령 목록. AI팀이 자연어를 보고 이 JSON을 만들어 준다.

### AI 백엔드가 actions를 만드는 2가지 경로
1. **규칙 기반(빠름)** — `src/ai/classifier.js` `classifyRuleBased()`. 키워드 매칭으로 즉시 action 생성.
2. **LLM 폴백** — 규칙이 못 잡으면 로컬 LLM(Qwen3)이 action JSON 직접 생성. 시스템 프롬프트는 `backend/rag_server.py` `PLAN_PROMPT`. 응답에 `plan` 필드가 붙는다.

### [3] action → SDK 번역 (연결고리)
`src/core/actionExecutor.js`가 `action.type`을 실제 Viewer SDK 함수로 번역한다.
```
action.type = "JUMP_TO"  →  i3dwebViewer.jumpToTag(targetValue, params)
```

### [4] Viewer SDK 콜백 (공통 형식)
```json
{ "ok": true, "movedTo": "GV-101A", "status": "moved", "message": "처리 완료" }
```
- 실패 시: `{ "ok": false, "error": "TAG_NOT_FOUND", "message": "..." }`

---

## 1. 이동 (JUMP_TO) — 특정 태그 위치로 화면 이동

화면을 해당 설비 위치로 이동하고 강조 표시한다.

- **프롬프트 예시**: `TG-BRG-002 위치로 이동해줘` / `GV-101A 어디 있어` / `이 밸브로 가줘`
- **트리거**: 문장에 설비 태그(예: `GV-101A`)가 있고 + 이동/안내/위치 키워드

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "GV-101A 위치를 찾았습니다. 현재 화면을 해당 설비 위치로 이동하고 강조 표시합니다.",
  "actions": [
    { "type": "JUMP_TO", "targetType": "TAG", "targetValue": "GV-101A", "params": {} }
  ],
  "confidence": 0.93
}
```

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.jumpToTag("GV-101A", {})
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `jumpToTag(tag, params)` |
| 인자 | `tag = action.targetValue`, `params = action.params` |
| 콜백(성공) | `{ ok:true, movedTo:"GV-101A", status:"moved" }` |
| 콜백(실패) | `{ ok:false, error:"TAG_NOT_FOUND" }` |

---

## 2. 검색 (SEARCH_EQUIPMENT) — 이름/타입으로 설비 찾기

태그를 모를 때 설비명·타입으로 검색해 가장 가까운 설비로 이동 + 속성정보 표시.

- **프롬프트 예시**: `터빈 윤활유 펌프 찾아줘` / `밸브 검색` / `냉각수 펌프 어디 있어`
- **트리거**: "찾아/검색" + 태그 없음

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "\"펌프\" 설비를 검색합니다. 가장 가까운 설비로 이동하고 속성정보를 표시합니다.",
  "actions": [
    { "type": "SEARCH_EQUIPMENT", "query": "펌프", "params": {} }
  ],
  "confidence": 0.93
}
```

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.searchEquipment("펌프")
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `searchEquipment(query)` |
| 인자 | `query = action.query` |
| 콜백(성공) | `{ ok:true, count:3, matches:[...], nearest:"GV-101A" }` |
| 콜백(실패) | `{ ok:false, error:"NO_MATCH" }` |

---

## 3. 시점 회전 (ROTATE_VIEW) — 장비를 돌려서 보기

선택 장비 중심으로 시점을 회전(후면/측면)한다.

- **프롬프트 예시**: `이 장비 뒷면 보여줘` / `옆에서 보여줘` / `돌려줘`
- **트리거**: 뒷면/후면/측면/돌려/회전 키워드 (측면→`left/90°`, 그 외→`back/180°`)

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "선택한 장비의 후면 방향으로 View를 전환합니다. 장비 중심 기준 180도 회전합니다.",
  "actions": [
    { "type": "ROTATE_VIEW", "params": { "direction": "back", "angle": 180 } }
  ],
  "confidence": 0.93
}
```

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.rotateView("back", 180)
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `rotateView(direction, angle)` |
| 인자 | `direction = params.direction("back"\|"left")`, `angle = params.angle` |
| 콜백 | `{ ok:true, viewDir:"back", angle:180 }` |

---

## 4. 숨김 (HIDE_OBJECT) — 특정 설비/타입 안 보이게

선택 태그 또는 타입(밸브 전체 등)을 화면에서 숨긴다.

- **프롬프트 예시**: `밸브가 안 보이게 꺼줘` / `GV-101A 가려줘` / `펌프 숨겨줘`
- **트리거**: 숨겨/숨김/안 보이게/꺼줘/가려 (+ "다시" 없음)

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "밸브 객체를 숨김 처리합니다. 다시 보려면 \"다시 보여줘\"라고 입력하세요.",
  "actions": [
    { "type": "HIDE_OBJECT", "targetType": "TYPE", "targetValue": "VALVE", "params": {} }
  ],
  "confidence": 0.93
}
```
> `targetType`은 태그 지정 시 `"TAG"`, 타입 지정 시 `"TYPE"`. `targetValue`는 태그 문자열 또는 타입코드(`VALVE/PUMP/MOTOR/BEARING/HEATEX/TANK`).

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.hide({ by: "TYPE", value: "VALVE" })
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `hide(selector)` · `selector = { by, value }` |
| 인자 매핑 | `by = action.targetType`, `value = action.targetValue` |
| 콜백 | `{ ok:true, hiddenCount:3 }` |

---

## 5. 다시 표시 (SHOW_OBJECT) — 숨긴 설비 다시 보이게

숨겼던 설비/타입/전체를 다시 표시한다.

- **프롬프트 예시**: `밸브 다시 보여줘` / `전체 다시 켜줘` / `GV-101A 다시 표시`
- **트리거**: 다시 보여/다시 표시/다시 켜/보이게 해/켜줘

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "밸브 객체를 다시 표시합니다.",
  "actions": [
    { "type": "SHOW_OBJECT", "targetType": "TYPE", "targetValue": "VALVE", "params": {} }
  ],
  "confidence": 0.93
}
```
> "전체/모두/전부" 포함 시 `targetType:"ALL", targetValue:"ALL"`.

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.show({ by: "TYPE", value: "VALVE" })   // value==="ALL" 이면 전체 표시
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `show(selector)` |
| 인자 매핑 | `by = action.targetType`, `value = action.targetValue` |
| 콜백 | `{ ok:true, shownCount:3 }` |

---

## 6. 타입 필터 (FILTER_BY_TYPE) — 특정 타입만 남기기

지정 타입(펌프/밸브 등)만 화면에 남기고 나머지는 숨긴다.

- **프롬프트 예시**: `이 구역에 있는 펌프만 보여줘` / `밸브만 표시`
- **트리거**: 타입 키워드 + "만 보여/만 표시/만 봐/만 남겨/만 켜"

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "펌프 객체만 표시합니다. 나머지 설비는 숨김 처리합니다.",
  "actions": [
    { "type": "FILTER_BY_TYPE", "targetValue": "PUMP", "params": {} }
  ],
  "confidence": 0.93
}
```

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.filterByType("PUMP")
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `filterByType(type)` |
| 인자 | `type = action.targetValue` (타입코드) |
| 콜백 | `{ ok:true, shownCount:3 }` / `{ ok:false, error:"NO_MATCH" }` |

---

## 7. 계통 격리 (ISOLATE_SYSTEM) — 한 계통만 보기

선택 계통(예: 냉각수 계통)의 설비만 표시하고 다른 계통은 임시 숨김.

- **프롬프트 예시**: `선택한 이 계통만 보여줘` / `냉각수 계통만 보여줘`
- **트리거**: "계통" + "만/위주/따로"

**② AI팀 API — 응답 actions**
```json
{
  "responseType": "ACTION",
  "message": "선택한 계통의 설비만 표시합니다. 다른 계통의 배관·밸브·장비는 임시 숨김 처리합니다.",
  "actions": [
    { "type": "ISOLATE_SYSTEM", "targetValue": "냉각수 계통", "params": {} }
  ],
  "confidence": 0.93
}
```
> 계통명을 못 잡으면 `targetValue: null` → SDK가 현재 선택 설비의 계통을 사용.

**③ 솔루션팀 API — Viewer SDK 호출**
```
i3dwebViewer.isolateSystem("냉각수 계통")
```
| 항목 | 값 |
|---|---|
| SDK 함수 | `isolateSystem(system)` |
| 인자 | `system = action.targetValue` (없으면 현재 선택 설비 계통) |
| 콜백 | `{ ok:true, system:"냉각수 계통", shownCount:1, hiddenCount:0 }` |

---

## 8. 작업 위치 안내 (위치/경로 표시 계열)

아래는 점검·정비 작업을 위한 위치/경로를 화면에 표시하는 ACTION들. 응답·SDK 매핑 구조는 위와 동일하다.

| 기능 | 액션 타입 | 프롬프트 예시 | SDK 호출 |
|---|---|---|---|
| 점검 위치로 이동 | `MOVE_TO_INSPECTION` | `이 설비 점검 위치로 이동해줘` | `moveToInspection(targetValue)` |
| 경로 표시 | `SHOW_PATH` | `밸브 조작 위치까지 경로 표시해줘` / `비상 탈출 경로 보여줘` | `showPath(target)` |
| 점검 순서 안내 | `SHOW_INSPECTION_ROUTE` | `오늘 점검해야 하는 설비 순서대로 안내해줘` | `showInspectionRoute()` |
| 최근접 점검 대상 | `FIND_NEAREST` | `가장 가까운 점검 대상 보여줘` | `findNearest()` |
| 점검자 위치 | `SHOW_WORKER_POSITION` | `이 펌프 점검자가 서야 하는 위치 보여줘` | `showWorkerPosition(targetValue)` |
| 정비 작업 구역 표시 | `SHOW_WORK_ZONE` | `이 밸브 정비 구역을 화면에 표시해줘` | `showWorkZone(targetValue)` |

**예시 — 경로 표시 (SHOW_PATH)**
```json
// ② AI팀 응답
{
  "responseType": "ACTION",
  "message": "선택 대상까지의 경로를 표시합니다.",
  "actions": [ { "type": "SHOW_PATH", "target": "OPERATION_POS", "params": {} } ]
}
```
```
// ③ 솔루션팀 SDK 호출
i3dwebViewer.showPath("OPERATION_POS")
// 콜백: { ok:true, target:"OPERATION_POS", distanceM:18, note:"계단 구간 포함" }
```
> `target` 값: 설비 태그 / `OPERATION_POS`(조작 위치) / `EMERGENCY_EXIT`(비상 탈출구).

---

## 부록 A. 액션 타입 ↔ Viewer SDK 매핑 한눈에 보기

(연결고리: `src/core/actionExecutor.js`)

| 액션 타입 | Viewer SDK 함수 | 주요 인자 |
|---|---|---|
| `JUMP_TO` | `jumpToTag(tag, params)` | `targetValue`, `params` |
| `SEARCH_EQUIPMENT` | `searchEquipment(query)` | `query` |
| `ROTATE_VIEW` | `rotateView(direction, angle)` | `params.direction`, `params.angle` |
| `HIDE_OBJECT` | `hide({by, value})` | `targetType`, `targetValue` |
| `SHOW_OBJECT` | `show({by, value})` | `targetType`, `targetValue` |
| `ISOLATE_SYSTEM` | `isolateSystem(system)` | `targetValue` |
| `FILTER_BY_TYPE` | `filterByType(type)` | `targetValue` |
| `MOVE_TO_INSPECTION` | `moveToInspection(tag)` | `targetValue` |
| `SHOW_PATH` | `showPath(target)` | `target` |
| `SHOW_INSPECTION_ROUTE` | `showInspectionRoute()` | — |
| `FIND_NEAREST` | `findNearest()` | — |
| `SHOW_WORKER_POSITION` | `showWorkerPosition(tag)` | `targetValue` |
| `SHOW_WORK_ZONE` | `showWorkZone(tag)` | `targetValue` |

## 부록 B. 타입 코드

| 코드 | 한글 |
|---|---|
| `PUMP` | 펌프 |
| `VALVE` | 밸브 |
| `MOTOR` | 모터 |
| `BEARING` | 베어링 |
| `HEATEX` | 열교환기 |
| `TANK` | 탱크 |

## 부록 C. 관련 소스 파일

| 역할 | 파일 | 담당 |
|---|---|---|
| 자연어 → action JSON (규칙/LLM) | `src/ai/classifier.js` | AI팀 |
| LLM action 생성 프롬프트(`PLAN_PROMPT`) | `backend/rag_server.py` | AI팀 |
| action → Viewer SDK 번역 | `src/core/actionExecutor.js` | Frontend |
| Viewer SDK(화면 조작 실행) | `src/viewer/mockViewer.js` | 솔루션팀 |
| 전체 흐름 오케스트레이션 | `src/ui/app.js` | Frontend |
