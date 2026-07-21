/* ============================================================
 *  src/ui/app.js  —  [Frontend / UI · 오케스트레이션]
 *  전체 흐름의 진입점. 렌더링 + API 흐름 패널 + 이벤트 바인딩.
 *
 *  흐름: onSend()
 *    [1] Frontend → AI 백엔드 (HTTP 요청)        AiBackend.requestAiResponse()
 *    [2] AI 백엔드 → Frontend (HTTP 응답/에러)
 *    [3] responseType 분기 → runActions()
 *    [4] Frontend → Viewer (SDK) → 콜백          ActionExecutor.executeAction()
 *
 *  의존: AiBackend(ai/classifier.js), ActionExecutor(core/actionExecutor.js)
 * ========================================================== */
(function () {
  "use strict";

  const SESSION_ID = "sess-" + Math.random().toString(36).slice(2, 8);
  const TURBINE_TAG = "5-4H31-J043C3";

  // ── DOM refs ─────────────────────────────────────────────
  const chatEl = document.getElementById("chat");
  const jsonEl = document.getElementById("jsonOut");
  const logEl = document.getElementById("logOut");
  const viewerTagEl = document.getElementById("viewerTag");
  const apiFlowEl = document.getElementById("apiFlow");
  const inputEl = document.getElementById("userInput");
  const attachmentPreviewEl = document.getElementById("attachmentPreview");
  let pendingImageDataUrl = null;

  /* ── 진입점 ───────────────────────────────────────────── */
  async function onSend(opts) {
    opts = opts || {};
    const text = inputEl.value.trim();
    if (pendingImageDataUrl) {
      if (!text) {
        inputEl.placeholder = "첨부 사진과 함께 질문을 입력해 주세요.";
        inputEl.focus();
        return;
      }
      const imageDataUrl = pendingImageDataUrl;
      clearPendingImage();
      await onSendImage(imageDataUrl, text);
      return;
    }
    if (!text) return;
    addUserMsg(text);
    resetApiFlow();

    // [1] Frontend → AI 백엔드 (HTTP 요청) — AI팀 영역
    const request = {
      sessionId: SESSION_ID,
      message: text,
      viewerContext: { currentTag: viewerTagEl.textContent === "—" ? null : viewerTagEl.textContent }
    };
    pushFlow({ owner: "ai", dir: "req", transport: "http", endpoint: "POST /api/ai/chat", meta: "Content-Type: application/json", payload: request });
    startThinking();   // "AI가 생각하는 과정" 표시 (classifier가 단계 이벤트를 쏨)

    let res;
    try {
      res = await AiBackend.requestAiResponse(request, { simulateError: opts.simulateError });
    } catch (err) {
      stopThinking();
      // [2-에러] AI 백엔드 → Frontend (HTTP 에러) — AI팀 영역
      const status = (err && err.status) || 500;
      pushFlow({
        owner: "ai", dir: "res", transport: "http", error: true,
        endpoint: status + " Internal Server Error  ·  /api/ai/chat",
        meta: "~" + (30 + Math.floor(Math.random() * 40)) + "ms",
        payload: (err && err.body) || { error: "INTERNAL_ERROR" }
      });
      renderBotError("AI 서버 오류로 응답을 받지 못했습니다. (HTTP " + status + ")");
      jsonEl.classList.remove("empty");
      jsonEl.textContent = JSON.stringify({ error: (err.body && err.body.error) || "INTERNAL_ERROR", status: status }, null, 2);
      setLog(["HTTP " + status + " — AI 백엔드 응답 실패", "responseType 판단 불가 → 액션 미실행"]);
      inputEl.value = ""; inputEl.focus();
      return;
    }
    stopThinking();

    // [1b] (규칙 미매칭 시) LLM이 action JSON 직접 생성 — AI팀 영역
    if (res.plan) {
      pushFlow({
        owner: "ai", dir: "req", transport: "llm",
        endpoint: `${res.plan.model}.plan(message)`, meta: "action JSON 생성 (LLM 의도 해석)",
        payload: { model: res.plan.model, message: text }
      });
      pushFlow({
        owner: "ai", dir: "res", transport: "llm",
        endpoint: "action JSON", meta: res.plan.engine || "로컬 추론",
        payload: { actions: res.plan.actions }
      });
    }

    // [1c] 오늘 점검 브리핑 — 멀티스텝 에이전트 시퀀스로 전환
    if (res.responseType === "BRIEFING") {
      await runBriefing();
      inputEl.value = ""; inputEl.focus();
      return;
    }

    // [2a] (grounded 응답 시) AI 백엔드 내부 RAG/CMMS 조회 — AI팀 영역
    if (res.retrieval) {
      const downer = res.retrieval.owner || "ai"; // CMMS=AI팀 / Walkinside 공간=솔루션팀
      pushFlow({
        owner: downer, dir: "req", transport: "data",
        endpoint: `query(${res.retrieval.query})`, meta: res.retrieval.source,
        payload: { source: res.retrieval.source, query: res.retrieval.query }
      });
      pushFlow({
        owner: downer, dir: "res", transport: "data",
        endpoint: `${res.retrieval.hitCount} record(s) · grounded=${!!res.grounded}`, meta: "~30ms",
        payload: { hitCount: res.retrieval.hitCount, grounded: !!res.grounded, data: res.retrieval.data || null, sources: res.sources || [] }
      });
    }

    // [2b] (RAG 답변 생성 시) 로컬 LLM 종합 — AI팀 영역
    if (res.generation) {
      pushFlow({
        owner: "ai", dir: "req", transport: "llm",
        endpoint: `${res.generation.model}.generate(context, query)`, meta: res.generation.engine,
        payload: { model: res.generation.model, context_chunks: res.generation.chunks, instruction: "검색된 매뉴얼 청크만 근거로 한국어 답변 종합 (환각 방지)" }
      });
      pushFlow({
        owner: "ai", dir: "res", transport: "llm",
        endpoint: "generated answer", meta: res.generation.engine || "로컬 추론",
        payload: { model: res.generation.model, answer: res.answer }
      });
    }

    // [2] AI 백엔드 → Frontend (HTTP 응답) — AI팀 영역
    pushFlow({ owner: "ai", dir: "res", transport: "http", endpoint: "200 OK  ·  /api/ai/chat", meta: "~" + (40 + Math.floor(Math.random() * 60)) + "ms", payload: res });

    handleResponse(res);
    inputEl.value = ""; inputEl.focus();
  }

  /* ── Frontend 역할: responseType 분기 ─────────────────── */
  function handleResponse(res) {
    renderChat(res);
    renderJson(res);
    if (res.responseType === "ACTION" || res.responseType === "ANSWER_WITH_ACTION") {
      runActions(res);
    } else if (res.retrieval) {
      setLog([
        `responseType: ${res.responseType} (grounded=${!!res.grounded})`,
        `RAG/CMMS 조회: ${res.retrieval.source}`,
        `query: ${res.retrieval.query} → ${res.retrieval.hitCount} record(s)`,
        `출처: ${(res.sources || []).map((s) => s.label || s.documentName).join(", ") || "-"}`,
        "Viewer 동작 없음 (답변 전용)"
      ]);
    } else {
      setLog([`responseType: ${res.responseType}`, "실행할 action 없음 → 챗봇 답변만 출력", "Viewer 동작 없음"]);
    }
  }

  function runActions(res) {
    const lines = [`responseType: ${res.responseType}`];
    res.actions.forEach((action, i) => {
      lines.push(`--- action[${i}] ---`);

      // 액션 타입 → SDK 호출 표현 (연결고리가 매핑)
      const desc = ActionExecutor.describe(action);

      // [3] Frontend → i3DWEB Viewer (SDK 호출 요청) — 솔루션팀 영역
      pushFlow({
        owner: "sol", dir: "req", transport: "sdk",
        endpoint: desc.endpoint,
        meta: "Viewer SDK call",
        payload: desc.payload
      });

      const result = ActionExecutor.executeAction(action);

      // [4] i3DWEB Viewer → Frontend (콜백 응답) — 솔루션팀 영역
      pushFlow({
        owner: "sol", dir: "res", transport: "sdk", error: !result.ok,
        endpoint: `${desc.payload.method} → ${result.ok ? "callback" : "error callback"}`,
        meta: result.ok ? "~12ms" : "~9ms",
        payload: Object.assign({ ok: result.ok, action: action.type }, omit(result, ["ok", "message"]))
      });

      lines.push(`type: ${action.type}`);
      lines.push(result.ok
        ? `<span class="ok">결과: ${result.message}</span>`
        : `<span class="err">실패: ${result.error} — ${result.message}</span>`);
    });
    setLog(lines);
  }

  /* ── 렌더링 헬퍼 ──────────────────────────────────────── */
  function renderChat(res) {
    clearEmpty(chatEl);
    const cat = categoryOf(res);
    const bot = document.createElement("div");
    bot.className = "msg bot" + (cat.key ? " cat-" + cat.key : "") +
      (res.uiKind ? " ui-" + String(res.uiKind).replace(/[^a-z0-9_-]/gi, "") : "");
    const hideManualMeta = cat.key === "manual";
    const hideRecommendation = cat.key === "maintenance" && res.answerTitle === "AI 요약";
    // ①판정+②데이터는 즉시 표시, ③답변은 타이핑 효과, ④권고+⑤근거는 타이핑 완료 후
    const tail =
      (res.recommendation && !hideRecommendation ? `<div class="reco">▸ ${escapeHtml(res.recommendation)}</div>` : "") + // ④ 권고
      sourceBlock(res) +                                                                    // ⑤ 근거 칩
      excerptBlock(res);                                                                    // ⑤ 매뉴얼 발췌(접이식)
    bot.innerHTML =
      (cat.label ? `<div class="card-head"><span class="cat-chip cat-${cat.key}">${cat.label}</span></div>` : "") +
      (res.headline && !hideManualMeta ? `<div class="headline">${escapeHtml(res.headline)}</div>` : "") + // ① 판정
      (res.message ? `<div>${escapeHtml(res.message)}</div>` : "") +
      (res.blocks && res.blocks.length ? renderBlocks(res.blocks) : detailBlock(cat.key, res)) + // ② 구조화 데이터
      (res.answer ? (res.answerTitle
        ? `<div class="ans-box"><div class="ans-title">${escapeHtml(res.answerTitle)}</div><div class="ans"></div></div>`
        : `<div class="ans"></div>`) : "");                                                 // ③ 자리 (타이핑)
    chatEl.appendChild(bot);
    chatEl.scrollTop = chatEl.scrollHeight;
    if (res.answer) {
      const ansEl = bot.querySelector(".ans");
      typeText(ansEl, String(res.answer), () => {
        ansEl.innerHTML = answerToHtml(res);   // 타이핑 끝 → 마크다운/전용 UI로 교체
        if (tail) bot.insertAdjacentHTML("beforeend", tail);
        appendActions(bot);
        chatEl.scrollTop = chatEl.scrollHeight;
      });
    } else {
      if (tail) bot.insertAdjacentHTML("beforeend", tail);
      appendActions(bot);
    }
  }

  /* ── ChatGPT풍 답변 하단 액션 (복사 · 좋아요 · 싫어요 · 전송) ── */
  const AICO = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    like: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>',
    dislike: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>',
    share: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>'
  };
  function appendActions(bot) {
    if (bot.querySelector(".msg-actions")) return;
    const row = document.createElement("div");
    row.className = "msg-actions";
    row.innerHTML =
      `<button type="button" data-act="copy" title="복사">${AICO.copy}</button>` +
      `<button type="button" data-act="like" title="좋아요">${AICO.like}</button>` +
      `<button type="button" data-act="dislike" title="별로예요">${AICO.dislike}</button>` +
      `<button type="button" data-act="share" title="전송">${AICO.share}</button>`;
    bot.appendChild(row);
    row.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "copy") {
        copyMessage(bot, btn);
      } else if (act === "like" || act === "dislike") {
        row.querySelectorAll('[data-act="like"],[data-act="dislike"]').forEach((b) => { if (b !== btn) b.classList.remove("active"); });
        btn.classList.toggle("active");
      } else if (act === "share") {   // mock: 전송 확인 표시만
        btn.classList.add("ok");
        setTimeout(() => btn.classList.remove("ok"), 900);
      }
    });
  }
  function copyMessage(bot, btn) {
    const clone = bot.cloneNode(true);
    const r = clone.querySelector(".msg-actions");
    if (r) r.remove();
    const txt = clone.innerText.trim();
    const done = () => {
      btn.innerHTML = AICO.check; btn.classList.add("ok");
      setTimeout(() => { btn.innerHTML = AICO.copy; btn.classList.remove("ok"); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => { legacyCopy(txt); done(); });
    } else { legacyCopy(txt); done(); }
  }
  function legacyCopy(txt) {   // file:// 등 clipboard API 미지원 환경 폴백
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove();
  }

  /* ── [박람회] 타이핑 효과 + 생각 과정 표시 ──────────────── */
  function typeText(el, text, done) {
    const n = text.length;
    const step = Math.max(1, Math.ceil(n / 110));   // 길이와 무관하게 약 2.2초 내 완료
    let i = 0;
    el.classList.add("typing");
    const t = setInterval(() => {
      i += step;
      el.textContent = text.slice(0, i);
      chatEl.scrollTop = chatEl.scrollHeight;
      if (i >= n) { clearInterval(t); el.classList.remove("typing"); if (done) done(); }
    }, 20);
  }

  // 브리핑 등에서 쓰는 "타이핑되는 봇 메시지 한 개" (완료 시 resolve)
  // blocks: 서버가 준 구조화 데이터(kv/list/table/steps) — 타이핑 완료 후 리치 UI로 표시
  function typeBotMessage(text, extraClass, blocks) {
    return new Promise((resolve) => {
      clearEmpty(chatEl);
      const bot = document.createElement("div");
      bot.className = "msg bot" + (extraClass ? " " + extraClass : "");
      const div = document.createElement("div");
      div.className = "ans";
      bot.appendChild(div);
      chatEl.appendChild(bot);
      typeText(div, text, () => {
        div.innerHTML = mdToHtml(text);
        if (blocks && blocks.length) {
          bot.insertAdjacentHTML("beforeend", renderBlocks(blocks));
          chatEl.scrollTop = chatEl.scrollHeight;
        }
        resolve(bot);
      });
    });
  }

  const THINK_STAGES = {
    intent:   "요청을 분석하고 있습니다...",
    retrieve: "정비 이력과 매뉴얼을 조회하고 있습니다...",
    generate: "점검 내용을 정리하고 있습니다...",
    vision:   "현장 사진을 판독하고 있습니다..."
    // brief는 날짜 동적 생성 → briefLabel()
  };
  function briefLabel() {
    const now = new Date();
    return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 기준 점검 내용을 정리하고 있습니다...`;
  }
  let thinkEl = null;
  function startThinking(firstStage) {
    stopThinking();
    clearEmpty(chatEl);
    thinkEl = document.createElement("div");
    thinkEl.className = "msg bot thinking";
    thinkEl.innerHTML = `<div class="think-steps"></div>` +
      `<div class="think-dots"><span></span><span></span><span></span></div>`;
    chatEl.appendChild(thinkEl);
    chatEl.scrollTop = chatEl.scrollHeight;
    if (firstStage) thinkStage(firstStage);
  }
  function thinkStage(stage) {
    if (!thinkEl) return;
    const list = thinkEl.querySelector(".think-steps");
    // 단계가 쌓이지 않고 한 줄이 교체되는 방식 (깔끔한 진행 표시)
    const label = stage === "brief" ? briefLabel() : (THINK_STAGES[stage] || stage);
    list.innerHTML = "";
    const li = document.createElement("div");
    li.className = "think-step on";
    li.textContent = label;
    list.appendChild(li);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  function stopThinking() {
    if (thinkEl) { thinkEl.remove(); thinkEl = null; }
  }
  window.AiProgress = thinkStage;   // classifier.js가 단계 이벤트를 이 콜백으로 쏨

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ── 답변 카테고리 판별 (응답 메타 → UI 카드 종류) ────── */
  function categoryOf(res) {
    const src = (res.retrieval && res.retrieval.source) || "";
    if (src.indexOf("정비이력") >= 0) return { key: "maintenance", label: "정비이력" };
    if (src.indexOf("정비주기") >= 0) return { key: "cycle", label: "정비주기" };
    if (src.indexOf("Walkinside") >= 0) return { key: "spatial", label: "작업조건" };
    if (src.indexOf("작업오더") >= 0) return { key: "workflow", label: "작업단계" };
    if (res.generation || src.indexOf("매뉴얼") >= 0) return { key: "manual", label: "매뉴얼 RAG" };
    if (res.responseType === "ACTION") return { key: "action", label: "뷰어 조작" };
    return { key: "", label: "" };
  }

  function kv(label, val, warn) {
    return `<span class="kv${warn ? " warn" : ""}"><i>${escapeHtml(label)}</i><b>${escapeHtml(String(val))}</b></span>`;
  }

  /* ── 카테고리별 구조화 상세 블록 (retrieval.data 기반) ── */
  function detailBlock(key, res) {
    const d = res.retrieval && res.retrieval.data;

    // ━━━━ 정비이력: 전문 테이블 UI ━━━━
    if (key === "maintenance" && d) {
      let html = '';

      // ① 핵심 지표 카드 행
      const metrics = [];
      if (d.lastOverhaul && d.lastOverhaul.date)
        metrics.push(metricCard("최근 분해정비", d.lastOverhaul.date, "", "icon-wrench"));
      if (d.leaks != null)
        metrics.push(metricCard("누설 이력", d.leaks.length + "건", d.leaks.length > 0 ? "warn" : "ok", "icon-drop"));
      if (d.openPoints != null)
        metrics.push(metricCard("Open Point", d.openPoints.length + "건", d.openPoints.length > 0 ? "warn" : "ok", "icon-alert"));
      if (metrics.length)
        html += `<div class="maint-metrics">${metrics.join('')}</div>`;

      // ② 반복 이슈 배너 (있을 때만)
      if (d.recurring && !d.recurring.includes("없음"))
        html += `<div class="maint-recurring"><span class="maint-recurring-icon">⚠</span><span>${escapeHtml(d.recurring)}</span></div>`;

      // ③ 정비 이력 테이블
      if (d.history && d.history.length) {
        html += `<div class="maint-section-title">정비 이력</div>`;
        html += `<table class="maint-table">`;
        html += `<thead><tr><th>날짜</th><th>WO번호</th><th>작업유형</th><th>결과</th></tr></thead><tbody>`;
        d.history.forEach(function(h) {
          const resultCls = h.result && h.result.includes('정상') ? 'st-done' :
                            h.result && (h.result.includes('필요') || h.result.includes('중')) ? 'st-check' : 'st-pending';
          html += `<tr>`;
          html += `<td class="maint-date">${escapeHtml(h.date || '-')}</td>`;
          html += `<td class="maint-wo">${escapeHtml(h.wo || '-')}</td>`;
          html += `<td>${escapeHtml(h.type || '-')}</td>`;
          html += `<td><span class="b-status ${resultCls}">${escapeHtml(h.result || '-')}</span></td>`;
          html += `</tr>`;
          if (h.note) html += `<tr class="maint-note-row"><td colspan="4" class="maint-note">${escapeHtml(h.note)}</td></tr>`;
        });
        html += `</tbody></table>`;
      }

      // ④ Open Point 테이블 (있을 때만)
      if (d.openPoints && d.openPoints.length) {
        html += `<div class="maint-section-title maint-warn-title">⚠ Open Point</div>`;
        html += `<table class="maint-table">`;
        html += `<thead><tr><th>ID</th><th>내용</th><th>조치 예정일</th><th>상태</th></tr></thead><tbody>`;
        d.openPoints.forEach(function(o) {
          const stCls = o.status && o.status.includes('중') ? 'st-check' : 'st-todo';
          html += `<tr>`;
          html += `<td class="maint-wo">${escapeHtml(o.id || '-')}</td>`;
          html += `<td>${escapeHtml(o.desc || '-')}</td>`;
          html += `<td class="maint-date">${escapeHtml(o.due || '-')}</td>`;
          html += `<td><span class="b-status ${stCls}">${escapeHtml(o.status || '-')}</span></td>`;
          html += `</tr>`;
        });
        html += `</tbody></table>`;
      }
      return html ? `<div class="maint-detail">${html}</div>` : '';
    }

    // ━━━━ 정비주기: 전문 카드 UI ━━━━
    if (key === "cycle" && d) {
      let html = '';

      // ① 주기 상태 배너
      const overdueFlag = d.overdue;
      const statusLabel = overdueFlag ? '주기 초과 — 점검 필요' : '정비 주기 정상';
      const statusCls2  = overdueFlag ? 'cycle-overdue' : 'cycle-ok';
      html += `<div class="cycle-status ${statusCls2}"><span class="cycle-status-dot"></span>${escapeHtml(statusLabel)}</div>`;

      // ② 주기 KV 테이블
      html += `<table class="cycle-kv-table">`;
      if (d.cycleMonths != null)
        html += `<tr><th>정비 주기</th><td>${escapeHtml(d.cycleMonths + '개월')}</td></tr>`;
      if (d.lastMaintenance)
        html += `<tr><th>정기점검 기준일</th><td>${escapeHtml(d.lastMaintenance)}</td></tr>`;
      if (d.nextDue)
        html += `<tr><th>다음 예정일</th><td class="${overdueFlag ? 'cycle-td-warn' : ''}">${escapeHtml(d.nextDue)}</td></tr>`;
      html += `</table>`;

      // ③ 우선 점검 부품 (태그형)
      if (d.priorityParts && d.priorityParts.length) {
        html += `<div class="cycle-parts-title">우선 점검 부품</div>`;
        html += `<div class="cycle-parts">${d.priorityParts.map(function(p) {
          return `<span class="cycle-part-tag">${escapeHtml(p)}</span>`;
        }).join('')}</div>`;
      }
      return `<div class="cycle-detail">${html}</div>`;
    }

    // ━━━━ 이하 기존 카테고리 (spatial / workflow / manual / action) ━━━━
    if (key === "spatial" && d) {
      const c = [];
      if (d.clearance) {
        if (d.clearance.front != null) c.push(kv("전면 공간", d.clearance.front + "m"));
        if (d.clearance.right != null) c.push(kv("우측 공간", d.clearance.right + "m", d.clearance.right < 1));
      }
      if (d.height != null) c.push(kv("작업 높이", d.height + "m", d.height >= 2));
      if (d.fallHazard) c.push(kv("추락 위험", d.fallHazard.exists ? `${d.fallHazard.dir} ${d.fallHazard.distM}m` : "없음", d.fallHazard.exists));
      return c.length ? `<div class="card-detail">${c.join("")}</div>` : "";
    }
    if (key === "workflow" && d) {
      let html = "";
      if (d.currentStage || d.nextStage) {
        html += `<div class="card-flow"><span class="st">${escapeHtml(d.currentStage || "-")}</span>` +
          `<span class="arrow">→</span><span class="st">${escapeHtml(d.nextStage || "-")}</span></div>`;
      }
      const lists = [];
      if (d.checklist && d.checklist.length) lists.push(`체크리스트: ${escapeHtml(d.checklist.join(", "))}`);
      if (d.prepIncomplete && d.prepIncomplete.length) lists.push(`<span class="miss">미완료: ${escapeHtml(d.prepIncomplete.join(", "))}</span>`);
      if (d.assemblyMissing && d.assemblyMissing.length) lists.push(`<span class="miss">누락: ${escapeHtml(d.assemblyMissing.join(", "))}</span>`);
      if (lists.length) html += `<div class="card-list">${lists.join(" · ")}</div>`;
      return html;
    }
    if (key === "manual") return "";
    if (key === "action" && res.actions && res.actions.length) {
      return `<div class="card-detail">${res.actions.map((a) => kv("액션", a.type)).join("")}</div>`;
    }
    return "";
  }

  /* 정비이력 전용 metric 카드 헬퍼 */
  function metricCard(label, value, modifier, iconCls) {
    const cls = modifier === 'warn' ? ' warn' : modifier === 'ok' ? ' ok' : '';
    return `<div class="metric-card${cls}"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></div>`;
  }

  /* ── ② 구조화 블록 렌더 (list / kv / table / steps) ─────── */
  function statusCls(s) {
    if (s === "완료") return "st-done";
    if (s === "미완료") return "st-todo";
    if (s === "확인 필요" || s === "진행 중") return "st-check";
    return "st-pending"; // 진행 전 등
  }
  function renderBlocks(blocks) {
    return `<div class="blocks">` + blocks.map(renderBlock).join("") + `</div>`;
  }
  function renderBlock(b) {
    const intro = b.intro ? `<div class="b-intro">${escapeHtml(b.intro)}</div>` : "";
    const title = b.title ? `<div class="b-title">${escapeHtml(b.title)}</div>` : "";
    if (b.kind === "pumpRag") {
      const icon = (name) => `<span class="rag-icon rag-icon-${escapeHtml(name || "check")}">${({tool:"🔧",cover:"▣",check:"✓",safety:"♢",hook:"♧",drop:"◉",pulse:"⌁",bolt:"⌁",target:"◎"})[name] || "✓"}</span>`;
      const item = (it) => `<div class="rag-item">${icon(it.icon)}<div class="rag-item-body"><div class="rag-item-title">${escapeHtml(it.title)}</div>` +
        (it.text ? `<div class="rag-item-text">${escapeHtml(it.text)}</div>` : "") +
        (it.steps ? `<ol class="rag-steps">${it.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>` : "") +
        (it.cite ? `<div class="rag-cite">(${escapeHtml(it.cite)})</div>` : "") + `</div></div>`;
      const cols = (b.cols || []).map((c) => `<section class="rag-panel rag-tone-${escapeHtml(c.tone || "blue")}">` +
        `<h3>${escapeHtml(c.title)}</h3>` +
        (c.note ? `<div class="rag-note">${escapeHtml(c.note)}${c.cite ? `<div class="rag-cite">(${escapeHtml(c.cite)})</div>` : ""}</div>` : "") +
        (c.alert ? `<div class="rag-alert"><span class="rag-ban">⊘</span><div><b>${escapeHtml(c.alert.title)}</b><p>${escapeHtml(c.alert.text)}</p><div class="rag-cite">(${escapeHtml(c.alert.cite)})</div></div></div>` : "") +
        (c.hero ? `<div class="rag-hero"><div class="rag-hero-label">♧ ${escapeHtml(c.hero.label)}</div><strong>${escapeHtml(c.hero.value).replace(/\n/g,"<br>")}</strong><p>${escapeHtml(c.hero.text)}</p><div class="rag-cite">(${escapeHtml(c.hero.cite)})</div></div>` : "") +
        (c.products ? `<div class="rag-products">${c.products.map((p,i) => `<div class="rag-product"><span class="product-shape p${i}"></span><b>${escapeHtml(p[0])}</b><small>(${escapeHtml(p[1])})</small></div>`).join("")}</div>` : "") +
        (c.seal ? `<div class="rag-seal"><span class="seal-graphic">◉◉◉</span><ul>${(c.bullets || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div><div class="rag-cite rag-panel-cite">(${escapeHtml(c.cite || "")})</div>` : "") +
        ((c.items || []).map(item).join("")) +
        (c.check ? `<div class="rag-check"><b>▣ FME 체크포인트</b><div>${c.check.map((x) => `<span>✓ ${escapeHtml(x)}</span>`).join("")}</div></div>` : "") +
        `</section>`).join("");
      const refs = `<div class="rag-refs"><b>▣ 참고 문서</b>${(b.refs || []).map((r) => `<span>${escapeHtml(r)}</span>`).join("")}</div>`;
      return `<div class="pump-rag pump-rag-${escapeHtml(b.variant || "")}">${cols}${refs}</div>`;
    }
    if (b.kind === "turbineMonitoring") {
      const metrics = (b.metrics || []).map((m) =>
        `<section class="tm-metric tm-${escapeHtml(m.tone || "info")}">` +
          `<div class="tm-metric-head"><span>${escapeHtml(m.label)}</span><b>${escapeHtml(m.value)}</b><em>${escapeHtml(m.status)}</em></div>` +
          `<div class="tm-track"><span style="width:${Math.max(4, Math.min(100, Number(m.level) || 0))}%"></span></div>` +
          `<p>${escapeHtml(m.description || "")}</p>` +
        `</section>`).join("");
      return `<div class="tm-monitoring-list"><h3>실시간 운전 상태</h3>${metrics}</div>`;
    }
    if (b.kind === "inspectionBriefing") {
      const stats = (b.stats || []).map((s) => `<div class="ib-stat ib-${escapeHtml(s.tone)}"><span>${escapeHtml(s.label)}</span><b>${escapeHtml(String(s.value))}<small>건</small></b></div>`).join("");
      const targets = (b.targets || []).map((t) => `<article class="ib-target ib-${escapeHtml(t.tone)}">` +
        `<div class="ib-target-head"><span class="ib-badge">${escapeHtml(t.status)}</span><div><b>${escapeHtml(t.tag)}</b><span>${escapeHtml(t.name)}</span></div></div>` +
        `<dl><div><dt>점검 항목</dt><dd>${escapeHtml(t.items)}</dd></div><div><dt>정비 주기</dt><dd>${escapeHtml(t.cycle)}</dd></div>` +
        `<div><dt>정기점검 기준일</dt><dd>${escapeHtml(t.last)}</dd></div><div><dt>초과 기간</dt><dd class="${t.overdue !== "-" ? "ib-warn-text" : ""}">${escapeHtml(t.overdue)}</dd></div></dl>` +
        (t.openPoint ? `<div class="ib-open">Open Point · ${escapeHtml(t.openPoint)}</div>` : "") + `</article>`).join("");
      return `<section class="inspection-briefing">` +
        `<header><div><span class="ib-calendar">▣</span><h3>오늘의 점검 브리핑</h3></div><p>${escapeHtml(b.date)} · 기준 시간 ${escapeHtml(b.time)}</p></header>` +
        `<div class="ib-summary ib-summary-mini"><div class="ib-summary-title"><h4>오늘 점검 대상 요약</h4><b>총 4건</b></div><div class="ib-stats">${stats}</div></div>` +
        `<div class="ib-urgent ib-urgent-mini">` +
          `<div class="ib-urgent-head"><span>긴급</span><b>TG-PMP-101 · 원심 펌프</b></div>` +
          `<div class="ib-urgent-metrics">` +
            `<div><span>▣ 정비 주기 초과</span><b>116일</b></div>` +
            `<div><span>▣ 주기 만료일</span><b>2026-03-21</b></div>` +
          `</div>` +
          `<div class="ib-urgent-check"><span>ⓘ 확인 필요 사항</span><b>그랜드패킹부 미세 누설 및 모터 베어링 진동 재확인 필요</b></div>` +
        `</div>` +
        `<h4 class="ib-section-title">점검 대상 목록 <span>4건</span></h4><div class="ib-targets">${targets}</div>` +
        `<footer>점검 완료 후 결과를 등록해 주세요. 완료 시 다음 점검 일정이 자동 업데이트됩니다.</footer>` +
      `</section>`;
    }
    if (b.kind === "kv") {
      const rows = (b.rows || []).map((r) =>
        `<div class="b-kv-row${r.warn ? " warn" : ""}"><span class="b-k">${escapeHtml(r.k)}</span><span class="b-v">${escapeHtml(String(r.v))}</span></div>`).join("");
      return `<div class="b-block">${intro}${title}<div class="b-kv">${rows}</div></div>`;
    }
    if (b.kind === "list") {
      const tag = b.ordered ? "ol" : "ul";
      const items = (b.items || []).map((it) => {
        const st = it.status ? ` <span class="b-status ${statusCls(it.status)}">${escapeHtml(it.status)}</span>` : "";
        const subs = (it.subs && it.subs.length) ? `<ul class="b-subs">${it.subs.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "";
        return `<li><span class="b-main">${escapeHtml(it.main)}</span>${st}${subs}</li>`;
      }).join("");
      return `<div class="b-block">${intro}${title}<${tag} class="b-list">${items}</${tag}></div>`;
    }
    if (b.kind === "table") {
      const head = `<tr>${(b.head || []).map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const rows = (b.rows || []).map((r) =>
        `<tr>${r.map((c, i) => i === b.statusCol
          ? `<td><span class="b-status ${statusCls(c)}">${escapeHtml(c)}</span></td>`
          : `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
      return `<div class="b-block">${intro}${title}<table class="b-table">${head}${rows}</table></div>`;
    }
    if (b.kind === "steps") {
      const items = (b.items || []).map((s, i) =>
        `<div class="b-step ${statusCls(s.status)}"><span class="b-step-n">${i + 1}</span><span class="b-step-name">${escapeHtml(s.name)}</span><span class="b-status ${statusCls(s.status)}">${escapeHtml(s.status)}</span></div>`).join("");
      const prog = b.progress ? `<div class="b-progress">${escapeHtml(b.progress)}</div>` : "";
      return `<div class="b-block">${intro}${title}<div class="b-steps">${items}</div>${prog}</div>`;
    }
    if (b.kind === "equip") {   // 설비 헤더 카드: 아이콘 + 태그/상태 + 메타 + 스탯 4종
      const chip = b.status && b.status !== "주의"
        ? `<span class="eq-status ${b.statusWarn ? "warn" : "ok"}">${escapeHtml(b.status)}</span>`
        : "";
      const meta = (b.meta || []).filter(Boolean).map(escapeHtml).join('<span class="eq-sep">|</span>');
      const stats = (b.stats || []).map((s) =>
        `<div class="eq-stat${s.warn ? " warn" : ""}"><div class="eq-k">${escapeHtml(s.k)}</div>` +
        `<div class="eq-v">${escapeHtml(String(s.v))}</div>` +
        (s.sub ? `<div class="eq-sub">${escapeHtml(s.sub)}</div>` : "") + `</div>`).join("");
      return `<div class="b-block eq-card">` +
        `<div class="eq-head"><div class="eq-icon">${equipmentSvg(b.tag)}</div>` +
        `<div class="eq-title"><div class="eq-tag">${escapeHtml(b.tag || "")} ${chip}</div>` +
        `<div class="eq-meta">${meta}</div></div></div>` +
        `<div class="eq-stats">${stats}</div></div>`;
    }
    if (b.kind === "histTable") {   // 정비이력 리치 표: 구분/결과 칩 + 불릿 + 작업자/WO/첨부
      const kindCls = (t) => /누설/.test(t) ? "k-leak" : /분해/.test(t) ? "k-major" : /재점검/.test(t) ? "k-recheck" : "k-check";
      const resCls = (t) => /^정상/.test(String(t)) ? "st-done" : "st-check";
      const vis = b.visible || 5;
      const rows = (b.rows || []).map((r, i) =>
        `<tr${i >= vis ? ' class="hist-extra hidden"' : ""}>` +
        `<td class="h-date">${escapeHtml(r.date)}</td>` +
        `<td><span class="h-kind ${kindCls(r.kind)}">${escapeHtml(r.kind)}</span></td>` +
        `<td><ul class="h-items">${(r.items || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></td>` +
        `<td><span class="b-status ${resCls(r.result)}">${escapeHtml(r.result)}</span></td>` +
        `<td class="h-worker">${escapeHtml(r.worker || "-")}</td>` +
        `<td class="h-wo">${escapeHtml(r.wo || "-")}</td></tr>`).join("");
      const head = `<div class="b-title">${escapeHtml(b.title || "정비이력")} <span class="h-note">${escapeHtml(b.note || "")}</span></div>`;
      const foot = (b.rows || []).length > vis
        ? `<div class="hist-more">전체 이력 ${b.total || b.rows.length}건 보기</div>` : "";
      return `<div class="b-block">${intro}${head}<div class="hist-wrap"><table class="hist-table"><thead><tr>` +
        `<th>정비일</th><th>구분</th><th>작업 내용</th><th>작업 결과</th><th>작업자</th><th>작업오더</th>` +
        `</tr></thead><tbody>${rows}</tbody></table></div>${foot}</div>`;
    }
    if (b.kind === "procedure") {   // 정비점검절차 카드: 절차서 헤더 + workflow 흐름도 + 섹션 상세
      const meta = (b.meta || []).map((m) =>
        `<div class="proc-meta-item"><div class="proc-meta-k">${procIco(m.icon)}<span>${escapeHtml(m.k)}</span></div>` +
        `<div class="proc-meta-v">${escapeHtml(m.v).replace(/\n/g, "<br>")}</div></div>`).join("");
      const steps = (b.steps || []).map((s, i) =>
        (i > 0 ? `<div class="proc-step-arrow">${procIco("chevRight")}</div>` : "") +
        `<div class="proc-step${s.active ? " active" : ""}">${procIco(s.icon)}<span>${s.no}. ${escapeHtml(s.name)}</span></div>`).join("");
      const sections = (b.sections || []).map((sec) =>
        `<div class="b-block proc-section"><div class="proc-sec-title">${sec.no}. ${escapeHtml(sec.title)}</div>` +
        (sec.items || []).map((it, i) =>
          `<div class="proc-item"><span class="proc-item-no">${sec.no}.${i + 1}</span><span class="proc-item-tx">${escapeHtml(it)}</span></div>`).join("") +
        `</div>`).join("");
      const cont = b.continueNote
        ? `<div class="proc-continue">${procIco("chevDown")}<span>${escapeHtml(b.continueNote)}</span></div>` : "";
      const foot = (b.footer || []).length
        ? `<div class="proc-foot">` + b.footer.map((f) =>
            `<button type="button" class="proc-foot-btn"${f.act ? ` data-proc-act="${escapeHtml(f.act)}" data-proc-target="${escapeHtml(f.target || "")}"` : ""}>` +
            `${procIco(f.icon)}<span>${escapeHtml(f.label)}</span></button>`).join("") + `</div>`
        : "";
      return `<div class="proc-card">` +
        `<div class="b-block proc-head">` +
          `<img class="proc-img" src="${escapeHtml(b.image)}" alt="${escapeHtml(b.title)}" />` +
          `<div class="proc-head-main">` +
            `<div class="proc-title-row"><span class="proc-title">${escapeHtml(b.title)}</span>` +
            `<span class="proc-doc-badge">${escapeHtml(b.docBadge)}</span>` +
            (b.srcBtn ? `<button type="button" class="proc-src-btn">${procIco("doc")}<span>${escapeHtml(b.srcBtn)}</span></button>` : "") +
            `</div>` +
            `<div class="proc-meta">${meta}</div>` +
          `</div>` +
        `</div>` +
        `<div class="b-block proc-steps">${steps}</div>` +
        sections + cont + foot + `</div>`;
    }
    if (b.kind === "image") {
      return `<div class="b-block">${intro}${title}
        <div class="b-image">
          <img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.alt || "")}" style="max-width: 100%; border-radius: 8px; margin-top: 8px; display: block;" />
          ${b.caption ? `<div class="b-caption" style="font-size: 12px; color: gray; margin-top: 4px; text-align: center;">${escapeHtml(b.caption)}</div>` : ""}
        </div>
      </div>`;
    }
    return "";
  }

  /* ── 설비 카드용 SVG 아이콘 (글로브 밸브 · 클립) ─────────── */
  function valveSvg() {
    return `<svg viewBox="0 0 48 48" width="40" height="40" xmlns="http://www.w3.org/2000/svg">` +
      `<line x1="2" y1="30" x2="46" y2="30" stroke="#1056a8" stroke-width="3"/>` +
      `<path d="M10 20 L10 40 L24 30 Z" fill="#2f6cb5"/>` +
      `<path d="M38 20 L38 40 L24 30 Z" fill="#2f6cb5"/>` +
      `<line x1="24" y1="18" x2="24" y2="30" stroke="#1056a8" stroke-width="3"/>` +
      `<circle cx="24" cy="12" r="6" fill="#fff" stroke="#1056a8" stroke-width="3"/></svg>`;
  }

  function pumpSvg() {
    return `<svg viewBox="0 0 56 48" width="46" height="40" xmlns="http://www.w3.org/2000/svg" aria-label="원심펌프">` +
      `<rect x="4" y="39" width="48" height="4" rx="2" fill="#a9c8ea"/>` +
      `<circle cx="21" cy="25" r="13" fill="#e8f3ff" stroke="#1056a8" stroke-width="3"/>` +
      `<path d="M21 17c6 0 10 4 10 8s-4 8-10 8c3-2 5-5 5-8s-2-6-5-8z" fill="#2f80d0"/>` +
      `<circle cx="21" cy="25" r="3" fill="#1056a8"/>` +
      `<rect x="34" y="19" width="15" height="12" rx="2" fill="#2f6cb5"/>` +
      `<path d="M36 22h11M36 26h11" stroke="#d9ebff" stroke-width="1.5"/>` +
      `<rect x="49" y="22" width="5" height="6" rx="1" fill="#1056a8"/>` +
      `<path d="M17 12V6h13v7" fill="none" stroke="#1056a8" stroke-width="3" stroke-linejoin="round"/>` +
      `<path d="M8 25H2" stroke="#1056a8" stroke-width="4" stroke-linecap="round"/>` +
      `</svg>`;
  }

  function equipmentSvg(tag) {
    return /PMP|PUMP/i.test(String(tag || "")) ? pumpSvg() : valveSvg();
  }
  /* ── 정비점검절차 카드용 스트로크 아이콘 세트 ─────────────── */
  const PROC_ICO_PATHS = {
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>',
    shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline>',
    funnel:    '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>',
    flame:     '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path>',
    chevRight: '<polyline points="9 18 15 12 9 6"></polyline>',
    chevDown:  '<polyline points="6 9 12 15 18 9"></polyline>',
    doc:       '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
    download:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
    alert:     '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
    move:      '<polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="15 19 12 22 9 19"></polyline><polyline points="19 9 22 12 19 15"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line>',
    equip:     '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>',
    rev:       '<polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
    goal:      '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
  };
  function procIco(name, size) {
    const p = PROC_ICO_PATHS[name];
    if (!p) return "";
    const s = size || 15;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  function clipSvg() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`;
  }

  /* ── ⑤ 근거 칩 (소스 타입별: CMMS/WO/공간/매뉴얼) ───────── */
  const SRC_LABEL = { maintenance: "CMMS", cycle: "CMMS", spatial: "공간데이터", workflow: "WO", manual: "매뉴얼" };
  function sourceBlock(res) {
    let list = res.sources || [];
    // 매뉴얼 근거는 아래 접이식 발췌(excerptBlock)로 1회만 표기 → 동일 섹션 칩은 제거(중복 방지)
    const ex = res.manualExcerpt;
    if (ex) list = list.filter((s) => !(s.type === "manual" && (s.detail || "") === (ex.sectionPath || "")));
    if (!list.length) return "";
    const chips = list.map((s) => {
      if (s.type) {  // 신규 형식 {type,label,detail}
        if (s.type === "manual") {  // 매뉴얼: 문서명(label) + 섹션(detail) 모두 표기
          const det = (s.label || "") + (s.detail ? " · " + s.detail : "");
          return `<span class="src-chip src-manual">📄 ${escapeHtml(det)}</span>`;
        }
        const tag = SRC_LABEL[s.type] || s.type;
        const det = s.label || "";
        return `<span class="src-chip src-${s.type}">${escapeHtml(tag)}${det ? " · " + escapeHtml(det) : ""}</span>`;
      }
      return `<span class="src-chip">${escapeHtml(s.documentName + (s.section ? " · " + s.section : ""))}</span>`;  // 구 형식
    }).join("");
    return `<div class="src"><i>근거</i> ${chips}</div>`;
  }

  /* ── 마크다운(표·목록·강조) → HTML : 매뉴얼 발췌/답변을 실제 표·서식으로 ──
     - md 파일의 파이프 표(| a | b |)를 실제 <table>로, #제목·-목록·**강조**도 서식 적용 */
  function mdInline(s) { // s는 이미 escapeHtml된 문자열
    return s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  }
  function mdToHtml(md) {
    const lines = String(md == null ? "" : md).replace(/\r\n/g, "\n").split("\n");
    const sep = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;          // 표 구분선 | --- | --- |
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    let out = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // 1) 파이프 표 — 현재 줄에 |, 다음 줄이 구분선이면 실제 <table>
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && sep.test(lines[i + 1])) {
        const head = cells(line); i += 2;
        const body = [];
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim() !== "" && !sep.test(lines[i])) {
          body.push(cells(lines[i])); i++;
        }
        out += `<table class="md-table"><thead><tr>${head.map((h) => `<th>${mdInline(escapeHtml(h))}</th>`).join("")}</tr></thead><tbody>${
          body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(escapeHtml(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        continue;
      }
      // 2) 제목: #~#### 또는 "14.2 ..." 같은 섹션 번호 줄
      const hm = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (hm) { const lv = Math.min(hm[1].length, 4); out += `<div class="md-h md-h${lv}">${mdInline(escapeHtml(hm[2]))}</div>`; i++; continue; }
      if (/^\s*\d+\.\d+/.test(line) && line.indexOf("|") < 0) { out += `<div class="md-h md-h3">${mdInline(escapeHtml(line.trim()))}</div>`; i++; continue; }
      // 3) 인용
      if (/^\s*>\s?/.test(line)) { out += `<blockquote class="md-quote">${mdInline(escapeHtml(line.replace(/^\s*>\s?/, "")))}</blockquote>`; i++; continue; }
      // 4) 목록 (순서없음 / 순서있음)
      if (/^\s*[-*]\s+/.test(line)) {
        const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
        out += `<ul class="md-ul">${items.map((t) => `<li>${mdInline(escapeHtml(t))}</li>`).join("")}</ul>`; continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out += `<ol class="md-ol">${items.map((t) => `<li>${mdInline(escapeHtml(t))}</li>`).join("")}</ol>`; continue;
      }
      // 5) 빈 줄
      if (line.trim() === "") { i++; continue; }
      // 6) 문단 — 연속된 일반 줄을 <br>로 묶음
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])
             && !/^\s*#{1,6}\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && lines[i].indexOf("|") < 0
             && !/^\s*\d+\.\d+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) out += `<p class="md-p">${para.map((p) => mdInline(escapeHtml(p))).join("<br>")}</p>`;
      else { out += `<p class="md-p">${mdInline(escapeHtml(lines[i]))}</p>`; i++; }   // 표 아닌 단독 | 줄 방어
    }
    return out;
  }

  function answerToHtml(res) {
    const answer = String((res && res.answer) || "");
    if (res && res.uiKind === "turbine-monitoring") {
      const parts = answer.split(/\n*###\s+AI 분석\s*\n*/);
      if (parts.length > 1) {
        return mdToHtml(parts.shift()) +
          `<section class="tm-ai-analysis"><div class="tm-ai-analysis-title">AI 분석</div>` +
          `<div class="tm-ai-analysis-body">${mdToHtml(parts.join("\n"))}</div></section>`;
      }
    }
    return mdToHtml(answer);
  }

  /* ── ⑤ 매뉴얼 발췌 (접이식 — RAG 근거 실재 증명) ────────── */
  function excerptBlock(res) {
    const e = res.manualExcerpt;
    if (!e || !e.text) return "";
    const cite = (e.doc ? e.doc + (e.sectionPath ? " · " + e.sectionPath : "") : (e.sectionPath || ""));
    return `<details class="excerpt"><summary>📄 근거 매뉴얼 발췌 · ${escapeHtml(cite)}</summary>` +
      `<div class="excerpt-body">${mdToHtml(e.text)}</div></details>`;
  }

  function addUserMsg(text) {
    clearEmpty(chatEl);
    const u = document.createElement("div");
    u.className = "msg user";
    u.textContent = text;
    chatEl.appendChild(u);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderBotError(text) {
    clearEmpty(chatEl);
    const bot = document.createElement("div");
    bot.className = "msg bot error";
    bot.innerHTML = `<span class="badge ERROR">ERROR</span><div>${escapeHtml(text)}</div>`;
    chatEl.appendChild(bot);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderJson(res) {
    jsonEl.classList.remove("empty");
    jsonEl.textContent = JSON.stringify(res, null, 2);
  }

  function setLog(lines) {
    logEl.classList.remove("empty");
    logEl.innerHTML = lines.map((l) => `<div class="log-line">${l}</div>`).join("");
  }

  function clearEmpty(container) {
    const welcome = container.querySelector("#chatWelcome");
    if (welcome) welcome.remove();
    const first = container.querySelector(".empty");
    if (first) first.remove();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function omit(obj, keys) {
    const out = {};
    Object.keys(obj || {}).forEach((k) => { if (keys.indexOf(k) === -1) out[k] = obj[k]; });
    return out;
  }

  /* ── API 흐름(요청/응답) 타임라인 ─────────────────────── */
  let flowSeq = 0;
  function resetApiFlow() { apiFlowEl.innerHTML = ""; flowSeq = 0; }

  function pushFlow({ dir, transport, endpoint, meta, payload, owner, error }) {
    flowSeq++;
    const wrap = document.createElement("div");
    wrap.className = "flow" + (error ? " error" : "");
    const dirClass = (dir === "res" && error) ? "errres" : dir;
    const dirLabel = dir === "req" ? "요청 ▶" : "◀ 응답";
    const transportLabel = { http: "HTTP", sdk: "Viewer SDK", data: "DATA", llm: "LLM" }[transport] || transport;
    const ownerLabel = owner === "ai" ? "AI팀" : "솔루션팀";
    wrap.innerHTML =
      `<div class="flow-head">` +
      `<span class="seq">${flowSeq}</span>` +
      `<span class="owner ${owner}">${ownerLabel}</span>` +
      `<span class="dir ${dirClass}">${dirLabel}</span>` +
      `<span class="transport ${transport}">${transportLabel}</span>` +
      `<span class="endpoint">${escapeHtml(endpoint)}</span>` +
      `<span class="meta">${escapeHtml(meta || "")}</span>` +
      `<span class="toggle">▾</span>` +
      `</div>` +
      `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
    wrap.querySelector(".flow-head").addEventListener("click", () => {
      wrap.classList.toggle("collapsed");
      wrap.querySelector(".toggle").textContent = wrap.classList.contains("collapsed") ? "▸" : "▾";
    });
    apiFlowEl.appendChild(wrap);
  }

  /* ── [박람회] 오늘 점검 브리핑 — 챗 입력("오늘 점검할 거 알려줘" 등)으로 발동.
        AI가 단계별로 말하며(내레이션 타이핑 + 구조화 블록) 뷰어를 스스로 조작 ── */
  let briefingRunning = false;
  function localBriefingData() {
    return {
      tag: "TG-PMP-101",
      steps: [
        {
          say: "오늘의 점검 브리핑을 시작합니다.\n우선 점검 대상은 TG-PMP-101 원심 펌프입니다. 해당 장비 위치로 이동합니다.\n정비 주기가 초과되었고 미조치 사항이 남아 있어 **긴급 점검 대상**으로 분류되었습니다.",
          action: { type: "JUMP_TO", targetType: "TAG", targetValue: "TG-PMP-101", params: { zoom: "in" } },
          blocks: [
            { kind: "inspectionBriefing", date: "2026.07.15 (수)", time: "13:39",
              stats: [
                { label: "긴급", value: 1, tone: "danger" }, { label: "주의", value: 1, tone: "warn" },
                { label: "정상", value: 2, tone: "ok" }, { label: "전체", value: 4, tone: "all" }
              ],
              targets: [
                { status: "긴급", tone: "danger", tag: "TG-PMP-101", name: "원심 펌프", items: "부식 상태, 누유, 볼트 체결 상태", cycle: "12개월", last: "2025-03-21", overdue: "약 116일 초과", openPoint: "" },
                { status: "주의", tone: "warn", tag: "P-202B", name: "순환수 펌프", items: "진동, 온도, 누유, 베어링 상태", cycle: "6개월", last: "2025-12-20", overdue: "약 25일 초과", openPoint: "" },
                { status: "정상", tone: "ok", tag: "V-301C", name: "글로브 밸브", items: "개폐 상태, 누유, 패킹 상태", cycle: "18개월", last: "2025-09-05", overdue: "-", openPoint: "" },
                { status: "정상", tone: "ok", tag: "HX-401D", name: "열교환기", items: "전열관 상태, 누설, 차압", cycle: "24개월", last: "2024-11-18", overdue: "-", openPoint: "" }
              ],
              order: [
                { tag: "TG-PMP-101", name: "원심 펌프", status: "긴급", tone: "danger" },
                { tag: "P-202B", name: "순환수 펌프", status: "주의", tone: "warn" },
                { tag: "V-301C", name: "글로브 밸브", status: "정상", tone: "ok" },
                { tag: "HX-401D", name: "열교환기", status: "정상", tone: "ok" }
              ]
            }
          ]
        }
      ],
      facts: { overdueDays: 116, openPoints: 1 },
      generation: { engine: "고정 박람회 브리핑" }
    };
  }
  async function runBriefing() {
    if (briefingRunning) return;
    briefingRunning = true;
    try {
      pushFlow({ owner: "ai", dir: "req", transport: "http", endpoint: "POST /api/ai/briefing",
        meta: "에이전트 브리핑 대본 생성 (DB 실데이터 + LLM)", payload: { sessionId: SESSION_ID } });
      startThinking("brief");
      // 박람회 시연은 항상 동일한 브리핑을 사용한다. 백엔드 상태에 따라 UI가 달라지지 않도록 고정.
      const b = localBriefingData();
      stopThinking();
      pushFlow({ owner: "ai", dir: "res", transport: "http", endpoint: "200 OK  ·  /api/ai/briefing",
        meta: (b.steps || []).length + " steps · " + ((b.generation && b.generation.model) || ""), payload: b });
      renderJson(b);
      const lines = ["에이전트 브리핑 시퀀스 실행"];
      let lastEl = null;
      for (const st of (b.steps || [])) {
        lastEl = await typeBotMessage(st.say, "cat-brief", st.blocks);
        if (st.action) {
          runActions({ responseType: "ACTION", actions: [Object.assign({ params: {} }, st.action)] });
          lines.push("action: " + st.action.type);
          await sleep(1300);   // 관람객이 뷰어 변화를 볼 시간
        }
        await sleep(400);
      }
      if (lastEl) appendActions(lastEl);   // 액션 아이콘은 브리핑 마지막 메시지에만
      setLog(lines);
    } catch (e) {
      stopThinking();
      renderBotError("브리핑 생성에 실패했습니다. RAG 서버(8090) 상태를 확인하세요.");
    } finally {
      briefingRunning = false;
    }
  }

  /* ── [박람회] 사진 진단 — 업로드 → Vision LLM + 매뉴얼 RAG ── */
  function bindImageUpload() {
    const fileIn = document.getElementById("imgInput");
    if (!fileIn) return;
    const open = () => fileIn.click();
    const cam = document.getElementById("cameraBtn");
    const att = document.getElementById("attachBtn");
    if (cam) cam.addEventListener("click", captureScreen);
    if (att) att.addEventListener("click", open);
    fileIn.addEventListener("change", async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = "";
      if (!f) return;
      try {
        const dataUrl = await downscaleImage(f, 900);   // 전송량·토큰 절약 (최대 900px JPEG)
        stagePendingImage(dataUrl);
      } catch (e) {
        renderBotError("이미지를 읽지 못했습니다: " + (e && e.message || e));
      }
    });
  }

  function stagePendingImage(dataUrl) {
    pendingImageDataUrl = dataUrl;
    if (!attachmentPreviewEl) return;
    attachmentPreviewEl.hidden = false;
    attachmentPreviewEl.innerHTML = `<div class="attachment-thumb-wrap">` +
      `<img src="${dataUrl}" alt="전송 대기 중인 첨부 사진">` +
      `<button type="button" class="attachment-remove" title="첨부 사진 삭제" aria-label="첨부 사진 삭제">×</button>` +
      `</div><div class="attachment-info"><b>사진이 첨부되었습니다.</b><span>질문을 입력한 뒤 전송해 주세요.</span></div>`;
    inputEl.placeholder = "이 장비 실시간 정비 모니터링 상태 좀 보여줘";
    inputEl.focus();
  }

  function clearPendingImage() {
    pendingImageDataUrl = null;
    if (attachmentPreviewEl) {
      attachmentPreviewEl.hidden = true;
      attachmentPreviewEl.innerHTML = "";
    }
    inputEl.placeholder = "오늘 어떤 도움을 드릴까요?";
  }

  function isImageMonitoringQuery(text) {
    const q = String(text || "").replace(/\s+/g, "");
    return q.includes("모니터링") &&
      (q.includes("실시간") || q.includes("정비") || q.includes("상태") || q.includes("정보")) &&
      (q.includes("보여") || q.includes("알려") || q.includes("확인") || q.includes("조회"));
  }

  function selectCaptureRegion() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "capture-region-overlay";
      overlay.innerHTML = `<div class="capture-region-guide">캡처할 영역을 마우스로 드래그하세요.<span>Esc로 취소</span></div>` +
        `<button class="capture-region-cancel" type="button">취소</button>` +
        `<div class="capture-region-box"></div>`;
      document.body.appendChild(overlay);

      const box = overlay.querySelector(".capture-region-box");
      const cancel = overlay.querySelector(".capture-region-cancel");
      let startX = 0;
      let startY = 0;
      let dragging = false;

      const cleanup = () => {
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
      };
      const finish = (region) => {
        cleanup();
        resolve(region);
      };
      const onKeyDown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      };
      const draw = (x, y) => {
        const left = Math.min(startX, x);
        const top = Math.min(startY, y);
        const width = Math.abs(x - startX);
        const height = Math.abs(y - startY);
        box.style.left = left + "px";
        box.style.top = top + "px";
        box.style.width = width + "px";
        box.style.height = height + "px";
        return { left, top, width, height };
      };

      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        finish(null);
      });
      overlay.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".capture-region-cancel")) return;
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        overlay.classList.add("has-selection");
        box.style.display = "block";
        draw(startX, startY);
        overlay.setPointerCapture(e.pointerId);
      });
      overlay.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        draw(e.clientX, e.clientY);
      });
      overlay.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        const region = draw(e.clientX, e.clientY);
        if (region.width < 20 || region.height < 20) {
          overlay.classList.remove("has-selection");
          box.style.display = "none";
          return;
        }
        finish(region);
      });
      overlay.addEventListener("contextmenu", (e) => e.preventDefault());
      document.addEventListener("keydown", onKeyDown, true);
    });
  }

  function chooseCaptureSource() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "capture-source-overlay";
      overlay.innerHTML = `<div class="capture-source-dialog">` +
        `<div class="capture-source-title">화면 캡처 방식 선택</div>` +
        `<button type="button" data-mode="display"><b>다른 모니터 · 창</b><span>Windows 화면 선택 후 원하는 영역을 자릅니다.</span></button>` +
        `<button type="button" data-mode="page"><b>현재 앱 화면</b><span>현재 i3DWEB 화면에서 바로 영역을 선택합니다.</span></button>` +
        `<button type="button" class="capture-source-close" data-mode="cancel">취소</button>` +
        `</div>`;
      document.body.appendChild(overlay);
      const finish = (mode) => {
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        resolve(mode);
      };
      const onKeyDown = (e) => {
        if (e.key === "Escape") finish(null);
      };
      overlay.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-mode]");
        if (!btn) return;
        finish(btn.dataset.mode === "cancel" ? null : btn.dataset.mode);
      });
      document.addEventListener("keydown", onKeyDown, true);
    });
  }

  async function captureDisplayCanvas() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("다른 모니터·창 캡처는 file://에서 사용할 수 없습니다. start_ui.bat을 실행하고 http://localhost:8080에서 이용해 주세요.");
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = reject;
      });
      await video.play();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, video.videoWidth);
      canvas.height = Math.max(1, video.videoHeight);
      canvas.getContext("2d").drawImage(video, 0, 0);
      return canvas;
    } finally {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    }
  }

  function cropCanvas(source, region) {
    const outScale = Math.min(1, 1600 / Math.max(region.width, region.height));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(region.width * outScale));
    out.height = Math.max(1, Math.round(region.height * outScale));
    out.getContext("2d").drawImage(source, region.left, region.top, region.width, region.height,
      0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", 0.88);
  }

  function selectDisplayRegion(sourceCanvas) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "capture-preview-overlay";
      overlay.innerHTML = `<div class="capture-preview-toolbar"><b>가져온 화면에서 캡처할 영역을 드래그하세요.</b>` +
        `<div><button type="button" data-preview="full">전체 화면 사용</button>` +
        `<button type="button" data-preview="cancel">취소</button></div></div>` +
        `<div class="capture-preview-stage"><img alt="선택한 모니터 또는 창 미리보기"><div class="capture-preview-box"></div></div>`;
      document.body.appendChild(overlay);
      const stage = overlay.querySelector(".capture-preview-stage");
      const img = overlay.querySelector("img");
      const box = overlay.querySelector(".capture-preview-box");
      let startX = 0;
      let startY = 0;
      let dragging = false;

      const cleanup = () => {
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
      };
      const finish = (dataUrl) => {
        cleanup();
        resolve(dataUrl);
      };
      const onKeyDown = (e) => {
        if (e.key === "Escape") finish(null);
      };
      const point = (e) => {
        const r = img.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
          y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
          rect: r
        };
      };
      const draw = (x, y) => {
        const left = Math.min(startX, x);
        const top = Math.min(startY, y);
        const width = Math.abs(x - startX);
        const height = Math.abs(y - startY);
        box.style.left = left + "px";
        box.style.top = top + "px";
        box.style.width = width + "px";
        box.style.height = height + "px";
        return { left, top, width, height };
      };

      overlay.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-preview]");
        if (!btn) return;
        if (btn.dataset.preview === "full") {
          finish(cropCanvas(sourceCanvas, { left: 0, top: 0, width: sourceCanvas.width, height: sourceCanvas.height }));
        } else finish(null);
      });
      stage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const p = point(e);
        startX = p.x;
        startY = p.y;
        dragging = true;
        box.style.display = "block";
        draw(p.x, p.y);
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const p = point(e);
        draw(p.x, p.y);
      });
      stage.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        const p = point(e);
        const selected = draw(p.x, p.y);
        if (selected.width < 12 || selected.height < 12) {
          box.style.display = "none";
          return;
        }
        const scaleX = sourceCanvas.width / p.rect.width;
        const scaleY = sourceCanvas.height / p.rect.height;
        finish(cropCanvas(sourceCanvas, {
          left: Math.round(selected.left * scaleX),
          top: Math.round(selected.top * scaleY),
          width: Math.max(1, Math.round(selected.width * scaleX)),
          height: Math.max(1, Math.round(selected.height * scaleY))
        }));
      });
      document.addEventListener("keydown", onKeyDown, true);
      img.src = sourceCanvas.toDataURL("image/jpeg", 0.9);
    });
  }

  async function captureScreen() {
    const cam = document.getElementById("cameraBtn");
    if (cam && cam.disabled) return;
    if (cam) {
      cam.disabled = true;
      cam.classList.add("is-capturing");
      cam.title = "현재 화면 캡처 중";
    }
    try {
      const mode = await chooseCaptureSource();
      if (!mode) return;
      if (mode === "display") {
        const displayCanvas = await captureDisplayCanvas();
        const displayDataUrl = await selectDisplayRegion(displayCanvas);
        if (displayDataUrl) stagePendingImage(displayDataUrl);
        return;
      }
      const region = await selectCaptureRegion();
      if (!region) return;
      if (typeof window.html2canvas !== "function") {
        throw new Error("화면 캡처 모듈을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const scale = Math.min(1.5, 1600 / Math.max(region.width, region.height));
      const canvas = await window.html2canvas(document.body, {
        backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
        x: region.left,
        y: region.top,
        width: region.width,
        height: region.height,
        windowWidth: viewportWidth,
        windowHeight: viewportHeight,
        scrollX: 0,
        scrollY: 0,
        scale: Math.max(0.6, scale),
        useCORS: true,
        allowTaint: false,
        logging: false,
        onclone: (doc) => {
          const cloneOverlay = doc.querySelector(".capture-region-overlay");
          if (cloneOverlay) cloneOverlay.remove();
          const cloneCam = doc.getElementById("cameraBtn");
          if (cloneCam) {
            cloneCam.disabled = false;
            cloneCam.classList.remove("is-capturing");
          }
        }
      });
      const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
      stagePendingImage(dataUrl);
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return;
      renderBotError("화면을 캡처하지 못했습니다: " + ((e && e.message) || "알 수 없는 오류"));
    } finally {
      if (cam) {
        cam.disabled = false;
        cam.classList.remove("is-capturing");
        cam.title = "화면 캡처";
      }
    }
  }
  function downscaleImage(file, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  async function onSendImage(dataUrl, text) {
    clearEmpty(chatEl);
    const u = document.createElement("div");
    u.className = "msg user";
    u.innerHTML = `<img class="chat-img" src="${dataUrl}" alt="업로드 사진" />` +
      (text ? `<div>${escapeHtml(text)}</div>` : "");
    chatEl.appendChild(u);
    chatEl.scrollTop = chatEl.scrollHeight;
    inputEl.value = "";

    resetApiFlow();
    if (!isImageMonitoringQuery(text)) {
      const res = {
        responseType: "ANSWER",
        message: "첨부 사진을 확인했습니다.",
        answer: "사진과 함께 확인할 내용을 입력해 주세요. 실시간 운전 상태를 확인하려면 ‘이 장비 실시간 정비 모니터링 상태 좀 보여줘’라고 요청할 수 있습니다.",
        actions: [],
        confidence: 0.9
      };
      handleResponse(res);
      inputEl.focus();
      return;
    }
    const tag = viewerTagEl.textContent === "—" ? null : viewerTagEl.textContent;
    pushFlow({ owner: "ai", dir: "req", transport: "http", endpoint: "POST /api/ai/vision",
      meta: "사진 인식 → MONITORING 타입 변환",
      payload: { currentTag: tag, message: text || null, image: "(base64 이미지 ~" + Math.round(dataUrl.length / 1366) + "KB)" } });
    startThinking("vision");
    await sleep(500);
    thinkStage("retrieve");
    await sleep(350);           // 검색 단계가 눈에 보이도록 잠깐 유지
    stopThinking();

    // 박람회 고정 mock: 첨부 사진을 터빈 실시간 모니터링 화면으로 분류한다.
    const res = {
      responseType: "ANSWER_WITH_ACTION",
      uiKind: "turbine-monitoring",
      message: "첨부 사진의 장비 표식에서 터빈 태그 5-4H31-J043C3를 인식했습니다. 해당 장비의 실시간 정비 모니터링 화면으로 연결됩니다. 상세한 설명을 드리면 다음과 같습니다.",
      blocks: [{ kind: "turbineMonitoring", metrics: [
        { label: "인식 장비 태그", value: TURBINE_TAG, status: "인식 완료", level: 100, tone: "info", description: "첨부 사진의 장비 명판 및 표식에서 식별한 터빈 태그입니다. 이후 모니터링 데이터는 이 태그를 기준으로 조회합니다." },
        { label: "Health", value: "69.9%", status: "경고", level: 69.9, tone: "warn", description: "터빈의 종합 건강도가 정상 범위보다 낮아 효율 저하나 주요 구성품의 성능 저하가 진행되고 있을 가능성이 있습니다." },
        { label: "터빈 입구 온도", value: "26C", status: "하한 근접", level: 26, tone: "warn", description: "입구 온도가 낮은 상태로 유지되면 연소 안정성과 터빈 효율에 영향을 줄 수 있습니다. 흡입 공기 조건, 연료 공급 상태, 제어 밸브 동작 상태를 우선 확인해야 합니다." },
        { label: "압축기·터빈 효율", value: "0.3 / 0.6", status: "낮음", level: 45, tone: "danger", description: "정상적인 에너지 변환 효율을 충분히 확보하지 못하고 있습니다. 압축기 블레이드 오염, 흡기 필터 막힘, 내부 유로 손실, 터빈 블레이드 마모 여부를 점검해야 합니다." },
        { label: "압축기 압력비", value: "0.8", status: "부족", level: 40, tone: "danger", description: "충분한 압력 상승이 형성되지 않고 있습니다. 흡기 계통 막힘, 압축기 성능 저하, 누설, 블레이드 오염 또는 손상 가능성을 확인해야 합니다." },
        { label: "터빈 출구 압력", value: "88 kPa", status: "추이 관찰", level: 88, tone: "info", description: "현재 값만으로 즉각적인 이상을 단정하기는 어렵습니다. 변동이 반복되거나 기준 하한으로 내려가면 배기 계통과 후단 설비의 저항 상태를 점검해야 합니다." }
      ] }],
      answer: `### 권장 점검 우선순위

1. 흡기 필터와 흡기 덕트의 막힘 및 오염 상태 점검
2. 압축기 블레이드 오염, 마모 및 손상 여부 확인
3. 연료 공급 압력과 연료 제어 밸브 동작 상태 점검
4. 터빈 입구 온도 센서와 관련 제어 계통 점검
5. 압축기 및 터빈 내부 누설 여부 확인
6. 터빈 블레이드, 베어링, 윤활 계통 상태 점검

### AI 분석

현재 터빈은 **즉시 정지가 필요한 위험 상태로 보이지는 않습니다.** 다만 효율 저하와 압력 형성 부족 징후가 확인되고 있으므로 **예방 점검이 필요한 상태**입니다.`,
      actions: [{ type: "MONITORING", targetType: "TAG", targetValue: TURBINE_TAG, params: { on: true } }],
      confidence: 0.98,
      grounded: true,
      sources: [{ type: "spatial", label: "터빈 실시간 모니터링", detail: "첨부 이미지 태그 인식 · " + TURBINE_TAG }],
      retrieval: { source: "i3DWEB 실시간 모니터링", query: "터빈 운전 상태", hitCount: 6,
        data: { equipmentTag: TURBINE_TAG, health: "69.9%", inletTemperature: "26℃", compressorEfficiency: 0.3,
          turbineEfficiency: 0.6, compressorPressureRatio: 0.8, outletPressure: "88 kPa" } },
    };
    pushFlow({ owner: "ai", dir: "req", transport: "data",
      endpoint: "monitoring(image)", meta: res.retrieval.source,
      payload: { detectedType: "TURBINE", detectedTag: TURBINE_TAG, actionType: "MONITORING" } });
    pushFlow({ owner: "ai", dir: "res", transport: "data",
      endpoint: "6 metric(s) · grounded=true", meta: "mock",
      payload: res.retrieval.data });
    pushFlow({ owner: "ai", dir: "res", transport: "http", endpoint: "200 OK  ·  /api/ai/vision",
      meta: "터빈 실시간 모니터링 분석", payload: res });
    handleResponse(res);
    inputEl.value = ""; inputEl.focus();
  }

  /* ── 이벤트 바인딩 ────────────────────────────────────── */
  function bindWelcomeCards() {
    document.querySelectorAll(".welcome-card[data-ex]").forEach((b) => {
      b.addEventListener("click", () => { inputEl.value = b.dataset.ex; onSend(); });
    });
  }

  document.getElementById("sendBtn").addEventListener("click", () => onSend());
  inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") onSend(); });
  if (attachmentPreviewEl) {
    attachmentPreviewEl.addEventListener("click", (e) => {
      if (e.target.closest(".attachment-remove")) clearPendingImage();
    });
  }
  document.querySelectorAll(".examples button[data-ex]").forEach((b) => {
    b.addEventListener("click", () => { inputEl.value = b.dataset.ex; onSend(); });
  });
  bindWelcomeCards();
  bindImageUpload();
  // 정비이력 표의 "전체 이력 보기" 펼침 (블록이 innerHTML로 렌더되므로 위임 바인딩)
  chatEl.addEventListener("click", (e) => {
    // 정비점검절차 카드 하단 버튼: 3D 위치로 이동 → 뷰어 JUMP_TO
    const pb = e.target.closest("[data-proc-act]");
    if (pb) {
      if (pb.dataset.procAct === "jump" && pb.dataset.procTarget) {
        runActions({ responseType: "ACTION",
          actions: [{ type: "JUMP_TO", targetType: "TAG", targetValue: pb.dataset.procTarget, params: {} }] });
      }
      return;
    }
    const more = e.target.closest(".hist-more");
    if (!more) return;
    const blk = more.closest(".b-block");
    if (blk) blk.querySelectorAll(".hist-extra").forEach((r) => r.classList.remove("hidden"));
    more.remove();
  });

  const errBtn = document.getElementById("exServerError");
  if (errBtn) {
    errBtn.addEventListener("click", () => {
      inputEl.value = "TG-BRG-002 위치로 이동해줘";
      onSend({ simulateError: true });
    });
  }

  /* ── AI 어시스턴트 패널 너비 조절 (드래그 스플리터) ───── */
  (function initResizer() {
    const ws = document.querySelector(".workspace");
    const vs = document.getElementById("vsplit");
    if (!ws || !vs) return;
    const MIN = 320, MAX_PAD = 360, DEFAULT = 440;
    const clamp = (w) => Math.max(MIN, Math.min(ws.getBoundingClientRect().width - MAX_PAD, w));
    const apply = (w) => ws.style.setProperty("--chat-w", clamp(w) + "px");
    const saved = parseInt(localStorage.getItem("i3d.chatW") || "", 10);
    if (saved) apply(saved);

    let dragging = false;
    vs.addEventListener("mousedown", (e) => {
      dragging = true; vs.classList.add("drag"); document.body.style.userSelect = "none"; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = ws.getBoundingClientRect().right - e.clientX;  // 우측 패널 폭 = 워크스페이스 우단 - 마우스 X
      apply(w);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; vs.classList.remove("drag"); document.body.style.userSelect = "";
      const cur = getComputedStyle(ws).getPropertyValue("--chat-w").trim();
      if (cur) localStorage.setItem("i3d.chatW", parseInt(cur, 10));
    });
    vs.addEventListener("dblclick", () => { ws.style.setProperty("--chat-w", DEFAULT + "px"); localStorage.removeItem("i3d.chatW"); });
  })();

  /* ── 하단 디버그 패널 높이 조절 (가로 드래그 스플리터) ───── */
  (function initHorizResizer() {
    const hs = document.getElementById("hsplit");
    if (!hs) return;
    const MIN = 100, MAX = 600, DEFAULT = 240;
    const apply = (h) => document.documentElement.style.setProperty("--debug-h", Math.max(MIN, Math.min(MAX, h)) + "px");
    const saved = parseInt(localStorage.getItem("i3d.debugH") || "", 10);
    if (saved) apply(saved);

    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    hs.addEventListener("mousedown", (e) => {
      dragging = true;
      hs.classList.add("drag");
      document.body.style.userSelect = "none";
      startY = e.clientY;
      const currentStyle = getComputedStyle(document.documentElement).getPropertyValue("--debug-h").trim();
      startHeight = currentStyle ? parseInt(currentStyle, 10) : DEFAULT;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const deltaY = e.clientY - startY;
      apply(startHeight - deltaY);
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      hs.classList.remove("drag");
      document.body.style.userSelect = "";
      const cur = getComputedStyle(document.documentElement).getPropertyValue("--debug-h").trim();
      if (cur) localStorage.setItem("i3d.debugH", parseInt(cur, 10));
    });

    hs.addEventListener("dblclick", () => {
      apply(DEFAULT);
      localStorage.removeItem("i3d.debugH");
    });
  })();

  /* ── 현재 날짜·시간·요일 표시 ──────────────────────────── */
  const clockEl = document.getElementById("chatClock");
  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const p = (n) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    clockEl.textContent = `${date} (${days[now.getDay()]}) ${time}`;
  }
  updateClock();
  setInterval(updateClock, 1000);
})();
