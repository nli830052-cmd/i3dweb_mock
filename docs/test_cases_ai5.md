# AI 기능 테스트 케이스 — 현재 위치 / 작업 조건 (5차)

| 항목 | 내용 |
|---|---|
| 문서명 | AI 추가 기능 프롬프트 / 테스트 케이스 (작업 조건) |
| 작성자 | AI팀 (김린) |
| 작성일 | 2026-06-17 |
| 대상 브랜치 | `feature/ai-work-condition` |
| 범위 | PDF 5번 카테고리(현재 위치/작업 조건) — 공간조건 ANSWER 4종 + 정비구역 ACTION 1종 |
| 제외 | baseline, 1~4차, PDF 6번 |

> 5번은 데이터 출처가 **Walkinside 공간 측정(솔루션팀)** 입니다. 정비 이력(CMMS=AI팀)과 달리
> grounded ANSWER의 `retrieval.owner="sol"` 로 표시되어 흐름 패널에서 **솔루션팀 데이터 조회**로 구분됩니다.

---

## 0. 신규 응답 요약

| # | 질의/동작 | 타입 | 트리거 키워드 | 출처/owner |
|---|---|---|---|---|
| 1 | 작업 공간/간섭 | ANSWER | 작업 공간 / 간섭 | Walkinside(sol) |
| 2 | 작업발판 필요 | ANSWER | 작업발판 / 발판 / 사다리 | Walkinside(sol) |
| 3 | 고소작업 해당 | ANSWER | 고소작업 / 2m 이상 | Walkinside(sol) |
| 4 | 추락 위험/개구부 | ANSWER | 추락 / 개구부 | Walkinside(sol) |
| 5 | 정비 구역 표시 | ACTION `SHOW_WORK_ZONE` | 정비 구역 + 표시 | Viewer SDK(sol) |

> 대상 설비: 텍스트 태그 → `viewerContext.currentTag` → 기본 `GV-101A`(글로브 밸브).
> mock 공간 데이터 보유: GV-101A · TG-VLV-205 · GV-102A · TG-PMP-101.

---

## 1. 작업 공간 / 간섭

| 프롬프트 | 기대(GV-101A) |
|---|---|
| 이 Globe Valve 주변 작업 공간 충분해? | 전면 약 1.2m, 우측 약 0.8m · 우측 좁아 간섭 가능성 |

**응답:** ANSWER grounded, `retrieval.source="Walkinside 공간 데이터"`, `owner="sol"`

---

## 2. 작업발판 필요 / 3. 고소작업 해당

| 프롬프트 | 기대(GV-101A) |
|---|---|
| 이 밸브 정비할 때 작업발판이 필요해? | 높이 약 2.3m · 2m 이상 → 작업발판/안전대 필요 |
| 이 밸브는 2m 이상 고소작업에 해당돼? | 높이 약 2.3m · 고소작업 기준 해당 |

> 높이 < 2m 설비(예: GV-102A 0.9m)는 "고소작업 미해당"으로 응답.

---

## 4. 추락 위험 / 개구부

| 프롬프트 | 기대(GV-101A) |
|---|---|
| 이 밸브 주변에 추락 위험이나 개구부가 있어? | 좌측 약 2m 지점 개구부 위험 구역 · 출입 제한·추락 방지 필요 |

> fallHazard 없는 설비는 "확인되지 않습니다"로 응답.

---

## 5. 정비 구역 표시 — `SHOW_WORK_ZONE` (ACTION)

| 프롬프트 | 기대 action |
|---|---|
| 이 밸브 정비 구역을 화면에 표시해줘 | SHOW_WORK_ZONE, targetValue=null |

**기대 action JSON**
```json
{ "type": "SHOW_WORK_ZONE", "targetValue": null, "params": {} }
```
**기대 Mock Viewer 결과:** info `정비 작업 구역 표시 · 반경 2m`
**통과 기준:** 콜백 `{ ok:true, radiusM:2 }`

---

## 6. 분기 주의 케이스

| 프롬프트 | 올바른 분기 | 구분 포인트 |
|---|---|---|
| 정비 구역 표시해줘 | SHOW_WORK_ZONE (ACTION) | "구역"+"표시" |
| 작업 공간 충분해? | 작업조건 ANSWER | "공간" |
| 작업발판 필요해? | 작업조건 ANSWER (높이) | "발판" |
| 점검 위치로 이동해줘 | MOVE_TO_INSPECTION (2차) | "점검 위치"+이동 |

---

## 7. 검증 방법

1. `index.html`을 연다 (브랜치 `feature/ai-work-condition`).
2. 예시 버튼(작업공간/고소작업/추락위험/정비구역) 또는 위 프롬프트 입력 → Send.
3. 확인 포인트:
   - **2 API 흐름**: 공간 ANSWER는 데이터 조회 단계가 **`솔루션팀` owner**(Walkinside)로 표시 / 정비 이력(3·4차)은 **`AI팀`**(CMMS)
   - **3 챗봇 응답**: `grounded` 배지 + 출처(Walkinside 공간측정)
   - 정비 구역은 ACTION → Mock Viewer info에 작업 반경 표시
