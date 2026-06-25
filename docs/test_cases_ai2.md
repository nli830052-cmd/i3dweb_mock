# AI 기능 테스트 케이스 — 작업 위치 안내 (2차)

| 항목 | 내용 |
|---|---|
| 문서명 | AI 추가 기능 프롬프트 / 테스트 케이스 (작업 위치 안내) |
| 작성자 | AI팀 (김린) |
| 작성일 | 2026-06-16 |
| 대상 브랜치 | `feature/ai-worklocation-actions` |
| 범위 | PDF 2번 카테고리(작업 위치 안내)로 신규 추가된 액션 5종 + ANSWER 1종 |
| 제외 | baseline, 1차(설비 찾기/조작), PDF 3~6번 카테고리 |

> 본 문서는 **2차 추가 기능 전용**입니다. 1차는 `test_cases_ai1.md` 참조.
> 2번 카테고리는 경로·거리·순서 등 **공간(Walkinside) 의존**이 커서 수치는 모두 mock 값입니다.

---

## 0. 신규 액션 요약

| # | 기능 | action type | 트리거 키워드(핵심) | 기대 responseType |
|---|---|---|---|---|
| 1 | 점검 위치 이동 | `MOVE_TO_INSPECTION` | 점검 + 위치 + 이동/안내 | ACTION |
| 2 | 경로 표시 | `SHOW_PATH` | 경로 / 비상 탈출 | ACTION |
| 3 | 점검 순서 안내 | `SHOW_INSPECTION_ROUTE` | 점검 + 순서/동선 | ACTION |
| 4 | 최근접 점검 대상 | `FIND_NEAREST` | 가장 가까운 + 점검/대상 | ACTION |
| 5 | 점검자 위치 | `SHOW_WORKER_POSITION` | 점검자/작업자 + 위치 | ACTION |
| 6 | 고소작업 여부 | (ANSWER) | 사다리 / 작업발판 / 고소작업 | ANSWER |

> Mock 점검 대상(오늘): GV-101A(4.8m) · TG-PMP-101(7.2m) · GV-102A(12.5m) · HX-301(20.1m)
> 경로 거리(mock): 조작 위치 18m(계단 포함) · 비상구 35m · 점검 위치 전면 1.5m

---

## 1. 점검 위치 이동 — `MOVE_TO_INSPECTION`

**프롬프트 작성 가이드:** 설비의 점검 작업 위치로 이동. "이 설비/(태그) 점검 위치로 이동/안내해줘".

| 프롬프트 | 기대 action |
|---|---|
| 이 설비 점검 위치로 이동해줘 | MOVE_TO_INSPECTION, targetType="SELECTED", targetValue=null |
| TG-PMP-101 점검 위치로 안내해줘 | MOVE_TO_INSPECTION, targetType="TAG", targetValue="TG-PMP-101" |

**기대 action JSON**
```json
{ "type": "MOVE_TO_INSPECTION", "targetType": "SELECTED", "targetValue": null, "params": {} }
```
**기대 Mock Viewer 결과:** 대상 선택, info `점검 위치 이동 · 전면 1.5m`
**통과 기준:** 콜백 `{ ok:true, standoff:"1.5m" }`

---

## 2. 경로 표시 — `SHOW_PATH`

**프롬프트 작성 가이드:** 특정 위치/비상구까지 경로. "~까지 경로 표시해줘", "비상 탈출 경로 보여줘".

| 프롬프트 | 기대 action (target) | 거리(mock) |
|---|---|---|
| 밸브 조작 위치까지 경로 표시해줘 | SHOW_PATH, "OPERATION_POS" | 18m, 계단 포함 |
| 비상 탈출 경로 보여줘 | SHOW_PATH, "EMERGENCY_EXIT" | 35m |
| TG-VLV-205까지 경로 보여줘 | SHOW_PATH, "TG-VLV-205" | 8.5m |

**기대 action JSON**
```json
{ "type": "SHOW_PATH", "target": "EMERGENCY_EXIT", "params": {} }
```
**기대 Mock Viewer 결과:** info에 경로 대상·거리(·계단) 표시
**통과 기준:** 콜백 `{ ok:true, distanceM:35 }`(비상) / `18`(조작, note="계단 구간 포함")

---

## 3. 점검 순서 안내 — `SHOW_INSPECTION_ROUTE`

**프롬프트 작성 가이드:** 오늘 점검 대상을 최적 순서로. "오늘 점검 ... 순서대로 안내해줘", "점검 동선 알려줘".

