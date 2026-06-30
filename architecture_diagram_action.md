# i3dweb_mock 통신 흐름도 - ACTION 특화 (단순 화면 이동)

사용자가 채팅창에 **"GV-101A로 이동해줘"**라고 입력했을 때, 백엔드의 AI나 DB 검색을 굳이 거치지 않고 가장 빠르고 효율적으로 3D 화면을 조작(ACTION)하는 과정을 보여주는 시퀀스 다이어그램입니다.

```mermaid
sequenceDiagram
    autonumber
  
    actor User as 사용자
  
    box rgb(225, 245, 254) 프론트엔드 (웹 브라우저)
        participant UI as src/ui/app.js<br/>(화면 UI)
        participant Classifier as src/ai/classifier.js<br/>(로컬 판별기/라우터)
        participant RagClient as src/ai/ragClient.js<br/>(HTTP 통신 담당)
        participant Executor as src/core/actionExecutor.js<br/>(액션 실행기)
        participant Viewer as src/viewer/mockViewer.js<br/>(Viewer SDK)
    end

    box rgb(255, 243, 224) 백엔드 (파이썬 로컬 서버)
        participant RagServer as backend/rag_server.py<br/>(파이썬 메인 서버)
    end
  
    %% 1. 사용자 입력 및 프론트엔드 라우팅
    User->>UI: "GV-101A로 이동해줘" 입력
    activate UI
    UI->>Classifier: AiBackend.requestAiResponse(request) 호출
    activate Classifier
  
    %% 2. 로컬 판단 (매뉴얼/DB 질의가 아님을 파악)
    Classifier->>Classifier: "이동해줘"는 매뉴얼/정비 질의가 아님을 확인<br/>(isGroundedQuery = false)
  
    %% 3. 백엔드로 Action Plan 전용 통신 (HTTP POST)
    Classifier->>RagClient: RagClient.plan(message) 호출
    activate RagClient
    RagClient->>RagServer: fetch POST http://localhost:8090/api/ai/plan
    activate RagServer
  
    %% 4. 백엔드의 빠른 정규식 매칭 (LLM, DB 생략)
    Note over RagServer: "이동", "위치" 등의 키워드가 있으면<br/>무거운 Ollama LLM이나 DB를 깨우지 않고<br/>정규식으로 태그(GV-101A)만 즉시 추출!
    RagServer->>RagServer: make_plan() 내장 로직 실행<br/>-> JUMP_TO 액션 강제 생성
  
    %% 5. 백엔드에서 프론트엔드로 응답 반환
    RagServer-->>RagClient: {"responseType":"ACTION", "actions":[{"type":"JUMP_TO", "targetValue":"GV-101A"}]} 반환
    deactivate RagServer
  
    %% 6. 프론트엔드 라우팅 및 텍스트 응답 생략
    RagClient-->>Classifier: JSON 데이터 전달
    deactivate RagClient
  
    Classifier->>Classifier: executePlan() - 텍스트 대답(answer)이<br/>필요 없으므로 순수 "ACTION" 타입으로 결정
    Classifier-->>UI: 최종 Response 객체 반환
    deactivate Classifier
  
    %% 7. UI 업데이트 및 3D 뷰어 조작
    UI->>UI: 챗봇 창에 간단한 안내 텍스트<br/>("GV-101A 위치로 이동합니다.") 렌더링
  
    UI->>Executor: ActionExecutor.executeAction(JUMP_TO, GV-101A)
    activate Executor
    Executor->>Viewer: ViewerSDK.jumpToTag('GV-101A') 호출
    activate Viewer
    Viewer-->>Viewer: 카메라를 해당 밸브 좌표로 줌인 (Zoom In)
    Viewer-->>Executor: 이동 완료
    deactivate Viewer
    Executor-->>UI: 액션 완료 로그 반환
    deactivate Executor
  
    UI-->>User: 화면 이동 완료
    deactivate UI
```

### 🔍 이전 다이어그램(종합 챗봇)과의 핵심 차이점

이전 다이어그램(답변 포함)과 비교했을 때, 순수하게 화면만 제어하는 **ACTION** 플로우의 특징은 다음과 같습니다.

1. **오직 `/api/ai/plan` 직통 주소만 사용**: 종합 안내데스크인 `/api/ai/chat`을 거치지 않습니다.
2. **LLM(Ollama) 완전 배제**: 단순 이동 명령은 파이썬 내부의 정규식 매칭(Fast-path)으로 0.01초 만에 끝납니다. 값비싸고 느린 인공지능을 부르지 않습니다.
3. **DB 및 벡터 검색 배제**: 정비 이력을 묻거나 매뉴얼을 묻는 것이 아니므로 SQLite나 numpy 인덱스 파일에 접근조차 하지 않습니다.
4. 프론트엔드는 텍스트(Answer)를 조립하느라 고생할 필요 없이 바로 `ActionExecutor`에 명령을 하달하여 3D 화면을 움직입니다.
