# AI 기능 테스트 케이스 — 설비 찾기/조작 (1차 확장)

| 항목 | 내용 |
|---|---|
| 문서명 | AI 추가 기능 프롬프트 / 테스트 케이스 (설비 찾기·조작) |
| 작성자 | AI팀 (김린) |
| 작성일 | 2026-06-16 |
| 대상 브랜치 | `feature/ai-equipment-actions` |
| 범위 | PDF 1번 카테고리(설비 찾기/조작)로 신규 추가된 액션 6종만 |
| 제외 | 기존 baseline(JUMP_TO/ANSWER), PDF 2~6번 카테고리 |

> 본 문서는 **신규 추가 기능 전용**입니다. baseline 케이스는 `test_cases.md` 참조.
> 모든 케이스는 `index.html`에서 입력 → 응답 JSON / Mock Viewer 결과로 검증합니다.

---

## 0. 신규 액션 요약

| # | 기능 | action type | 트리거 키워드(핵심) | 기대 responseType |
|---|---|---|---|---|
| 1 | 설비 검색 | `SEARCH_EQUIPMENT` | 찾아 / 검색 / 어디 (+태그 없음) | ACTION |
| 2 | 시점 회전 | `ROTATE_VIEW` | 뒷면 / 후면 / 회전 / 측면 | ACTION |
| 3 | 객체 숨김 | `HIDE_OBJECT` | 숨겨 / 안 보이게 / 꺼줘 / 가려 | ACTION |
| 4 | 객체 표시 | `SHOW_OBJECT` | 다시 보여 / 다시 표시 / 켜줘 | ACTION |
| 5 | 계통 격리 | `ISOLATE_SYSTEM` | 계통 + 만/위주/따로 | ACTION |
| 6 | 타입 필터 | `FILTER_BY_TYPE` | (타입) + 만 보여/만 표시 | ACTION |

> Mock 씬 구성(참고): 펌프 3(TGLOP-001, TG-PMP-101, TG-PMP-102), 밸브 3(TG-VLV-205, GV-101A, GV-102A), 모터 1(TG-MOT-310), 베어링 1(TG-BRG-002), 열교환기 1(HX-301), 탱크 1(TG-TNK-007)
> 계통: 터빈 계통(2) · 터빈 윤활유 계통(5) · 냉각수 계통(3)
> 타입코드: PUMP / VALVE / MOTOR / BEARING / HEATEX / TANK

---

## 1. 설비 검색 — `SEARCH_EQUIPMENT`

**프롬프트 작성 가이드:** 태그번호 없이 이름/타입으로 찾을 때. "(설비명) 찾아줘 / 검색해줘 / 어디 있어".

| 프롬프트 | 기대 responseType | 기대 action |
|---|---|---|
| 터빈 윤활유 펌프 찾아줘 | ACTION | SEARCH_EQUIPMENT, query="터빈 윤활유 펌프" |
| 밸브 검색해줘 | ACTION | SEARCH_EQUIPMENT, query="밸브" |
| 펌프 어디 있어? | ACTION | SEARCH_EQUIPMENT, query="펌프" |

**기대 action JSON**
```json
{ "type": "SEARCH_EQUIPMENT", "query": "터빈 윤활유 펌프", "params": {} }
```
**기대 Mock Viewer 결과:** 매칭 3건 강조, 가장 가까운 `TGLOP-001`로 선택/이동, 상단 필터 `검색: "..."`
**통과 기준:** 콜백 `{ ok:true, count:3, nearest:"TGLOP-001" }`, 씬에서 펌프 3개 강조

---

## 2. 시점 회전 — `ROTATE_VIEW`

**프롬프트 작성 가이드:** 선택 장비를 다른 방향에서 볼 때. "뒷면/후면/측면 보여줘", "돌려/회전해줘".

| 프롬프트 | 기대 action (params) |
|---|---|
| 이 장비 뒷면 보여줘 | ROTATE_VIEW, direction="back", angle=180 |
| 후면에서 보여줘 | ROTATE_VIEW, direction="back", angle=180 |
| 측면으로 돌려줘 | ROTATE_VIEW, direction="left", angle=90 |

**기대 action JSON**
```json
{ "type": "ROTATE_VIEW", "params": { "direction": "back", "angle": 180 } }
```
**기대 Mock Viewer 결과:** 상단 `시점: 후면` 표시
**통과 기준:** 콜백 `{ ok:true, viewDir:"back" }`, 상단 시점 라벨 변경

---

## 3. 객체 숨김 — `HIDE_OBJECT`

**프롬프트 작성 가이드:** 특정 타입/태그를 화면에서 가릴 때. "(타입)이 안 보이게 꺼줘 / 숨겨줘". ("다시"가 들어가면 표시로 분기되므로 숨김엔 "다시" 미포함.)

| 프롬프트 | 기대 action |
|---|---|
| 밸브가 안 보이게 꺼줘 | HIDE_OBJECT, targetType="TYPE", targetValue="VALVE" |
| 펌프 숨겨줘 | HIDE_OBJECT, targetType="TYPE", targetValue="PUMP" |
| TG-TNK-007 가려줘 | HIDE_OBJECT, targetType="TAG", targetValue="TG-TNK-007" |

