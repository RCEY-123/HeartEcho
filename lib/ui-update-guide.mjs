/** Current-version notice and a read-only tour of the new controls. */
export const UPDATE_GUIDE_UI = String.raw`
const CHARACTER_CARD_GUIDE = [
  { target: "#characterCardImport", title: "快捷导入角色卡", body: "在这里选择下载好的 JSON 角色卡。GitHub 角色栏中的卡片可以直接导入，无需再复制到数据目录。" },
  { target: "#characterCardExport", title: "导出当前角色卡", body: "选中角色后，可将角色设定保存为 JSON 文件，方便备份、分享或再次导入。聊天与记忆不随角色卡导出。" },
  { target: "#characterCardDelete", title: "按需删除角色", body: "删除前可以选择保留聊天与记忆，或同时清除该角色的数据。确认页面会列出影响范围，请按需要选择。" },
];
let featureGuide = null;

async function showCurrentReleaseNotice() {
  try {
    const state = await api("/api/updates");
    if (!state.ok || !state.currentNotes) throw new Error(state.message || "暂时无法读取本版更新");
    showReleaseNotice(state.currentNotes, false);
  } catch (error) { toast(error.message || "暂时无法读取本版更新", "error"); }
}

function showReleaseNotice(notice, automatic) {
  showModal((automatic ? "已更新到 " : "本版更新 · ") + notice.version,
    '<p class="small muted">' + esc(notice.title || "本次更新") + '</p>' +
    '<div class="pre-wrap" style="line-height:1.9">' + esc(notice.body) + '</div>' +
    (notice.guide === "character-cards" ? '<div class="row mt"><button class="btn primary" id="updateStartGuide">看看新功能 →</button></div><p class="small muted">稍后可到「运行环境 → 本版更新与引导」重新查看。</p>' : ''));
  let close = $("#modalClose");
  // Persist acknowledgement before dismissing; a failed save remains recoverable here.
  const dismiss = async (startGuide) => {
    if (close.disabled) return;
    close.disabled = true;
    const start = $("#updateStartGuide");
    if (start) start.disabled = true;
    try {
      const result = await api("/api/updates/acknowledge", { version: notice.version });
      if (!result.ok) throw new Error(result.message || "暂时无法保存已读状态");
      $("#modal").classList.add("hidden");
      $("#modal").innerHTML = "";
      if (startGuide) await startFeatureGuide();
    } catch (error) {
      close.disabled = false;
      if (start) start.disabled = false;
      toast(error.message || "暂时无法保存已读状态，请重试", "error");
    }
  };
  // Replace the generic modal close handler, which would dismiss before saving.
  const savedClose = close.cloneNode(true);
  close.replaceWith(savedClose);
  close = savedClose;
  savedClose.textContent = "稍后再看";
  savedClose.addEventListener("click", () => dismiss(false));
  bind("updateStartGuide", "click", () => dismiss(true));
}

async function startFeatureGuide() {
  stopFeatureGuide(false);
  const state = { index: 0, returnFocus: document.activeElement, frame: 0 };
  featureGuide = state;
  S.featureGuideActive = true;
  go("studio");
  for (let i = 0; i < 100 && featureGuide === state && !$(CHARACTER_CARD_GUIDE[0].target); i++) await sleep(50);
  if (featureGuide !== state) return;
  if (!$(CHARACTER_CARD_GUIDE[0].target)) {
    stopFeatureGuide(false);
    toast("角色工作室尚未准备好，可稍后从运行环境重新打开引导。", "warn");
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = "featureGuide";
  overlay.innerHTML = '<style>' +
    '#featureGuide{position:fixed;inset:0;z-index:10000;isolation:isolate}' +
    '#featureGuideHighlight{position:fixed;border:3px solid #9ec5ff;border-radius:12px;box-shadow:0 0 0 9999px rgba(3,6,15,.72),0 0 24px rgba(110,167,255,.65);pointer-events:none}' +
    '#featureGuideArrow{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}' +
    '#featureGuideCard{position:fixed;width:min(350px,calc(100vw - 32px));box-sizing:border-box;padding:20px;border:1px solid #719de4;border-radius:16px;background:#18243a;color:#eaeefb;box-shadow:0 16px 60px #0008;max-height:calc(100vh - 32px);overflow:auto}' +
    '#featureGuideCard h3{margin:10px 0}#featureGuideCard p{line-height:1.7;margin:8px 0 16px}#featureGuideCard .row{flex-wrap:wrap;gap:8px}' +
    '#featureGuideCard button:focus-visible{outline:2px solid #c4dcff;outline-offset:3px}' +
    '</style><div id="featureGuideHighlight" aria-hidden="true"></div>' +
    '<svg id="featureGuideArrow" aria-hidden="true"><defs><marker id="featureGuideArrowhead" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#b8d6ff" stroke-width="2"/></marker></defs><path id="featureGuideLine" fill="none" stroke="#b8d6ff" stroke-width="3" marker-end="url(#featureGuideArrowhead)"/></svg>' +
    '<section id="featureGuideCard" role="dialog" aria-modal="true" aria-labelledby="featureGuideTitle" aria-describedby="featureGuideBody" tabindex="-1"><span class="small muted" id="featureGuideCount"></span><h3 id="featureGuideTitle"></h3><p id="featureGuideBody"></p><div class="row"><button class="btn ghost" id="featureGuideSkip">跳过引导</button><button class="btn" id="featureGuidePrevious">上一步</button><button class="btn primary" id="featureGuideNext">下一步</button></div></section>';
  document.body.appendChild(overlay);
  state.reposition = () => {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => { state.frame = 0; positionFeatureGuide(); });
  };
  state.keydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); stopFeatureGuide(); }
    if (event.key === "Tab") {
      const buttons = $$("#featureGuideCard button").filter((button) => !button.disabled);
      const current = buttons.indexOf(document.activeElement);
      const next = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next].focus();
    }
  };
  state.routeChanged = () => { if (location.hash !== "#studio") stopFeatureGuide(false); };
  window.addEventListener("resize", state.reposition);
  document.addEventListener("scroll", state.reposition, true);
  document.addEventListener("keydown", state.keydown, true);
  window.addEventListener("hashchange", state.routeChanged);
  bind("featureGuideSkip", "click", () => stopFeatureGuide());
  bind("featureGuidePrevious", "click", () => { if (state.index > 0) { state.index--; renderFeatureGuideStep(); } });
  bind("featureGuideNext", "click", () => {
    if (state.index === CHARACTER_CARD_GUIDE.length - 1) stopFeatureGuide();
    else { state.index++; renderFeatureGuideStep(); }
  });
  renderFeatureGuideStep();
}

function renderFeatureGuideStep() {
  if (!featureGuide) return;
  const step = CHARACTER_CARD_GUIDE[featureGuide.index];
  const target = $(step.target);
  if (!target) { stopFeatureGuide(false); return; }
  target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  $("#featureGuideCount").textContent = "新功能引导 · " + (featureGuide.index + 1) + " / " + CHARACTER_CARD_GUIDE.length;
  $("#featureGuideTitle").textContent = step.title;
  $("#featureGuideBody").textContent = step.body;
  $("#featureGuidePrevious").disabled = featureGuide.index === 0;
  $("#featureGuideNext").textContent = featureGuide.index === CHARACTER_CARD_GUIDE.length - 1 ? "完成" : "下一步 →";
  $("#featureGuideHighlight").dataset.target = step.target;
  positionFeatureGuide();
  $("#featureGuideCard").focus({ preventScroll: true });
}

function positionFeatureGuide() {
  if (!featureGuide || !$("#featureGuideCard")) return;
  const target = $(CHARACTER_CARD_GUIDE[featureGuide.index].target);
  if (!target) { stopFeatureGuide(false); return; }
  const r = target.getBoundingClientRect(), padding = 6;
  const highlight = $("#featureGuideHighlight");
  Object.assign(highlight.style, { left: (r.left - padding) + "px", top: (r.top - padding) + "px", width: (r.width + padding * 2) + "px", height: (r.height + padding * 2) + "px" });
  const card = $("#featureGuideCard"), width = card.offsetWidth, height = card.offsetHeight;
  const left = Math.max(16, Math.min(innerWidth - width - 16, r.left));
  const below = r.bottom + height + 68 < innerHeight || r.top < height + 68;
  const top = Math.max(16, Math.min(innerHeight - height - 16, below ? r.bottom + 62 : r.top - height - 62));
  Object.assign(card.style, { left: left + "px", top: top + "px" });
  const x1 = Math.max(left + 24, Math.min(left + width - 24, r.left + r.width / 2));
  const y1 = below ? top - 4 : top + height + 4;
  const x2 = r.left + r.width / 2, y2 = below ? r.bottom + 13 : r.top - 13;
  $("#featureGuideLine").setAttribute("d", "M" + x1 + "," + y1 + " Q" + x2 + "," + ((y1 + y2) / 2) + " " + x2 + "," + y2);
}

function stopFeatureGuide(restoreFocus = true) {
  const state = featureGuide;
  featureGuide = null;
  S.featureGuideActive = false;
  if (!state) return;
  cancelAnimationFrame(state.frame);
  window.removeEventListener("resize", state.reposition);
  document.removeEventListener("scroll", state.reposition, true);
  document.removeEventListener("keydown", state.keydown, true);
  window.removeEventListener("hashchange", state.routeChanged);
  $("#featureGuide")?.remove();
  if (restoreFocus) {
    const target = $(CHARACTER_CARD_GUIDE[state.index].target);
    const focus = target && !target.disabled ? target : (state.returnFocus?.isConnected ? state.returnFocus : null);
    focus?.focus({ preventScroll: true });
  }
}
`;
