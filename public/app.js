/* 财务软件培训中心 SPA（原生 JS）。学生端仅用教师接口之外的 API；答案由服务端剥离。 */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const api = async (path, opts = {}) => {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message || `HTTP ${res.status}`), { status: res.status, body });
  return body;
};

const state = {
  token: localStorage.getItem('ft_token') || null,
  user: JSON.parse(localStorage.getItem('ft_user') || 'null'),
  deviceId: localStorage.getItem('ft_device') || (() => {
    const d = 'dev-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('ft_device', d); return d;
  })(),
  courseId: 'finance101',
  progress: null,
  catalog: null,
  selected: null,
};

const STATUS_BADGE = {
  NOT_STARTED: ['badge todo', '未开始'],
  READ_DONE: ['badge read', '✔ 阅读完成'],
  PRACTICE_PASSED: ['badge pass', '✔ 练习通过'],
  NEEDS_REWORK: ['badge rework', '↺ 需重做'],
};

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------- 离线队列（localStorage；上线后自动补交） ----------------
const queueKey = () => `ft_queue_${state.courseId}`;
function loadQueue() { try { return JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch { return []; } }
function saveQueue(q) { localStorage.setItem(queueKey(), JSON.stringify(q)); }
function isOnline() { return navigator.onLine; }
function renderOfflineIndicator() {
  const q = loadQueue();
  const el = $('#offline-indicator');
  if (!el) return;
  el.innerHTML = `设备：<code>${esc(state.deviceId)}</code><br/>网络：<span class="pill ${isOnline() ? 'online' : 'offline'}">${isOnline() ? '在线' : '离线'}</span>；待补交操作：<b>${q.length}</b>`;
}
window.addEventListener('online', () => { renderOfflineIndicator(); flushQueue(); });
window.addEventListener('offline', renderOfflineIndicator);

async function enqueueOp(nodeKey, type, payload) {
  const clientOpId = 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const q = loadQueue();
  q.push({ nodeKey, type, payload, clientOpId, deviceId: state.deviceId, ts: Date.now() });
  saveQueue(q);
  renderOfflineIndicator();
  if (isOnline()) return flushQueue(nodeKey);
  toast('当前离线，操作已加入本地队列，恢复网络后可一键补交', '');
  return null;
}

async function flushQueue(nodeKeyOnly) {
  const q = loadQueue();
  if (!q.length || !isOnline()) return null;
  const groups = {};
  for (const op of q) (groups[op.nodeKey] ||= []).push(op);
  let lastView = null;
  for (const [nodeKey, ops] of Object.entries(groups)) {
    if (nodeKeyOnly && nodeKey !== nodeKeyOnly) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await api(`/api/practice/${state.courseId}/${nodeKey}/sync`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: state.deviceId, ops: ops.map(({ type, payload, clientOpId, deviceId }) => ({ type, payload, clientOpId, deviceId })) }),
      });
      const okIds = new Set(r.results.filter((x) => x.status === 'applied' || x.status === 'rejected').map((x) => x.clientOpId));
      const remain = loadQueue().filter((o) => !okIds.has(o.clientOpId) || o.nodeKey !== nodeKey);
      saveQueue(remain);
      lastView = r.current;
      const rejected = r.results.filter((x) => x.status === 'rejected');
      if (rejected.length) toast(`${rejected.length} 个离线操作因状态前置条件不满足被服务端拒绝（已记录，不计分）`, 'err');
    } catch (e) {
      toast('补交失败：' + e.message, 'err');
    }
  }
  renderOfflineIndicator();
  await refreshAll();
  return lastView;
}

// ---------------- 启动 ----------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = new FormData(e.target).get('username').trim();
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username }) });
    state.token = r.token; state.user = r.user;
    localStorage.setItem('ft_token', r.token); localStorage.setItem('ft_user', JSON.stringify(r.user));
    boot();
  } catch (err) { toast(err.message, 'err'); }
});

async function boot() {
  if (!state.token) { $('#login-view').hidden = false; $('#main-view').hidden = true; return; }
  $('#login-view').hidden = true; $('#main-view').hidden = false;
  $('#userbox').innerHTML = `${esc(state.user.displayName || state.user.username)}（${state.user.role === 'teacher' ? '教师' : '学生'}）
    <button class="secondary" id="logout-btn">退出</button>`;
  $('#logout-btn').onclick = () => {
    localStorage.removeItem('ft_token'); localStorage.removeItem('ft_user');
    state.token = null; state.user = null; location.reload();
  };
  await refreshAll();
  renderOfflineIndicator();
}

