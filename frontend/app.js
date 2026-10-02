/* 财务软件培训中心 SPA：纯前端状态渲染，云端为唯一事实来源（刷新可恢复） */
const S = {
  token: localStorage.getItem('ft_token') || null,
  user: JSON.parse(localStorage.getItem('ft_user') || 'null'),
  catalog: [], cvId: null, material: null, enrollmentId: null,
  state: null, pageSlug: null, queue: JSON.parse(localStorage.getItem('ft_queue') || '[]'),
  teacherCVs: [],
};
const $ = id => document.getElementById(id);
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json',
      ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
};
const opId = () => 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const yuan = cents => '¥' + (Number(cents) / 100).toFixed(2);
const DOC_LABEL = { budget: '预算', reimbursement: '报销', month_end: '月结' };
const ACT_LABEL = {
  submit: '提交', approve: '审批通过', pay: '支付', reject: '退回', reverse: '撤回(冲销)',
  freeze: '冻结', unfreeze: '解冻', close: '月结关闭', reopen: '重开',
};
const STATE_LABEL = {
  draft: '草稿', submitted: '已提交', approved: '已批准', paid: '已支付',
  frozen: '已冻结', open: '开放(未结账)', closed: '已结账',
};

// ---------------- 登录 / 视图切换 ----------------
document.querySelectorAll('#view-login button').forEach(b => b.onclick = async () => {
  const u = await api('POST', '/api/auth/login', { username: b.dataset.user });
  S.token = u.token; S.user = u;
  localStorage.setItem('ft_token', u.token);
  localStorage.setItem('ft_user', JSON.stringify(u));
  boot();
});
$('session').innerHTML = '';

function logout() {
  localStorage.removeItem('ft_token'); localStorage.removeItem('ft_user');
  localStorage.removeItem('ft_queue');
  location.reload();
}

async function boot() {
  $('view-login').hidden = true;
  $('view-student').hidden = true;
  $('view-teacher').hidden = true;
  $('session').innerHTML =
    `<span>${S.user.display_name}（${S.user.role === 'teacher' ? '教师' : '学生'}）</span>
     <button onclick="logout()">退出</button>`;
  if (S.user.role === 'teacher') return bootTeacher();
  await bootStudent();
}

// ---------------- 学生 ----------------
async function bootStudent() {
  $('view-student').hidden = false;
  S.catalog = await api('GET', '/api/catalog');
  renderCVList();
  await selectCV(S.cv.filter(c => c.version === Math.max(...S.catalog.map(x => x.version)))[0]?.cv_id
    || S.catalog[0].cv_id);
}

function renderCVList() {
  $('cv-list').innerHTML = S.catalog.map(c =>
    `<div class="cv-item ${c.cv_id === S.cvId ? 'active' : ''}" data-cv="${c.cv_id}">
       ${c.title} <b>v${c.version}</b></div>`).join('');
  document.querySelectorAll('.cv-item').forEach(el => el.onclick = () => selectCV(Number(el.dataset.cv)));
}

async function selectCV(cvId) {
  S.cvId = cvId; S.enrollmentId = null; S.state = null;
  renderCVList();
  S.material = await api('GET', `/api/courses/${cvId}/material`);
  renderSidebar();
  // 自动报名（幂等）
  const e = await api('POST', '/api/enrollments', { cv_id: cvId });
  S.enrollmentId = e.enrollment_id;
  await refreshState();
}

function renderSidebar() {
  $('page-list').innerHTML = S.material.pages.map(p =>
    `<div>• <a data-slug="${p.slug}">${p.title}</a></div>`).join('');
  document.querySelectorAll('#page-list a').forEach(a => a.onclick = () => openDoc(a.dataset.slug));
  $('node-list').innerHTML = S.material.nodes.map(n =>
    `<li>${n.is_reading ? '📖' : '🧩'} ${n.title}${n.requires_evidence ? ' 📷' : ''}</li>`).join('');
}

