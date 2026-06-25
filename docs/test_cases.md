# 분류 테스트 케이스 (1차)

AI가 responseType을 올바르게 판단하는지 확인하는 케이스.

| # | 입력 | 기대 responseType | 기대 targetValue | 비고 |
|---|---|---|---|---|
| TC-1 | TG-BRG-002로 이동해줘. | ACTION | TG-BRG-002 | 기본 이동 |
| TC-2 | TG-BRG-002 찾아줘. | ACTION | TG-BRG-002 | "찾아" = 이동 의도 |
| TC-3 | TG-PMP-101 위치로 가줘 | ACTION | TG-PMP-101 | 다른 태그 |
| TC-4 | TG-BRG-002가 어떤 설비야? | ANSWER | (없음) | 정보 질의 |
| TC-5 | TG-BRG-002 점검 방법 알려줘 | ANSWER | (없음) | 절차 질의 |
| TC-6 | TG-BRG-002로 이동하고 점검 절차도 알려줘 | ANSWER_WITH_ACTION | TG-BRG-002 | 이동+답변 |
| TC-7 | 점검 절차 알려줘 | ANSWER | (없음) | 태그 없음 → 답변/되물음 |
| TC-8 | 안녕? | ANSWER | (없음) | 일반 대화 |

## 에러 케이스

| # | 입력 / 트리거 | 기대 동작 | 에러 코드 | 구간(팀) |
|---|---|---|---|---|
| EC-1 | TG-XXX-999로 이동해줘 | 200 OK → Viewer 실패 콜백, Viewer 빨간 상태 | `TAG_NOT_FOUND` | Viewer SDK (솔루션팀) |
| EC-2 | [백엔드 500 에러] 버튼 | HTTP 500, 챗봇 오류 표시, 액션 미실행 | `INTERNAL_ERROR` | HTTP (AI팀) |
| EC-3 | 미지원 action type 수신(향후) | 디스패치 경고, 무시 | `UNSUPPORTED_ACTION` | Frontend (공통) |

> EC-1 판정 기준: Mock Viewer 로드 태그 목록(`KNOWN_TAGS`)에 없는 태그면 실패.

## 테스트용 태그 예시
- TG-BRG-002 (베어링 계통)
- TG-PMP-101 (펌프)
- TG-VLV-205 (밸브)
- TG-MOT-310 (모터)
- TG-TNK-007 (탱크)

## 검증 방법
`index.html`을 열고 각 입력을 Send한 뒤:
1. 챗봇 응답 영역의 badge가 기대 responseType과 일치하는지
2. JSON 영역의 `actions`가 기대대로 채워지는지
3. ACTION 계열일 때 Mock Viewer의 현재 TAG가 갱신되는지
