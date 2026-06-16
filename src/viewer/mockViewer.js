/* ============================================================
 *  src/viewer/mockViewer.js  —  [솔루션팀 영역]
 *  i3DWEB Viewer SDK stand-in. 실제 SDK 수령 시 이 파일을 통째로
 *  교체(또는 어댑터로 감싸기)하면 됨. 공개 API 시그니처만 유지.
 *
 *  공개 API:
 *    ViewerSDK.jumpToTag(targetValue, params) -> { ok, ... }
 *      성공: { ok:true,  movedTo, status:"moved", message }
 *      실패: { ok:false, error:"TAG_NOT_FOUND", message }
 *    ViewerSDK.KNOWN_TAGS  (mock 로드 태그 — 실제 SDK에선 불필요)
 *
 *  실제 연동 예:
 *    function jumpToTag(targetValue) { return i3dwebViewer.jumpToTag(targetValue); }
 * ========================================================== */
(function () {
  "use strict";

  // Mock Viewer가 로드한 것으로 간주하는 태그. 여기 없으면 이동 실패.
  const KNOWN_TAGS = new Set(["TG-BRG-002", "TG-PMP-101", "TG-VLV-205", "TG-MOT-310", "TG-TNK-007"]);

  function jumpToTag(targetValue, params) {
    console.log(`[MOCK Viewer] jumpToTag("${targetValue}")`, params || {});
    if (!KNOWN_TAGS.has(targetValue)) {
      paintError(targetValue);
      return { ok: false, error: "TAG_NOT_FOUND", message: `${targetValue} 태그를 Viewer에서 찾을 수 없습니다.` };
    }
    paintMoved(targetValue);
    return { ok: true, movedTo: targetValue, status: "moved", message: `mock viewer에서 ${targetValue} 위치로 이동 처리 완료` };
  }

  /* ── Mock Viewer 박스(#viewer) 화면 표현 ─────────────────── */
  function els() {
    return {
      box: document.getElementById("viewer"),
      tag: document.getElementById("viewerTag"),
      status: document.getElementById("viewerStatus")
    };
  }

  function paintMoved(tag) {
    const { box, tag: tagEl, status } = els();
    tagEl.textContent = tag;
    status.textContent = "JUMP_TO executed · moved";
    status.className = "status";
    box.classList.remove("moved", "error");
    void box.offsetWidth; // reflow → 애니메이션 재시작
    box.classList.add("moved");
  }

  function paintError(tag) {
    const { box, tag: tagEl, status } = els();
    tagEl.textContent = tag;
    status.textContent = "JUMP_TO failed · TAG_NOT_FOUND";
    status.className = "status err";
    box.classList.remove("moved", "error");
    void box.offsetWidth;
    box.classList.add("error");
  }

  window.ViewerSDK = { jumpToTag, KNOWN_TAGS };
})();