async function openDoc(slug) {
  S.pageSlug = slug;
  $('practice-panel').hidden = true; $('upgrade-panel').hidden = true; $('doc-panel').hidden = false;
  const p = await api('GET', `/api/courses/${S.cvId}/pages/${slug}`);
  $('doc-title').textContent = p.title;
  $('doc-body').innerHTML = md(p.content);
  $('mark-read').onclick = async () => {
    const node = S.material.nodes.find(n => n.doc_type === slug && n.is_reading);
    await api('POST', `/api/enrollments/${S.enrollmentId}/read`, { node_code: node.node_code });
    flash(`已标记阅读完成：${node.title}`, true);
    await refreshState();
  };
}
$('doc-back').onclick = () => {
  $('doc-panel').hidden = true; $('practice-panel').hidden = false;
};

// 极简 markdown
function md(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '<br/><br/>').replace(/\n/g, '<br/>');
}

async function refreshState() {
  S.state = await api('GET', `/api/enrollments/${S.enrollmentId}/state`);
  renderPractice();
}

function renderPractice() {
  const st = S.state;
  $('ledger-version').textContent = 'v' + st.ledger_version;
  $('branch-name').textContent = st.branch_name;
  // 单据卡片 + 合法动作按钮（前端只是便利入口，真正的前置校验在服务端）
  $('docs').innerHTML = st.ledger.map(d => {
    const acts = legalActions(d);
    return `<div class="doc-card">
      <h4>${d.title}</h4>
      <div class="muted">${DOC_LABEL[d.doc_type]} · ${d.doc_uid}${d.amount_cents ? ' · ' + yuan(d.amount_cents) : ''}</div>
      <div>当前状态：<span class="state ${d.state}">${STATE_LABEL[d.state]}</span></div>
      <div class="acts">${acts.map(a => `<button data-doc="${d.doc_uid}" data-act="${a}">${ACT_LABEL[a]}</button>`).join('')}
        ${d.doc_type === 'reimbursement' && d.state === 'paid' ? '<button data-doc="reimb-1" data-act="reverse">撤回支付</button>' : ''}
      </div></div>`;
  }).join('');
  document.querySelectorAll('.acts button').forEach(b => b.onclick = () =>
    doAction(b.dataset.doc, b.dataset.act));

  $('trans-log').innerHTML = st.transitions.map((t, i) => `
    <tr class="${t.undone_at ? 'undone' : ''}">
      <td>${i + 1}</td><td>${t.doc_uid}</td><td>${ACT_LABEL[t.action] || t.action}</td>
      <td>${t.from_state ? STATE_LABEL[t.from_state] : '-'}</td><td>${STATE_LABEL[t.to_state] || t.to_state}</td>
      <td>${t.device_id || ''}</td>
      <td>${t.undone_at ? '已撤销' : '有效'}</td>
      <td>${(!t.undone_at && !t.undo_of_id) ? `<button class="ev-btn" data-undo="${t.id}">回滚此步</button>` : ''}</td>
    </tr>`).join('');
  document.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => doRollback(Number(b.dataset.undo)));

  // 节点进度三态：阅读完成 / 练习通过 / 需重做
  $('progress-list').innerHTML = st.progress.map(p => {
    const node = S.material.nodes.find(n => n.node_code === p.node_code);
    const label = { reading_done: '阅读完成', passed: '练习通过', needs_redo: '需重做', pending: '未通过' }[p.status];
    return `<div class="progress-item">
      <span class="dot ${p.status === 'reading_done' ? 'reading' : p.status === 'passed' ? 'passed' : p.status === 'needs_redo' ? 'redo' : 'pending'}"></span>
      <span class="name">${node ? node.title : p.node_code}
        <span class="reason">（按规则版本 v${p.rule_version} 评分${p.old_score != null && p.old_score !== p.score ? `；原成绩 ${p.old_score} 保留` : ''}）</span></span>
      <span class="pill ${p.status}">${label}</span>
      <span>${p.status === 'pending' || p.status === 'needs_redo' ? p.score + '%' : '100%'}</span>
      ${node && node.requires_evidence ? evidenceButtons(p) : ''}
      ${p.reason ? `<span class="reason">${reasonText(p.reason)}</span>` : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () =>
    uploadEvidence(b.dataset.ev, b.dataset.fail === '1'));
  $('queue-count').textContent = S.queue.length;
}

function evidenceButtons(p) {
  const failed = (S.state.evidences || []).filter(e => e.node_code === p.node_code).slice(-1)[0];
  const failNote = failed && failed.status === 'failed' ? `<span class="reason">上次截图失败：${failed.failure_note}</span>` : '';
  return `<span class="upload-row">
    <button class="ev-btn" data-ev="prac_month_end" data-fail="0">上传月结截图</button>
    <button class="ev-btn warn" data-ev="prac_month_end" data-fail="1">模拟截图失败</button>${failNote}</span>`;
}

function reasonText(r) {
  return ({
    PREREQ_NOT_PASSED: '前置节点未通过',
    IN_PROGRESS: '部分状态转移已完成',
    BASIS_LOST_AFTER_ROLLBACK: '撤回单据导致通过依据丢失，需重做',
    EVIDENCE_FAILED: '截图上传失败，需重新上传',
    EVIDENCE_MISSING: '缺少截图凭证',
    PASSED: '', REMAINS_PASSED: '',
  })[r] || (r || '');
}

function legalActions(d) {
  const map = {
    budget:     { draft: ['submit'], submitted: ['approve', 'reject'], approved: [], frozen: [] },
    reimbursement: { draft: ['submit'], submitted: ['approve', 'reject'], approved: ['pay', 'reject'], paid: ['reverse'] },
    month_end:  { open: ['close'], closed: ['reopen'] },
  };
  return map[d.doc_type][d.state] || [];
}

function flash(msg, ok) {
  $('msg').innerHTML = `<span class="${ok ? 'ok' : 'err'}">${msg}</span>`;
  setTimeout(() => { $('msg').innerHTML = ''; }, 5000);
}

async function doAction(docUid, action, opts = {}) {
  const body = {
    doc_uid: docUid, action,
    client_op_id: opId(), client_ts: new Date().toISOString(),
    device_id: $('device-id').value || 'devA',
  };
  if (opts.expectedVersion) body.expected_version = opts.expectedVersion;

  if ($('offline-mode').checked && !opts.forceOnline) {
    S.queue.push(body);
    localStorage.setItem('ft_queue', JSON.stringify(S.queue));
    $('queue-count').textContent = S.queue.length;
    flash(`离线：动作「${ACT_LABEL[action]}」已加入补交队列（#${S.queue.length}）`, true);
    return;
  }
  try {
    const r = await api('POST', `/api/enrollments/${S.enrollmentId}/actions`, body);
    if (r.idempotent) flash('该动作已处理过（幂等返回）', true);
    await refreshState();
  } catch (e) {
    flash(`动作被拒绝：${e.message}`, false);
    await refreshState();
  }
}