async function refreshAll() {
  await ensureEnrolled();
  [state.progress, state.catalog] = await Promise.all([
    api(`/api/progress/${state.courseId}`),
    api(`/api/courses/${state.courseId}`),
  ]);
  renderSidebar();
  if (state.selected) renderContent(state.selected);
  else renderOverview();
  if (isOnline()) setTimeout(flushQueue, 300);
}

async function ensureEnrolled() {
  try {
    await api(`/api/progress/${state.courseId}`);
  } catch {
    await api('/api/enrollments', { method: 'POST', body: JSON.stringify({ courseId: state.courseId, version: '1.0.0' }) });
  }
}

function renderSidebar() {
  $('#course-title').textContent = state.catalog ? '财务软件实操入门' : '课程';
  const p = state.progress;
  $('#version-bar').innerHTML = `当前版本 <b>v${esc(p.version)}</b>
    <button class="secondary small" id="migrate-btn">升级/迁移</button>`;
  $('#migrate-btn').onclick = renderMigration;
  const ol = $('#node-list');
  ol.innerHTML = '';
  for (const n of p.nodes) {
    const node = state.catalog.nodes.find((x) => x.key === n.nodeKey);
    const [cls, label] = STATUS_BADGE[n.status];
    const li = document.createElement('li');
    if (state.selected === n.nodeKey) li.className = 'active';
    if (n.locked) li.className += ' locked';
    li.innerHTML = `<span class="kind">${n.kind === 'reading' ? '📄 文档' : '🧩 练习'}</span>${esc(node?.title || n.title)}<span class="${cls}">${label}</span>`;
    li.onclick = () => { if (n.locked) { toast('请先完成前置节点（阅读完成或练习通过）', 'err'); return; } state.selected = n.nodeKey; renderSidebar(); renderContent(n.nodeKey); };
    ol.appendChild(li);
  }
}

function renderOverview() {
  const p = state.progress;
  const done = p.nodes.filter((n) => ['READ_DONE', 'PRACTICE_PASSED'].includes(n.status)).length;
  const rework = p.nodes.filter((n) => n.status === 'NEEDS_REWORK').length;
  $('#content').innerHTML = `
    <h1>学习总览 <span class="muted">v${esc(p.version)}${p.version !== p.latestVersion ? '（已有新版 v' + esc(p.latestVersion) + '）' : ''}</span></h1>
    <div class="row">
      <span class="badge read">阅读完成 ${p.nodes.filter((n) => n.status === 'READ_DONE').length}</span>
      <span class="badge pass">练习通过 ${p.nodes.filter((n) => n.status === 'PRACTICE_PASSED').length}</span>
      <span class="badge rework">需重做 ${rework}</span>
    </div>
    <p class="muted">共 ${p.nodes.length} 个节点，已达标 ${done} 个。刷新页面后云端状态会自动恢复；练习进度由服务端事件流重建。</p>
    <div class="row"><button id="flush-btn">手动补交离线操作</button>
      <button class="secondary" id="refresh-btn">刷新云端状态</button></div>
    <p class="muted small">说明：本系统仅用于软件操作训练，账套与金额均为虚构；不连接真实资金系统，也不提供财务合规结论。</p>`;
  $('#flush-btn').onclick = () => flushQueue();
  $('#refresh-btn').onclick = refreshAll;
  if (state.user.role === 'teacher') renderTeacherPanel();
}

// ---------------- 文档页 ----------------
async function renderContent(nodeKey) {
  const node = state.catalog.nodes.find((n) => n.key === nodeKey);
  const prog = state.progress.nodes.find((n) => n.nodeKey === nodeKey);
  const el = $('#content');
  if (node.kind === 'reading') {
    el.innerHTML = `<h1>${esc(node.title)}</h1>
      <div class="muted">${prog.status === 'READ_DONE' ? '<span class="badge read">已阅读（服务端记录）</span>' : '<span class="badge todo">未完成阅读</span>'}${prog.stale ? ' <span class="badge rework">内容已更新，需重新阅读</span>' : ''}</div>
      <pre style="white-space:pre-wrap;font-family:inherit;line-height:1.7">${esc(node.body)}</pre>
      <button id="read-done">标记阅读完成</button>`;
    $('#read-done').onclick = async () => {
      await api(`/api/progress/${state.courseId}/${nodeKey}/read`, { method: 'POST', body: '{}' });
      toast('阅读完成已保存到云端', 'ok');
      await refreshAll();
    };
  } else {
    await renderPractice(nodeKey);
  }
}

