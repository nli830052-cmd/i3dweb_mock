@echo off
chcp 65001 >nul
echo ===================================================
echo i3DWEB AI 백엔드 전체 셋업 스크립트 (All-in-One)
echo ===================================================
echo.

:: 1. 파이썬 설치 확인
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [에러] Python이 설치되어 있지 않습니다. Python을 먼저 설치해 주세요.
    pause
    exit /b 1
)

:: 2. 파이썬 라이브러리 설치
echo [1/3] 파이썬 필수 라이브러리(requirements) 설치 중...
pip install -r backend/requirements.txt
if %errorlevel% neq 0 (
    echo [에러] 라이브러리 설치 중 오류가 발생했습니다.
    pause
    exit /b 1
)
echo [완료] 라이브러리 설치 성공!
echo.

:: 3. 임베딩 모델(BAAI/bge-m3) 자동 다운로드
echo [2/3] 문서 검색용 임베딩 모델(BAAI/bge-m3) 다운로드 중... (최초 1회, 수 분 소요)
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')"
if %errorlevel% neq 0 (
    echo [에러] 임베딩 모델 다운로드 중 문제가 발생했습니다.
    pause
    exit /b 1
)
echo [완료] 임베딩 모델 다운로드 성공!
echo.

:: 4. Ollama 설치 확인 및 LLM 모델 다운로드
echo [3/3] Ollama 엔진 및 LLM 모델(qwen3.5:9b) 확인 중...
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [에러] Ollama가 설치되어 있지 않습니다.
    echo https://ollama.com/ 에서 먼저 다운로드 및 설치를 진행해 주세요.
    pause
    exit /b 1
)

echo 모델(qwen3.5:9b) 다운로드를 시작합니다. (약 5GB, 수 분 소요)
ollama pull qwen3.5:9b
if %errorlevel% neq 0 (
    echo [에러] LLM 모델 다운로드 중 문제가 발생했습니다.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo [축하합니다!] 모든 AI 모델과 라이브러리 셋업이 완료되었습니다.
echo.
echo 터미널에서 다음 명령어로 백엔드 서버를 실행하세요:
echo   python backend/rag_server.py
echo ===================================================
pause