**기대 action JSON**
```json
{ "type": "HIDE_OBJECT", "targetType": "TYPE", "targetValue": "VALVE", "params": {} }
```
**기대 Mock Viewer 결과:** 밸브 3개 흐림/취소선(숨김), 상단 필터 `밸브 숨김`
**통과 기준:** 콜백 `{ ok:true, hiddenCount:3 }`

---

## 4. 객체 표시 — `SHOW_OBJECT`

**프롬프트 작성 가이드:** 숨긴 것을 다시 보이게. "(타입) 다시 보여줘", "전체 다시 보여줘".

| 프롬프트 | 기대 action |
|---|---|
| 밸브 다시 보여줘 | SHOW_OBJECT, targetType="TYPE", targetValue="VALVE" |
| 전체 다시 보여줘 | SHOW_OBJECT, targetType="ALL", targetValue="ALL" |
| 펌프 다시 표시해줘 | SHOW_OBJECT, targetType="TYPE", targetValue="PUMP" |

**기대 action JSON**
```json
{ "type": "SHOW_OBJECT", "targetType": "ALL", "targetValue": "ALL", "params": {} }
```
**기대 Mock Viewer 결과:** 해당(또는 전체) 객체 다시 표시, 필터 해제
**통과 기준:** 콜백 `{ ok:true, shownCount:N }` (전체=10)

---

## 5. 계통 격리 — `ISOLATE_SYSTEM`

**프롬프트 작성 가이드:** 한 계통만 남길 때. "선택한 이 계통만 보여줘", "냉각수 계통만 보여줘"(계통명 명시 가능).

| 프롬프트 | 기대 action (targetValue) |
|---|---|
| 선택한 이 계통만 보여줘 | ISOLATE_SYSTEM, targetValue=null(현재 선택 계통) |
| 냉각수 계통만 보여줘 | ISOLATE_SYSTEM, targetValue="냉각수 계통" |
| 터빈 윤활유 계통만 따로 봐 | ISOLATE_SYSTEM, targetValue="터빈 윤활유 계통" |

**기대 action JSON**
```json
{ "type": "ISOLATE_SYSTEM", "targetValue": "냉각수 계통", "params": {} }
```
**기대 Mock Viewer 결과:** 해당 계통 설비만 표시, 나머지 숨김. 상단 필터 `계통: ... 만 표시`
**통과 기준:** 냉각수=콜백 `{ ok:true, shownCount:3, hiddenCount:7 }` / 선택없을 때 기본 계통(터빈 윤활유, shown:5)

---

## 6. 타입 필터 — `FILTER_BY_TYPE`

**프롬프트 작성 가이드:** 한 타입만 남길 때. "(타입)만 보여줘 / 만 표시해줘". (계통 단어가 들어가면 5번으로 분기.)

| 프롬프트 | 기대 action (targetValue) |
|---|---|
| 이 구역에 있는 펌프만 보여줘 | FILTER_BY_TYPE, "PUMP" |
| 밸브만 표시해줘 | FILTER_BY_TYPE, "VALVE" |
| 모터만 봐 | FILTER_BY_TYPE, "MOTOR" |

**기대 action JSON**
```json
{ "type": "FILTER_BY_TYPE", "targetValue": "PUMP", "params": {} }
```
**기대 Mock Viewer 결과:** 해당 타입만 표시, 나머지 숨김. 상단 필터 `펌프만 표시`
**통과 기준:** 펌프=콜백 `{ ok:true, shownCount:3 }` / 밸브=3 / 모터=1

---

## 7. 분기 주의 케이스 (오분류 방지)

| 프롬프트 | 올바른 분기 | 헷갈리는 분기 | 구분 포인트 |
|---|---|---|---|
| TG-PMP-101 찾아줘 | JUMP_TO (태그 있음) | SEARCH_EQUIPMENT | 태그 유무 |
| 펌프 찾아줘 | SEARCH_EQUIPMENT (태그 없음) | JUMP_TO | 태그 유무 |
| 펌프만 보여줘 | FILTER_BY_TYPE | ISOLATE_SYSTEM | "계통" 단어 유무 |
| 이 계통만 보여줘 | ISOLATE_SYSTEM | FILTER_BY_TYPE | "계통" 단어 유무 |
| 밸브 다시 보여줘 | SHOW_OBJECT | HIDE_OBJECT | "다시" 유무 |
| 밸브 안 보이게 꺼줘 | HIDE_OBJECT | SHOW_OBJECT | "다시" 유무 |

---

## 8. 검증 방법

1. `index.html`을 연다 (브랜치 `feature/ai-equipment-actions`).
2. 상단 예시 버튼 또는 위 프롬프트를 직접 입력 → Send.
3. 확인 포인트:
   - **3 챗봇 응답**: badge = ACTION
   - **4 AI 응답 JSON**: `actions[0].type`이 기대값과 일치
   - **2 API 흐름**: `i3dwebViewer.<method>()` 호출 → 콜백 `{ ok:true, ... }`
   - **6 Mock Viewer**: 씬 객체의 숨김/강조/시점/필터 상태가 기대대로 변경