// ---------------- 练习页 ----------------
async function renderPractice(nodeKey) {
  const view = await api(`/api/practice/${state.courseId}/${nodeKey}`);
  const n = view.node;
  const g = view.grading;
  const qPending = loadQueue().filter((o) => o.nodeKey === nodeKey).length;
  const el = $('#content');
  el.innerHTML = `
    <h1>${esc(n.title)}
      <span class="pill">${view.branch.origin === 'native' ? '主练习' : view.branch.origin === 'rollback' ? '回滚分支' : '迁移继承分支'}</span>
    </h1>
    <p class="muted">${esc(n.scenario)}</p>
    ${n.requiresScreenshot ? '<div class="teacher-note">📸 本练习规则要求上传结账报告截图；无有效截图不能通过（截图失败不影响账套操作，可重试）。</div>' : ''}
    <div class="scorebar">当前得分：<b style="font-size:22px">${g ? g.score : 0}</b> / 100（通过线 ${n.passScore}）
      ${g ? (g.passed ? '<span class="badge pass">练习通过</span>' : '<span class="badge rework">需重做</span>') : '<span class="badge todo">尚未开始</span>'}
      ${g && n.requiresScreenshot ? (g.screenshotOk ? '<span class="badge read">截图已归档</span>' : '<span class="badge rework">缺截图</span>') : ''}
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${g ? g.score : 0}%"></div></div>
    <div class="grid2">
      <div>
        <h2>评分依据（状态转移）</h2>
        <div id="tasks"></div>
        <h2>模拟操作</h2>
        <div id="opform"></div>
        <h2>截图归档 ${n.requiresScreenshot ? '<span class="badge rework">必需</span>' : '<span class="badge todo">可选</span>'}</h2>
        <div class="row">
          <input type="file" id="shot-file" accept="image/*" />
          <button id="shot-upload">上传截图</button>
          <button class="secondary" id="shot-fail-sim">模拟截图失败</button>
        </div>
        <p class="muted small">已归档 ${view.screenshots.length} 张。</p>
      </div>
      <div>
        <h2>虚构账套状态</h2>
        <div id="ledger"></div>
        <h2>事件流（评分看状态转移，不看点击顺序；🌱 种子事件 " + view.seedCount + " 条）</h2>
        <div class="eventlog" id="eventlog"></div>
        <h2>练习分支 / 回滚</h2>
        <div id="branches"></div>
      </div>
    </div>
    <p class="muted small">本地离线队列待提交：${qPending} <button class="secondary small" id="p-flush">立即补交</button></p>
  `;
  $('#p-flush').onclick = () => flushQueue(nodeKey);

  // tasks
  $('#tasks').innerHTML = '<table><tr><th>#</th><th>目标状态转移</th><th>状态</th></tr>' +
    n.tasks.map((t) => {
      const it = g?.items?.[t.index];
      const cls = it?.achieved ? 'task-ok' : (it?.lostAtSeq ? 'task-lost' : 'task-todo');
      const st = it?.achieved ? '✔ 有效（依据事件 #' + it.evidenceEventId.slice(0, 8) + '）'
        : (it?.lostAtSeq ? `↺ 依据失效（#${it.lostAtSeq} 撤回/反结账）` : '○ 未完成');
      return `<tr><td>${t.index + 1}</td><td>${esc(t.label)}</td><td class="${cls}">${st}</td></tr>`;
    }).join('') + '</table>' +
    '<p class="muted small">注：目标清单只展示任务描述，不包含操作类型、单据引用等答案；答案仅教师端可见。</p>';

  renderOpForm(n.key);
  renderLedger(view.ledger);
  renderEventLog(view.events, view.seedCount);
  renderBranches(nodeKey);

  $('#shot-upload').onclick = async () => {
    const f = $('#shot-file').files[0];
    if (!f) return toast('请先选择文件', 'err');
    const dataUrl = await new Promise((res, rej) => {
      const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f);
    });
    try {
      const r = await api(`/api/practice/${state.courseId}/${nodeKey}/screenshot`, {
        method: 'POST', body: JSON.stringify({ filename: f.name, dataUrl }),
      });
      toast('截图已归档，评分已更新：' + r.grading.score + ' 分', 'ok');
      await refreshAll();
    } catch (e) {
      toast(`截图上传失败：${e.message}\n练习进度与账套状态已保留，可更换网络后重试。`, 'err');
    }
  };
  $('#shot-fail-sim').onclick = async () => {
    if (state.user.role !== 'teacher') return toast('失败注入为教师功能；学生将收到 503 且状态保留', 'err');
    await api('/api/teacher/debug/screenshot-failure', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    toast('教师已开启“截图存储失败”注入；现在上传会 503。再次上传前请由教师关闭。', '');
  };
}

