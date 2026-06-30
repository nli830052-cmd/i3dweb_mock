# i3dweb_mock 전체 모듈 상세 통신 흐름도

사용자가 채팅창에 입력을 한 순간부터, 이 프로젝트에 존재하는 **모든 세부 모듈들이 어떻게 상호작용하는지 생략 없이** 나타낸 시퀀스 다이어그램입니다.

```mermaid
sequenceDiagram
    autonumber
  
    actor User as 사용자
  
    box rgb(225, 245, 254) 프론트엔드 (웹 브라우저)
        participant UI as src/ui/app.js<br/>(화면 UI)
        participant Classifier as src/ai/classifier.js<br/>(로컬 판별기/라우터)
        participant LocalDB as src/ai/*Db.js<br/>(유지보수, 공간 등 로컬캐시)
        participant RagClient as src/ai/ragClient.js<br/>(HTTP 통신 담당)
        participant Executor as src/core/actionExecutor.js<br/>(액션 실행기)
        participant Viewer as src/viewer/mockViewer.js<br/>(Viewer SDK)
    end

    box rgb(255, 243, 224) 백엔드 (파이썬 로컬 서버)
        participant RagServer as backend/rag_server.py<br/>(파이썬 메인 서버)
        participant Search as scripts/search_manuals.py<br/>(벡터 검색 모듈)
        participant SQLite as data/app.db<br/>(정비/워크플로 DB)
        participant VectorDB as data/manual_index.npy<br/>(매뉴얼 벡터 인덱스)
    end
  
    box rgb(241, 248, 233) 외부/로컬 AI 엔진
        participant Ollama as 로컬 Ollama<br/>(qwen3.5:9b)
    end

    %% 1. 사용자 입력 및 프론트엔드 라우팅
    User->>UI: 질문 입력 (예: "GV-101A 정비 이력 알려줘")
    activate UI
    UI->>Classifier: AiBackend.requestAiResponse(request) 호출
    activate Classifier
  
    %% 2. 로컬 판단 및 통신 위임
    Classifier->>Classifier: 질문 분석 (isGroundedQuery 등)
    Classifier->>RagClient: RagClient.chat(message, tag) 호출
    activate RagClient
  
    %% 3. 백엔드로 통신 전송 (HTTP POST)
    RagClient->>RagServer: fetch POST http://localhost:8090/api/ai/chat
    activate RagServer
  
    %% 4. 백엔드의 DB 및 매뉴얼 검색
    RagServer->>SQLite: chat_db_facts() - 정비 이력 조회
    activate SQLite
    SQLite-->>RagServer: DB 레코드 반환
    deactivate SQLite
  
    RagServer->>Search: sm.search(query) - 벡터 검색 요청
    activate Search
    Search->>VectorDB: 코사인 유사도 검색
    activate VectorDB
    VectorDB-->>Search: 유사도 높은 매뉴얼 청크(Hits) 반환
    deactivate VectorDB
    Search-->>RagServer: 매뉴얼 발췌 텍스트 반환
    deactivate Search
  
    %% 5. LLM을 통한 최종 답변 생성
    RagServer->>Ollama: build_chat_synthesis_prompt() 전송 (DB데이터 + 매뉴얼 + 질문)
    activate Ollama
    Ollama-->>RagServer: 생성된 텍스트 및 JSON 반환 (headline, answer, recommendation 등)
    deactivate Ollama
  
    %% 6. 백엔드의 Action Plan 생성 (필요 시)
    RagServer->>Ollama: make_plan() - 화면 조작 Action이 필요한지 질문
    activate Ollama
    Ollama-->>RagServer: {"responseType":"ANSWER_WITH_ACTION", "actions":[{"type":"JUMP_TO"}]} 반환
    deactivate Ollama
  
    %% 7. 백엔드에서 프론트엔드로 응답 반환
    RagServer-->>RagClient: 최종 종합 결과 JSON 응답 반환 (HTTP 200 OK)
    deactivate RagServer
  
    %% 8. 프론트엔드 라우팅 및 폴백(Fallback) 처리
    RagClient-->>Classifier: JSON 데이터 전달
    deactivate RagClient
  
    %% 만약 백엔드가 죽었을 때를 대비한 Classifier 로직 (선택적)
    alt 백엔드 통신 실패 시 (Fallback)
        Classifier->>LocalDB: window.MaintenanceDB.query(tag) 로컬 캐시 조회
        activate LocalDB
        LocalDB-->>Classifier: 브라우저 메모리에 있던 로컬 데이터 반환
        deactivate LocalDB
        Classifier->>Classifier: 로컬 데이터로 비상용 ANSWER 조립
    end
  
    Classifier->>Classifier: executePlan() - 응답 타입을 ANSWER, ACTION 등으로 최종 분류
    Classifier-->>UI: 최종 Response 객체 반환
    deactivate Classifier
  
    %% 9. UI 업데이트 및 3D 뷰어 조작
    UI->>UI: 챗봇 창에 텍스트 (answer, blocks 등) 렌더링
  
    opt actions 배열이 존재할 경우 (화면 제어 명령)
        UI->>Executor: ActionExecutor.executeAction(action)
        activate Executor
        Executor->>Viewer: ViewerSDK.jumpToTag() 등 3D 제어 API 호출
        activate Viewer
        Viewer-->>Executor: 카메라 줌인 / 객체 하이라이트 등 3D 동작 수행
        deactivate Viewer
        Executor-->>UI: 액션 완료 로그 반환
        deactivate Executor
    end
  
    UI-->>User: 챗봇 대답 표시 및 3D 화면 조작 완료
    deactivate UI
```

### 🔍 다이어그램 주요 모듈 설명

1. **`src/ui/app.js`**: 사용자의 입력을 가로채고, 모든 과정이 끝난 뒤 최종적으로 챗봇 말풍선과 UI를 화면에 그립니다.
2. **`src/ai/classifier.js`**: 프론트엔드의 메인 두뇌입니다. 백엔드로 통신을 넘길지 말지 결정하고, 백엔드가 죽었을 때 `src/ai/maintenanceDb.js` 같은 **로컬 DB(캐시)**를 뒤져서 비상 대답을 만들어내는 역할을 합니다.
3. **`src/ai/ragClient.js`**: 파이썬과 `fetch`로 통신하는 배달부 역할만 수행합니다.
4. **`backend/rag_server.py`**: 백엔드의 메인 두뇌입니다. 들어온 질문을 보고 `sqlite3`(정형 데이터)를 뒤질지, `scripts/search_manuals.py`(비정형 매뉴얼)를 뒤질지 결정합니다.
5. **로컬 Ollama**: 파이썬이 찾아낸 DB 기록과 매뉴얼 원문을 조합해서 사람이 읽기 좋은 문장과 화면 제어용 뼈대(JSON)를 만들어줍니다.
6. **`src/core/actionExecutor.js` & `ViewerSDK`**: AI가 만들어낸 명령어를 실제 3D 화면 엔진이 이해할 수 있는 함수로 변환하여 실행합니다.
