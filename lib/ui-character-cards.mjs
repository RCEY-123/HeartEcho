export const CHARACTER_CARDS_UI = String.raw`
function characterCardList(character) {
  return S.characters.map(item => '<div class="nav-item' + (item.id === character?.id ? ' active' : '') + '" data-char="' + esc(item.id) + '">' + ICON("user", 18) + '<span class="nav-label">' + esc(item.name || item.id) + '</span><span class="spacer"></span>' + (item.id === S.activeCharacter?.id ? pill("正在使用", "accent") : '') + '</div>').join('');
}
function bindCharacterCardList() {
  $$("#characterCardList [data-char]").forEach(el => el.addEventListener("click", async () => { await loadCharacters(el.dataset.char); render(); }));
}
async function refreshCharacterCardList() {
  const revision = S.characterLoadRevision;
  const result = await api("/api/characters");
  if (!result.ok) throw new Error(result.message || "角色列表读取失败");
  const active = S.activeCharacter?.id !== result.active ? await api("/api/characters/" + encodeURIComponent(result.active)) : null;
  if (revision !== S.characterLoadRevision) return;
  if (active?.ok) S.activeCharacter = active.character;
  S.characters = result.list;
  const list = $("#characterCardList");
  if (list) { list.innerHTML = characterCardList(S.editingCharacter); bindCharacterCardList(); }
}
function characterCardActions(character) {
  const disabled = character.id ? "" : " disabled";
  return '<button class="btn primary sm block mt" id="characterCardImport">导入角色卡</button>' +
    '<input type="file" id="characterCardFileInput" accept=".json,application/json" multiple hidden>' +
    '<button class="btn ghost sm block mt-sm" id="characterCardExport"' + disabled + '>导出角色卡</button>' +
    '<button class="btn ghost sm block mt-sm" id="characterCardDelete"' + disabled + '>删除角色卡</button>' +
    '<div class="tiny muted mt-sm">可多选 JSON。导出已保存的共享设定，不含私人档案、聊天和记忆。</div>';
}

function bindCharacterCards() {
  bind("characterCardImport", "click", () => $("#characterCardFileInput").click());
  bind("characterCardFileInput", "change", async (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    if (S.busy.characterImport) return;
    if (selected.length > 50 || selected.some(file => file.size > 1024 * 1024)) { toast("每次最多 50 张，每张不超过 1 MB", "error"); return; }
    S.busy.characterImport = true;
    try {
      const files = await Promise.all(selected.map(async (file) => ({ name: file.name, content: await file.text() })));
      if (new Blob([JSON.stringify({ files })]).size > 12 * 1024 * 1024) throw new Error("本次导入总大小超过 12 MB，请分批导入");
      const result = await api("/api/characters/import", { files });
      if (!result.ok) throw new Error(result.message || "导入失败");
      await refreshCharacterCardList();
      showModal("角色卡导入结果", '<div class="small mb">已导入 ' + result.imported + ' 张。相同 ID 会跳过；不会切换正在使用的角色。</div><div style="max-height:360px;overflow:auto">' +
        result.results.map(row => '<div class="small mb"><strong>' + esc(row.name || row.filename) + '</strong>：' + esc(row.message) + '</div>').join("") + '</div>');
    } catch (error) { toast(error.message || "导入失败", "error"); }
    finally { S.busy.characterImport = false; }
  });
  bind("characterCardExport", "click", async () => {
    const character = S.editingCharacter;
    if (!character || S.busy.characterExport) return;
    S.busy.characterExport = true;
    try {
      const card = await api("/api/characters/" + encodeURIComponent(character.id) + "/export");
      if (card.ok === false) throw new Error(card.message || "导出失败");
      const blob = new Blob([JSON.stringify(card, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = character.id + ".json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast("已导出保存的角色卡", "ok");
    } catch (error) { toast(error.message || "导出失败", "error"); }
    finally { S.busy.characterExport = false; }
  });
  bind("characterCardDelete", "click", () => {
    const character = S.editingCharacter;
    if (!character) return;
    if (S.characters.length <= 1) { toast("至少要保留一个角色，请先新建或导入其他角色", "warn"); return; }
    showModal("删除「" + character.name + "」", '<div class="small mb">选择要删除的内容。' +
      (character.id === S.activeCharacter?.id ? '删除后将切换到另一个角色。' : '') + '</div>' +
      '<label class="row mb"><input type="radio" name="characterDeleteMode" value="keep" checked><span>仅删除角色卡，保留聊天与记忆<br><span class="tiny muted">重新导入相同 ID 的卡片可继续使用原数据。</span></span></label>' +
      '<label class="row mb"><input type="radio" name="characterDeleteMode" value="all"><span>同时删除该角色的数据<br><span class="tiny muted">清除归属该角色的聊天、记忆、日记、反思、成长和身体状态。不会清理其他角色、独立备份或无法确认归属的旧记录。</span></span></label>' +
      '<div class="small mb">此操作无法撤销。需要留存角色设定时，请先导出。</div>' +
      '<button class="btn danger" id="characterCardDeleteConfirm">确认删除</button><div class="small mt" id="characterCardDeleteError" role="alert"></div>');
    $("#modalClose").textContent = "取消";
    bind("characterCardDeleteConfirm", "click", async () => {
      if (S.busy.characterDelete) return;
      S.busy.characterDelete = true;
      const button = $("#characterCardDeleteConfirm"); button.disabled = true;
      const mode = $("input[name=characterDeleteMode]:checked").value;
      try {
        const result = await api("/api/characters/" + encodeURIComponent(character.id), { mode, confirmation: character.id }, "DELETE");
        if (!result.ok) throw new Error(result.message || "删除失败");
        $("#modalClose")?.click();
        const stillEditingDeleted = S.editingCharacter?.id === character.id;
        if (stillEditingDeleted) await loadCharacters(result.active);
        else await refreshCharacterCardList();
        S.status = null; S.nativeHistory = null;
        if (mode === "all") localStorage.removeItem("he.localDraft." + character.id);
        if (stillEditingDeleted && S.page === "studio") await render();
        toast(mode === "all" ? "角色卡及其数据已删除" : "角色卡已删除，聊天和记忆已保留", "ok");
        if (result.remoteErasurePending) toast("外部记忆服务的删除请求已排队，连接恢复后继续清理", "info");
        for (const warning of result.cleanupWarnings || []) toast(warning, "warn");
      } catch (error) { const output = $("#characterCardDeleteError"); if (output) output.textContent = error.message; else toast(error.message, "error"); }
      finally { S.busy.characterDelete = false; if (button.isConnected) button.disabled = false; }
    });
  });
}
`;