function renderOpForm(nodeKey) {
  const forms = {
    'ex-reimburse': reimburseForm(),
    'ex-budget': budgetForm(),
    'ex-month': monthForm(),
  };
  $('#opform').innerHTML = forms[nodeKey] || '<p class="muted">无操作表单</p>';
  $('#opform').querySelectorAll('button[data-op]').forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.dataset.op;
      const payload = collectPayload(btn.dataset);
      if (!payload) return;
      try {
        const r = await enqueueOp(nodeKey, type, payload);
        if (r && !isOnline()) return;
        if (isOnline()) {
          await refreshAll();
          if (r?.results) {
            const last = r.results[r.results.length - 1];
            if (last?.rejected) toast('操作被拒绝：' + last.rejected.message, 'err');
          }
        }
      } catch (e) {
        if (e.status === 422) { toast('操作不满足前置条件：' + e.body.error.message + '（已记录审计，不产生状态转移）', 'err'); await refreshAll(); }
        else toast(e.message, 'err');
      }
    };
  });
}

function collectPayload(ds) {
  const p = {};
  for (const [k, v] of Object.entries(ds)) {
    if (['op', 'ints', 'strs'].includes(k)) continue;
    p[k] = v;
  }
  (ds.ints || '').split(',').filter(Boolean).forEach((k) => { const el = $(`#f-${k}`); p[k] = Number(el.value); });
  (ds.strs || '').split(',').filter(Boolean).forEach((k) => { const el = $(`#f-${k}`); p[k] = el.value; });
  return p;
}

function reimburseForm() {
  return `
  <div class="row">单号 <input id="f-claimId" value="C-101" style="width:100px"> 金额 <input id="f-amount" type="number" value="1200" style="width:100px">
    部门 <input id="f-dept" value="SALES" style="width:90px"> 月份 <input id="f-month" value="2026-09" style="width:100px">
    事由 <input id="f-desc" value="差旅费" style="width:110px">
    <button data-op="CLAIM_CREATE" data-ints="amount" data-strs="claimId,dept,month,desc">建单</button></div>
  <div class="row">
    <button data-op="CLAIM_SUBMIT" data-strs="claimId">提交</button>
    <button data-op="CLAIM_APPROVE" data-strs="claimId">审批通过</button>
    <button data-op="CLAIM_REJECT" data-strs="claimId">驳回</button>
    <button data-op="CLAIM_PAY" data-strs="claimId">付款</button>
    <button class="danger" data-op="CLAIM_WITHDRAW" data-strs="claimId">撤回单据</button>
  </div>`;
}
function budgetForm() {
  return `
  <div class="row">部门 <input id="f-dept" value="ADMIN" style="width:100px"> 月份 <input id="f-month" value="2026-09" style="width:110px">
    金额 <input id="f-amount" type="number" value="8000" style="width:110px">
    <button data-op="BUDGET_PROPOSE" data-strs="dept,month" data-ints="amount">申报预算</button></div>
  <div class="row"><button data-op="BUDGET_APPROVE" data-strs="dept,month">审批通过</button>
    <button data-op="BUDGET_REJECT" data-strs="dept,month">驳回</button></div>`;
}
function monthForm() {
  return `<div class="row">月份 <input id="f-month" value="2026-09" style="width:120px">
    <button data-op="MONTH_CLOSE" data-strs="month">结账</button>
    <button class="danger" data-op="MONTH_REOPEN" data-strs="month">反结账</button></div>`;
}