$('btn-sync').onclick = async () => {
  if (!S.queue.length) return flash('离线队列为空', true);
  try {
    const r = await api('POST', `/api/enrollments/${S.enrollmentId}/sync`, { actions: S.queue });
    S.queue = []; localStorage.setItem('ft_queue', '[]');
    flash(`补交完成：应用 ${r.applied}，幂等重复 ${r.duplicate}，被拒 ${r.rejected}`, r.rejected === 0);
    await refreshState();
  } catch (e) { flash('同步失败：' + e.message, false); }
};

$('btn-conflict').onclick = async () => {
  // 模拟设备B 基于过期版本提交：先取版本号，再人为用旧版本号
  const oldVersion = S.state.ledger_version;
  flash(`设备 ${$('device-id').value} 尝试基于过期版本 v${oldVersion} 提交…`, true);
  try {
    await api('POST', `/api/enrollments/${S.enrollmentId}/actions`, {
      doc_uid: 'budget-1', action: 'submit',
      client_op_id: opId(), device_id: $('device-id').value,
      expected_version: oldVersion - 1, // 故意过期
    });
  } catch (e) {
    if (e.status === 409) {
      flash(`并发冲突被服务端拒绝（409）：云端已是 v${e.data.server_version}，请刷新后重做`, false);
      await refreshState();
    }
  }
};