| 프롬프트 | 기대 action |
|---|---|
| 오늘 점검해야 하는 설비 위치 순서대로 안내해줘 | SHOW_INSPECTION_ROUTE |
| 오늘 점검 동선 알려줘 | SHOW_INSPECTION_ROUTE |

**기대 action JSON**
```json
{ "type": "SHOW_INSPECTION_ROUTE", "params": {} }
```
**기대 Mock Viewer 결과:** 점검 대상 4개 강조, info `GV-101A → TG-PMP-101 → GV-102A → HX-301`, 첫 위치로 이동
**통과 기준:** 콜백 `{ ok:true, count:4, first:"GV-101A" }`

---

## 4. 최근접 점검 대상 — `FIND_NEAREST`

**프롬프트 작성 가이드:** 현재 위치 기준 가장 가까운 점검 대상. "가장 가까운 점검 대상 보여줘".

| 프롬프트 | 기대 action |
|---|---|
| 현재 위치에서 가장 가까운 점검 대상 보여줘 | FIND_NEAREST, params.filter="inspection" |
| 제일 가까운 점검 설비로 가줘 | FIND_NEAREST |

**기대 action JSON**
```json
{ "type": "FIND_NEAREST", "params": { "filter": "inspection" } }
```
**기대 Mock Viewer 결과:** GV-101A 강조/선택, info `가장 가까운 점검 대상 · GV-101A · 약 4.8m`
**통과 기준:** 콜백 `{ ok:true, nearest:"GV-101A", distanceM:4.8 }`

---

## 5. 점검자 위치 — `SHOW_WORKER_POSITION`

**프롬프트 작성 가이드:** 점검자가 서야 하는 위치. "(이 펌프) 점검자가 서야 하는 위치 보여줘".

| 프롬프트 | 기대 action |
|---|---|
| 이 펌프 점검자가 서야 하는 위치 보여줘 | SHOW_WORKER_POSITION, targetValue=null |
| TG-PMP-101 작업자 위치 표시해줘 | SHOW_WORKER_POSITION, targetValue="TG-PMP-101" |

**기대 action JSON**
```json
{ "type": "SHOW_WORKER_POSITION", "targetValue": null, "params": {} }
```
**기대 Mock Viewer 결과:** info `점검자 위치 · 우측 점검공간`
**통과 기준:** 콜백 `{ ok:true }`

---

## 6. 고소작업 여부 — ANSWER

**프롬프트 작성 가이드:** 사다리/작업발판/고소작업 필요 여부 질의 → 답변만(액션 없음).

| 프롬프트 | 기대 responseType |
|---|---|
| 사다리나 작업 발판이 필요한 위치인지 알려줘 | ANSWER |
| 이 밸브 2m 이상 고소작업에 해당돼? | ANSWER |

**기대 응답:** `responseType: "ANSWER"`, `actions: []`, answer에 높이 ~2.3m·고소작업 안전조치 안내
**통과 기준:** Viewer 동작 없음, 챗봇 답변만 출력

---

## 7. 분기 주의 케이스 (오분류 방지)

| 프롬프트 | 올바른 분기 | 헷갈리는 분기 | 구분 포인트 |
|---|---|---|---|
| 이 설비 점검 위치로 이동해줘 | MOVE_TO_INSPECTION | JUMP_TO | "점검" 유무 |
| TG-BRG-002 위치로 이동해줘 | JUMP_TO | MOVE_TO_INSPECTION | "점검" 유무 |
| 오늘 점검 순서대로 안내해줘 | SHOW_INSPECTION_ROUTE | MOVE_TO_INSPECTION | "순서" 유무 |
| 가장 가까운 점검 대상 보여줘 | FIND_NEAREST | SHOW_INSPECTION_ROUTE | "가장 가까운" 유무 |
| 비상 탈출 경로 보여줘 | SHOW_PATH(EMERGENCY_EXIT) | SHOW_PATH(OPERATION_POS) | "비상/대피" 유무 |

---

## 8. 검증 방법

1. `index.html`을 연다 (브랜치 `feature/ai-worklocation-actions`).
2. 상단 예시 버튼 또는 위 프롬프트 입력 → Send.
3. 확인 포인트:
   - **4 AI 응답 JSON**: `actions[0].type` 일치
   - **2 API 흐름**: `i3dwebViewer.<method>()` → 콜백 `{ ok:true, ... }`
   - **6 Mock Viewer**: 하단 info 라인에 경로/거리/순서/점검자 위치 표시, 점검 대상 강조