function renderLedger(l) {
  $('#ledger').innerHTML = `
    <table><tr><th>部门</th><th>月份</th><th>预算</th><th>状态</th><th>剩余额度</th></tr>
    ${l.budgets.map((b) => `<tr><td>${esc(b.dept)}</td><td>${esc(b.month)}</td><td>${b.amount}</td>
      <td class="status-${b.status === 'APPROVED' ? 'APPROVEDB' : b.status}">${esc(b.status)}</td>
      <td>${l.budgetRemaining.find((x) => x.dept === b.dept && x.month === b.month)?.remaining ?? '-'}</td></tr>`).join('') || '<tr><td colspan=5 class="muted">无预算</td></tr>'}</table>
    <table><tr><th>单号</th><th>部门</th><th>金额</th><th>事由</th><th>状态</th></tr>
    ${l.claims.map((c) => `<tr><td>${esc(c.claimId)}</td><td>${esc(c.dept)}</td><td>${c.amount}</td><td>${esc(c.desc)}</td>
      <td class="status-${esc(c.status)}">${esc(c.status)}</td></tr>`).join('') || '<tr><td colspan=5 class="muted">无报销单</td></tr>'}</table>
    <p>会计期间：${l.months.map((m) => `<span class="pill">${esc(m.month)} ${esc(m.status)}</span>`).join(' ') || '<span class="muted">全部打开</span>'}</p>`;
}

function renderEventLog(events, seedCount) {
  $('#eventlog').innerHTML = events.map((e, i) => {
    const seed = i < (seedCount || 0);
    return `<div class="${e.kind === 'invalid' ? 'invalid' : ''} ${seed ? 'ev-seed' : ''}">
      #${e.seq} ${seed ? '🌱种子' : (e.kind === 'invalid' ? '⛔拒绝' : '✔')} ${esc(e.type)} ${esc(JSON.stringify(e.payload))}
      ${e.errorCode ? ' <b>' + esc(e.errorCode) + '</b>: ' + esc(e.errorMessage || '') : ''}
      ${e.deviceId ? ' [' + esc(e.deviceId) + ']' : ''}</div>`;
  }).join('') || '<p class="muted">暂无事件</p>';
}
async function renderBranches(nodeKey) {
  const prog = state.progress.nodes.find((x) => x.nodeKey === nodeKey);
  const el = $('#branches');
  el.innerHTML = (prog.branches || []).map((b) => `
    <div class="branch-item ${b.status}">
      <b>${esc(b.name)}</b> <span class="pill">${b.status === 'active' ? '当前' : '已归档'}</span>
      <span class="pill">${b.origin === 'native' ? '原生' : b.origin === 'rollback' ? '回滚' : '迁移继承'}</span>
      ${b.forkSeq != null ? ` fork@seq${b.forkSeq}` : ''}
    </div>`).join('');
  el.innerHTML += `<div class="row"><button class="secondary" id="rollback-btn">回滚到上一步（分叉新分支，保留原成绩）</button></div>
    <p class="muted small">撤回模拟单据会让后续步骤失去依据；如需彻底撤销已做步骤，可用回滚在事件流上分叉。</p>`;
  $('#rollback-btn').onclick = async () => {
    if (!confirm('将在当前末端的前一个 seq 处分叉新分支；旧分支归档且原成绩保留。继续？')) return;
    const r = await api(`/api/practice/${state.courseId}/${nodeKey}/rollback`, {
      method: 'POST', body: JSON.stringify({}),
    });
    toast(`新分支 ${r.branchId.slice(0, 8)} 已建立，复制 ${r.copiedEvents} 个事件；原分支 ${r.preservedBranch.gradesKept} 条成绩保留`, 'ok');
    await refreshAll();
  };
}

