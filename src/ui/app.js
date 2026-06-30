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
      renderBotError("AI 서버 오류로 응답을 받지 못했습니다. (HTTP " + status + ")");
      jsonEl.classList.remove("empty");
      jsonEl.textContent = JSON.stringify({ error: (err.body && err.body.error) || "INTERNAL_ERROR", status: status }, null, 2);
      setLog(["HTTP " + status + " — AI 백엔드 응답 실패", "responseType 판단 불가 → 액션 미실행"]);
      inputEl.value = ""; inputEl.focus();
      return;
    }

    // [1b] (규칙 미매칭 시) LLM이 action JSON 직접 생성 — AI팀 영역
    if (res.plan) {
      pushFlow({
        owner: "ai", dir: "req", transport: "llm",
        endpoint: `${res.plan.model}.plan(message)`, meta: "action JSON 생성(규칙 미매칭)",
        payload: { model: res.plan.model, message: text }
      });
      pushFlow({
        owner: "ai", dir: "res", transport: "llm",
        endpoint: "action JSON", meta: "로컬 추론",
        payload: { actions: res.plan.actions }
      });
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
        endpoint: "generated answer", meta: "로컬 추론",
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
    bot.className = "msg bot" + (cat.key ? " cat-" + cat.key : "");
    bot.innerHTML =
      (cat.label ? `<div class="card-head"><span class="cat-chip cat-${cat.key}">${cat.label}</span></div>` : "") +
      (res.headline ? `<div class="headline">${escapeHtml(res.headline)}</div>` : "") +     // ① 판정
      (res.message ? `<div>${escapeHtml(res.message)}</div>` : "") +
      (res.blocks && res.blocks.length ? renderBlocks(res.blocks) : detailBlock(cat.key, res)) + // ② 구조화 데이터
      (res.answer ? `<div class="ans">${mdToHtml(res.answer)}</div>` : "") +                // ③ 종합 설명(마크다운 서식)
      (res.recommendation ? `<div class="reco">▸ ${escapeHtml(res.recommendation)}</div>` : "") + // ④ 권고
      sourceBlock(res) +                                                                    // ⑤ 근거 칩
      excerptBlock(res);                                                                    // ⑤ 매뉴얼 발췌(접이식)
    chatEl.appendChild(bot);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

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
        html += `<tr><th>마지막 정비</th><td>${escapeHtml(d.lastMaintenance)}</td></tr>`;
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
    if (key === "manual" && res.generation) {
      const g = res.generation;
      return `<div class="card-detail">` + kv("생성 모델", g.model || "-") + kv("엔진", g.engine || "-") +
        (g.chunks != null ? kv("근거 청크", g.chunks + "개") : "") + `</div>`;
    }
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
