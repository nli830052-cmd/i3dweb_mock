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

  // ── DOM refs ─────────────────────────────────────────────
  const chatEl = document.getElementById("chat");
  const jsonEl = document.getElementById("jsonOut");
  const logEl = document.getElementById("logOut");
  const viewerTagEl = document.getElementById("viewerTag");
  const apiFlowEl = document.getElementById("apiFlow");
  const inputEl = document.getElementById("userInput");

  /* ── 진입점 ───────────────────────────────────────────── */
  async function onSend(opts) {
    opts = opts || {};
    const text = inputEl.value.trim();
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

    let res;
    try {
      res = await AiBackend.requestAiResponse(request, { simulateError: opts.simulateError });
    } catch (err) {
      // [2-에러] AI 백엔드 → Frontend (HTTP 에러) — AI팀 영역
      const status = (err && err.status) || 500;
      pushFlow({
        owner: "ai", dir: "res", transport: "http", error: true,
        endpoint: status + " Internal Server Error  ·  /api/ai/chat",
        meta: "~" + (30 + Math.floor(Math.random() * 40)) + "ms",
        payload: (err && err.body) || { error: "INTERNAL_ERROR" }
      });
      renderBotError("⚠ AI 서버 오류로 응답을 받지 못했습니다. (HTTP " + status + ")");
      jsonEl.classList.remove("empty");
      jsonEl.textContent = JSON.stringify({ error: (err.body && err.body.error) || "INTERNAL_ERROR", status: status }, null, 2);
      setLog(["HTTP " + status + " — AI 백엔드 응답 실패", "responseType 판단 불가 → 액션 미실행"]);
      inputEl.value = ""; inputEl.focus();
      return;
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
    const bot = document.createElement("div");
    bot.className = "msg bot";
    bot.innerHTML =
      `<span class="badge ${res.responseType}">${res.responseType}</span>` +
      `<div>${escapeHtml(res.message)}</div>` +
      (res.answer ? `<div class="ans">${escapeHtml(res.answer)}</div>` : "");
    chatEl.appendChild(bot);
    chatEl.scrollTop = chatEl.scrollHeight;
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
    const transportLabel = transport === "http" ? "HTTP" : "Viewer SDK";
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

  /* ── 이벤트 바인딩 ────────────────────────────────────── */
  document.getElementById("sendBtn").addEventListener("click", () => onSend());
  inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") onSend(); });
  document.querySelectorAll(".examples button[data-ex]").forEach((b) => {
    b.addEventListener("click", () => { inputEl.value = b.dataset.ex; onSend(); });
  });
  document.getElementById("exServerError").addEventListener("click", () => {
    inputEl.value = "TG-BRG-002 위치로 이동해줘";
    onSend({ simulateError: true });
  });
})();