async function doRollback(transitionId) {
  if (!confirm('回滚该步骤会撤销其后续步骤，可能使月结等节点失去依据而需重做。继续？')) return;
  try {
    const r = await api('POST', `/api/enrollments/${S.enrollmentId}/rollback`,
      { transition_id: transitionId, device_id: $('device-id').value });
    flash(`已回滚 ${r.undone.length} 步，自动联动 ${r.auto.length} 步；评分已按当前状态重算`, true);
    await refreshState();
  } catch (e) { flash('回滚失败：' + e.message, false); }
}

async function uploadEvidence(nodeCode, fail) {
  try {
    const r = await api('POST',
      `/api/enrollments/${S.enrollmentId}/evidence${fail ? '?fail=1' : ''}`,
      { node_code: nodeCode, content_type: 'image/png', byte_size: 204800,
        ...(fail ? { status: 'failed', failure_note: '模拟：截图服务超时（504）' } : {}) });
    flash(fail ? '截图失败已记录，节点标记需重做，可重新上传' : '截图上传成功，已重新评分', !fail);
    await refreshState();
  } catch (e) { flash('证据提交异常：' + e.message, false); }
}

$('btn-refresh').onclick = () => refreshState().then(() => flash('已从云端恢复最新状态', true));

// ---------------- 课程升级 ----------------
$('btn-upgrade').onclick = async () => {
  const next = S.catalog.filter(c => c.cv_id === S.material.nodes && false);
  // 找同一课程的更高版本
  const cur = S.catalog.find(c => c.cv_id === S.cvId);
  const higher = S.catalog.filter(c => c.title === cur.title && c.version > cur.version)
    .sort((a, b) => a.version - b.version);
  if (!higher.length) return flash('当前已是最新课程版本', true);
  const target = higher[0];
  const plan = await api('GET',
    `/api/enrollments/${S.enrollmentId}/upgrade-plan?to_cv_id=${target.cv_id}`);
  S.upgradePlan = plan; S.upgradeTarget = target;
  $('practice-panel').hidden = true; $('doc-panel').hidden = true;
  $('upgrade-panel').hidden = false;
  $('upgrade-content').innerHTML = `
    <p>从 <b>v${cur.version}</b> 升级到 <b>v${target.version}</b>。原版本综合成绩保留：<b>${plan.old_overall_score}%</b></p>
    <div class="compare-grid">
      ${['migrate', 'branch'].map(k => {
        const m = plan.comparison[k];
        return `<div class="compare-col">
          <h4>${m.label}</h4>
          <p class="muted">${m.description}</p>
          <div>预计新版成绩：<b>${m.projected_score}%</b></div>
          <div>继承节点：${m.inherited_count}/${m.practice_nodes_total}</div>
          <div>原成绩保留：${m.old_score_kept ? '是' : '否'}</div>
          ${m.old_branch_frozen ? '<div>旧分支：只读冻结</div>' : ''}
          <button class="primary" style="margin-top:8px" data-mode="${k}">选择此方式升级</button>
        </div>`;
      }).join('')}
    </div>
    <h3>节点级继承依据</h3>
    <table class="grid"><thead><tr><th>节点</th><th>旧成绩</th><th>新版判定</th><th>依据/原因</th></tr></thead>
    <tbody>${plan.nodes.map(n => `<tr>
      <td>${n.title}</td><td>${n.old_score}${n.old_status ? ` (${n.old_status})` : ''}</td>
      <td>${n.inheritable ? '<b style="color:#15803d">可继承</b>' : '<span style="color:#b91c1c">需重做</span>'}</td>
      <td class="muted">${n.inheritable
        ? '匹配转移：' + n.basis.map(b => `${b.doc_type}:${b.action}`).join(' → ')
        : n.reason}</td></tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => doUpgrade(b.dataset.mode));
};
$('upgrade-back').onclick = () => { $('upgrade-panel').hidden = true; $('practice-panel').hidden = false; };