// ---------------- 课程升级 / 迁移 ----------------
async function renderMigration() {
  const target = state.progress.latestVersion;
  if (target === state.progress.version) {
    $('#content').innerHTML = '<h1>版本管理</h1><p>当前已是最新版本。</p>';
    state.selected = null; renderSidebar(); return;
  }
  const preview = await api(`/api/migrations/${state.courseId}/preview/${target}`);
  state.selected = null; renderSidebar();
  $('#content').innerHTML = `
    <h1>课程升级：v${esc(preview.fromVersion)} → v${esc(preview.toVersion)}</h1>
    <p class="muted">系统比较“迁移继承已完成节点”与“重开练习分支”两种处理：阅读按内容指纹、练习按评分规则指纹判定兼容性；旧版分支与成绩永不删除。</p>
    <div class="row">
      <span class="badge pass">可继承 ${preview.summary.inherit}</span>
      <span class="badge rework">规则不兼容/需重学 ${preview.summary.incompatible + preview.summary.redo_reading}</span>
      <span class="badge todo">未开始 ${preview.summary.fresh}</span>
    </div>
    <table><tr><th>节点</th><th>类型</th><th>判定</th><th>说明</th><th>原成绩</th><th>处理</th></tr>
    ${preview.nodes.map((n) => `<tr>
      <td>${esc(n.title)}</td><td>${n.kind === 'reading' ? '文档' : '练习'}</td>
      <td><b>${esc(decisionLabel(n.decision))}</b></td>
      <td class="muted">${esc(n.reason)}</td>
      <td>${n.oldScore != null ? n.oldScore + ' 分' : '—'}</td>
      <td>${choiceCell(n)}</td></tr>`).join('')}
    </table>
    <button id="do-migrate">执行迁移</button>
    <p class="muted small">“继承”会复制练习分支（原成绩标记 inherited 保留）；“重开”保留旧分支成绩并在新版首次进入时建立新分支。</p>`;
  $('#do-migrate').onclick = async () => {
    const choices = {};
    document.querySelectorAll('select[data-node]').forEach((s) => { choices[s.dataset.node] = s.value; });
    const r = await api(`/api/migrations/${state.courseId}/migrate/${target}`, {
      method: 'POST', body: JSON.stringify({ choices }),
    });
    toast('迁移完成：' + r.results.map((x) => `${x.nodeKey}=${x.action}`).join('；'), 'ok');
    await refreshAll(); renderOverview();
  };
}
function decisionLabel(d) {
  return { inherit: '可继承', incompatible: '规则不兼容', redo_reading: '需重新阅读', fresh: '未开始' }[d] || d;
}
function choiceCell(n) {
  if (n.decision === 'inherit') return `<select data-node="${n.nodeKey}"><option value="inherit">继承（保留原成绩）</option><option value="new">重开新分支</option></select>`;
  if (n.kind === 'exercise') return `<select data-node="${n.nodeKey}"><option value="new">重开练习分支</option><option value="inherit" disabled>不可继承（规则变更）</option></select>`;
  return '<span class="muted">升级后重新阅读</span>';
}

// ---------------- 教师面板 ----------------
async function renderTeacherPanel() {
  const el = $('#content');
  const course = await api(`/api/teacher/courses/${state.courseId}`);
  const users = await api('/api/teacher/users');
  el.innerHTML += `
    <hr/><h1>教师工作台（含答案与评分规则）</h1>
    <div class="teacher-note">以下 expected/seed 字段只通过教师接口下发；学生接口在服务端即剥离，浏览器隐藏不构成隔离。</div>
    <h2>用户</h2><p>${users.users.map((u) => `<span class="pill">${esc(u.username)} · ${u.role}</span>`).join(' ')}</p>
    <h2>课程版本与答案</h2>
    <div id="teacher-versions"></div>
    <h2>验收工具</h2>
    <div class="row">
      <button class="secondary" id="toggle-shot-fail">开启截图失败注入</button>
    </div>`;
  $('#teacher-versions').innerHTML = course.versions.map((v) => `
    <details><summary><b>v${esc(v.version)}</b>（${esc(v.publishedAt)}）</summary>
    ${v.nodes.filter((n) => n.kind === 'exercise').map((n) => `
      <h3>${esc(n.title)}</h3>
      <p class="muted">通过线 ${n.rule.passScore}；要求截图 ${n.rule.requiresScreenshot}；规则指纹 ${esc(n.ruleHash)}</p>
      <pre class="answer">期望状态转移（教师答案）:\n${esc(JSON.stringify(n.rule.required, null, 2))}\n\n种子事件（虚构账套初始状态）:\n${esc(JSON.stringify(n.seed, null, 2))}</pre>`).join('')}
    </details>`).join('');
  let failOn = false;
  $('#toggle-shot-fail').onclick = async () => {
    failOn = !failOn;
    await api('/api/teacher/debug/screenshot-failure', { method: 'POST', body: JSON.stringify({ enabled: failOn }) });
    $('#toggle-shot-fail').textContent = failOn ? '关闭截图失败注入' : '开启截图失败注入';
    toast('截图失败注入：' + (failOn ? '开启' : '关闭'), failOn ? 'err' : 'ok');
  };
}


boot();
