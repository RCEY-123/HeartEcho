/** Digital-life controls kept separate from the general panel. */
export const CONTINUITY_UI = String.raw`
function factMemoryCard(cognition) {
  return card({title:"自动提取的信息",icon:"brain",hint:"来自每次对话的原文；同类更正以最新记录为准",body:
    '<p>已评估 ' + num(cognition.stats.evaluated) + ' 条对话。下列内容在所属会话中自然使用，无需先说“回忆一下”。</p>' +
    (cognition.facts || []).map(x => '<p>' + esc(x.content) + ' <span class="small muted">' + esc(t(x.at)) + ' · 原文 #' + x.message_id + '</span> <button class="btn sm ghost" data-forget-fact="' + x.id + '">忘记</button></p>').join("")});
}

function evolutionCard(state, characterId) {
  state = state || {};
  return card({title:"她的迭代",icon:"brain",hint:"保留原始角色卡，在证据支持下缓慢成长",body:
    switchRow("evolutionEnabled","允许她从相处中成长",state.enabled === true,"每次至少三条独立证据与反思；一天最多一次，不改身份、世界观和关系边界") +
    '<p>已迭代 ' + num(state.count) + ' 次 · 上次：' + (state.lastAt ? t(state.lastAt) : "尚未迭代") + '</p>' +
    (state.traits || []).map(x => '<p>' + esc(x.text) + '</p>').join("") +
    '<button class="btn primary" id="saveEvolution" data-character="' + esc(characterId) + '">保存迭代设置</button>' +
    (state.original ? '<details class="mt"><summary>查看保留的原始角色卡</summary><pre class="pre-wrap">' + esc(JSON.stringify(state.original,null,2)) + '</pre></details>' : '<p class="small muted">首次开启时保存原始角色卡；暂停成长后仍保留历史。</p>')});
}

function continuityCard(data) {
  const cognition=data.cognition || {}, stats=cognition.stats || {}, memory=data.memory || {};
  return card({title:"对话、记忆与反思",icon:"layers",body:
    selectField("本次日记与反思使用的会话","lifeScope",S.lifeScope,data.scopes || []) +
    '<p>已评估 ' + num(stats.evaluated) + ' 条对话 · 等待语义核对 ' + num(stats.pending) + ' · 待重试 ' + num(stats.retry) + '</p>' +
    '<p class="small">明确生日会立即记住；重要自述按原文保存。归档和反思读取同一会话的证据，其他角色和会话保持独立。</p>' +
    (!memory.enabled ? '<p class="notice warn">尚未开启长期记忆，语义核对与每日摘要暂停。可到「记忆与互动」开启。</p>' : !memory.consentValid ?
      '<div class="notice warn"><p>当前归档服务与上次同意的配置不一致，自动整理已暂停。重启本身不会撤销授权。</p><p class="pre-wrap">' + esc(memory.disclosure.data) + '</p><p>' + esc(memory.disclosure.destinations.map(x => x.baseUrl + " / " + (x.model || "")).join("；")) + '</p><button class="btn" id="lifeConsent" data-fingerprint="' + esc(memory.disclosure.fingerprint) + '">同意当前服务说明并恢复整理</button></div>' : '<p class="small">归档服务授权有效，重启后会继续使用。</p>') +
    '<button class="btn" id="processContinuity">立即整理并检查反思</button>' +
    '<details class="mt"><summary>最近的评分与信息依据</summary><div class="table-wrap"><table><thead><tr><th>时间</th><th>重要性</th><th>置信度</th><th>依据</th><th>状态</th></tr></thead><tbody>' +
    (cognition.evaluations || []).map(x => '<tr><td>' + esc(t(x.at)) + '</td><td>' + Math.round(x.importance*100) + '</td><td>' + Math.round(x.confidence*100) + '</td><td>' + esc(x.reason) + '</td><td>' + esc({pending:"等待核对",done:"完成",retry:"待重试"}[x.state] || x.state) + '</td></tr>').join("") + '</tbody></table></div>' +
    (cognition.facts || []).map(x => '<p>' + esc(x.content) + ' <span class="small muted">原文 #' + x.message_id + '</span> <button class="btn sm ghost" data-forget-fact="' + x.id + '">忘记</button></p>').join("") + '</details>'});
}

function cycleDetail(day) {
  if (!day || !day.cycleVersion) return '';
  return '<p><strong>' + esc(day.subphase) + ' · 周期第 ' + day.cycleDay + ' 天</strong>（日历估算）</p>' +
    '<p>' + esc(day.phaseDescription) + '</p><p class="small muted">可能表现不代表已经发生，也不必每轮聊天提起。</p>' +
    '<p class="small">本周期 ' + esc(day.cycleStart) + ' 起，共 ' + day.cycleLength + ' 天；下次经期预计 ' + esc(day.nextPeriod) + '。</p>' +
    (day.ovulation ? '<p class="small">预计排卵日：' + esc(day.ovulation.estimatedDay) + '；日期估算范围：' + esc(day.ovulation.earliest) + ' 至 ' + esc(day.ovulation.latest) + '。</p>' : '') +
    (day.legacyPhase ? '<p class="small muted">历史身体事件保留，周期阶段由原始设定补充估算。</p>' : '');
}

function bodyCard(state) {
  state=state || {};
  if(!state.enabled) return card({title:"身体与生理期",icon:"heart",hint:"默认关闭，仅模拟角色的身体状态",body:
    '<p>启用后将持续随现实日期记录，不能关闭或重新初始化。请先确认角色是否适用生理周期。体质与部位概率是生活模拟参数，不代表医学风险。</p>' +
    field("初始体质（1–100）","bodyConstitution",70,{type:"number",min:1,max:100}) +
    field("先天状况 / 身体缺陷","bodyConditions","",{rows:2,tip:"可写呼吸系统、消化系统、头部、肌肉关节的设定；未提及的部位不额外增加概率"}) +
    switchRow("bodyCycle","启用生理周期",false,"非生物角色或不适用的角色可保持关闭；初始化后固定") +
    field("最近一次经期开始日期","bodyCycleStart",new Date().toLocaleDateString("sv-SE"),{type:"date"}) +
    '<div class="grid cols-3">' + field("平均周期（天）","bodyCycleLength",28,{type:"number",min:18,max:60}) + field("经期（天）","bodyPeriodDays",5,{type:"number",min:1,max:10}) + field("每周期浮动（天）","bodyVariation",2,{type:"number",min:0,max:5}) + '</div>' +
    '<p class="small muted">经期是子宫的变化，也属于卵巢的卵泡阶段。系统另估算排卵日、排卵日期范围和黄体阶段；周期较短或经期较长导致估算冲突时，会显示“阶段不确定”。</p>' +
    field("生理期表现","bodyManifestations","轻微疲倦，按自己的状态休息",{rows:2}) +
    switchRow("bodyConfirm","我理解启用后不可关闭，以上是角色的初始设定",false) + '<button class="btn primary" id="enableBody">确认初始值并启用</button>'});
  return card({title:"身体与生理期",icon:"heart",hint:"现实日期推进，同一天不会重新随机；未来日期仅为预计",body:
    '<p>体质 ' + state.profile.constitution + '/100 · 先天设定：' + esc(state.profile.conditions || "未设定") + '</p>' +
    cycleDetail(state.today) +
    (state.profile.cycleEnabled ? '<details class="mt" id="cycleGuide"><summary>了解周期阶段与估算方式</summary><p>经期：子宫内膜脱落，与卵泡期重叠。卵泡期：卵泡发育。排卵：释放卵子的事件。黄体期：排卵后至下一次月经前，分为黄体早期和经前阶段。</p><p>以本周期预计结束日期倒推：用下次经期前 14 天作为模拟排卵日，以前 10–16 天作为日期估算范围。范围内不代表每天都排卵，也不是受孕概率或避孕安全期。窗口可能跨越表中按预计排卵日划分的卵泡期和黄体期。</p><p>所有阶段都是角色的日历模拟，已记录也不等于医学确认；不模拟怀孕、避孕用药、绝经或内分泌疾病。末 7 天标为经前阶段属于展示规则，症状并非必然发生。周期或经期设定不足以估算时，保留原有经期而不强行推断。</p><p>依据：<a href="https://www.nhs.uk/conditions/periods/fertility-in-the-menstrual-cycle/" target="_blank" rel="noopener noreferrer">NHS 月经周期</a> · <a href="https://www.nhs.uk/conditions/pre-menstrual-syndrome/" target="_blank" rel="noopener noreferrer">NHS 经前综合征</a></p></details>' : '') +
    field("查看月份","bodyMonth",state.month,{type:"month"}) + '<button class="btn" id="viewBodyMonth">查看</button>' +
    '<div class="table-wrap" style="max-height:400px;overflow:auto"><table id="bodyCalendar"><thead><tr><th>日期</th><th>生理周期（估算）</th><th>身体状态</th><th>记录</th></tr></thead><tbody>' +
    state.days.map(x => '<tr><td>' + esc(x.day) + '</td><td>' + esc(x.subphase || x.phase) + (x.cycleDay ? ' · 第 ' + x.cycleDay + ' 天' : '') + (x.inOvulationWindow ? '<br><span class="small muted">排卵日期估算范围内</span>' : '') + (x.phase === "经期" && x.ovarianPhase === "卵泡期" ? '<br><span class="small muted">卵巢阶段：卵泡期</span>' : '') + (x.cycleVersion ? '<details><summary class="small">阶段说明</summary>' + cycleDetail(x) + '</details>' : '') + '</td><td>' + esc(x.recorded ? (x.issues.map(i => i.region + i.severity).join("、") || "无新增不适") : "—") + '</td><td>' + esc(x.status) + '</td></tr>').join("") + '</tbody></table></div>' +
    '<details class="mt"><summary>模拟参数</summary><p>每日轻微不适出现概率，不是医学预测；状态可持续 1–4 天并恢复。</p>' + state.risks.map(x => '<p>' + esc(x.region) + '：' + (x.dailyProbability*100).toFixed(2) + '% / 天</p>').join("") + '</details>'});
}

function wireContinuity() {
  const finish=async result=>{if(!result.ok) {toast(result.message || "保存失败","error");return;} toast(result.summary || "已保存","ok");await render();};
  bind("lifeScope","change",()=>{S.lifeScope=val("lifeScope");});
  bind("saveEvolution","click",async()=>finish(await api("/api/continuity/evolution",{characterId:$("#saveEvolution").dataset.character,enabled:checked("evolutionEnabled")})));
  bind("enableBody","click",async()=>{
    const button=$("#enableBody");button.disabled=true;
    try {await finish(await api("/api/continuity/body",{confirmIrreversible:checked("bodyConfirm"),constitution:val("bodyConstitution"),conditions:val("bodyConditions"),cycleEnabled:checked("bodyCycle"),cycleStart:val("bodyCycleStart"),cycleLength:val("bodyCycleLength"),periodDays:val("bodyPeriodDays"),variation:val("bodyVariation"),manifestations:val("bodyManifestations")}));}
    finally {button.disabled=false;}
  });
  bind("viewBodyMonth","click",()=>{S.bodyMonth=val("bodyMonth");render();});
  bind("processContinuity","click",()=>startLifeJob("continuity","/api/continuity/process",{},"开始整理对话与检查反思"));
  bind("lifeConsent","click",async()=>finish(await api("/api/next/consent",{fingerprint:$("#lifeConsent").dataset.fingerprint,agreed:true})));
  $$("[data-forget-fact]").forEach(button=>button.addEventListener("click",async()=>finish(await api("/api/continuity/forget",{id:button.dataset.forgetFact}))));
}
`;