async function doUpgrade(mode) {
  const r = await api('POST', `/api/enrollments/${S.enrollmentId}/upgrade`,
    { to_cv_id: S.upgradeTarget.cv_id, mode });
  flash(`已按「${mode === 'migrate' ? '迁移已完成节点' : '重开练习分支'}」升级，新报名 #${r.new_enrollment_id}`, true);
  await selectCV(S.upgradeTarget.cv_id);
  // 选到对应分支
  const st = await api('GET', `/api/enrollments/${r.new_enrollment_id}/state`);
  S.enrollmentId = r.new_enrollment_id; S.state = st;
  renderPractice();
  $('upgrade-panel').hidden = true; $('practice-panel').hidden = false;
}

// ---------------- 教师 ----------------
async function bootTeacher() {
  $('view-teacher').hidden = false;
  const catalog = await api('GET', '/api/catalog');
  S.teacherCVs = catalog;
  $('teacher-cv').innerHTML = catalog.map(c =>
    `<option value="${c.cv_id}">${c.title} v${c.version}</option>`).join('');
  await loadTeacherRules();
  $('teacher-cv').onchange = loadTeacherRules;
  $('btn-new-version').onclick = newVersion;
  $('btn-teach-progress').onclick = showStudentProgress;
}

async function loadTeacherRules() {
  const cvId = Number($('teacher-cv').value);
  try {
    const rules = await api('GET', `/api/teacher/course-versions/${cvId}/rules`);
    $('teacher-rules').innerHTML = rules.map(r => `<tr>
      <td>${r.title}<br/><span class="muted">${r.node_code}</span></td>
      <td>${DOC_LABEL[r.doc_type]}</td>
      <td><code>${(r.required_transitions || []).map(t => `${t.doc_type}:${t.action}`).join(' → ') || '（阅读节点，无答案）'}</code></td>
      <td>${r.prereq_node || '—'}</td><td>${r.requires_evidence ? '📷 必需' : '否'}</td></tr>`).join('');
  } catch (e) {
    $('teacher-rules').innerHTML = `<tr><td colspan="5" class="err">${e.message}</td></tr>`;
  }
}

async function newVersion() {
  const cv = S.teacherCVs.find(c => c.cv_id === Number($('teacher-cv').value));
  const r = await api('POST', `/api/teacher/courses/${cv.id}/new-version`, {
    updates: [{
      node_code: 'prac_reimbursement',
      required_transitions: [
        { doc_type: 'reimbursement', action: 'submit' },
        { doc_type: 'reimbursement', action: 'reject' },
        { doc_type: 'reimbursement', action: 'submit' },
        { doc_type: 'reimbursement', action: 'approve' },
        { doc_type: 'reimbursement', action: 'pay' }],
    }],
  });
  $('teacher-output').textContent = '已发布新版本 #' + r.id + '（v' + r.version +
    '）：报销练习新增「退回后重新提交」要求。旧版本评分不受影响。';
  await bootTeacher();
}

async function showStudentProgress() {
  const id = Number($('teach-enr').value);
  if (!id) return;
  try {
    const p = await api('GET', `/api/teacher/enrollments/${id}/progress`);
    $('teacher-output').textContent = JSON.stringify(p.map(x => ({
      node: x.node_code, status: x.status, score: x.score,
      rule_version: x.rule_version, basis: x.scored_transitions, reason: x.reason,
    })), null, 2);
  } catch (e) { $('teacher-output').textContent = e.message; }
}

// 启动
if (S.token && S.user) boot().catch(e => {
  if (e.status === 401) { logout(); } else alert('启动失败：' + e.message);
});
