// 练习账套服务：应用动作 / 幂等 / 双设备并发 / 回滚（事件溯源）/ 重新评分
const { TRANSITIONS, REVERSE_ACTION, businessGuard, cascades, rollbackCascades } = require('../domain');

class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function getEnrollment(client, enrollmentId) {
  const r = await client.query('SELECT * FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId]);
  if (r.rowCount === 0) throw new DomainError('NOT_FOUND', '报名记录不存在');
  return r.rows[0];
}

async function loadLedger(client, enrollmentId) {
  const r = await client.query(
    'SELECT doc_uid, doc_type, title, amount_cents, state FROM docs WHERE enrollment_id=$1 ORDER BY id',
    [enrollmentId]);
  return r.rows;
}

async function insertTransition(client, { enrollmentId, doc, fromState, toState, action,
  opId, clientTs, deviceId, undoOfId }) {
  const r = await client.query(`
    INSERT INTO transitions
      (enrollment_id, doc_uid, doc_type, from_state, to_state, action,
       client_op_id, client_ts, device_id, undo_of_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [enrollmentId, doc.doc_uid, doc.doc_type, fromState, toState, action,
     opId ?? null, clientTs || null, deviceId || null, undoOfId || null]);
  return r.rows[0];
}

// 应用一个动作（调用方负责事务）
async function applyAction(client, enrollmentId, a, opts = {}) {
  const enr = await getEnrollment(client, enrollmentId);
  if (opts.expectedVersion && enr.ledger_version !== opts.expectedVersion) {
    throw new DomainError('VERSION_CONFLICT',
      `账套版本冲突：本地 v${opts.expectedVersion}，云端 v${enr.ledger_version}`,
      { serverVersion: enr.ledger_version });
  }

  // 幂等：同一 client_op_id 直接返回原结果（离线补交 / 重试 / 双设备）
  if (a.client_op_id) {
    const ex = await client.query(
      'SELECT * FROM transitions WHERE enrollment_id=$1 AND client_op_id=$2',
      [enrollmentId, a.client_op_id]);
    if (ex.rowCount > 0) {
      const t = ex.rows[0];
      return { idempotent: true, conflict: !!t.undone_at, transition: t,
               serverVersion: enr.ledger_version };
    }
  }

  const ledger = await loadLedger(client, enrollmentId);
  const doc = ledger.find(d => d.doc_uid === a.doc_uid);
  if (!doc) throw new DomainError('DOC_NOT_FOUND', `单据 ${a.doc_uid} 不存在`);

  const map = TRANSITIONS[doc.doc_type];
  const next = map[doc.state] && map[doc.state][a.action];
  if (!next) {
    throw new DomainError('ILLEGAL_TRANSITION',
      `单据处于 ${doc.state}，不能执行 ${a.action}`);
  }
  const guard = businessGuard({ docType: doc.doc_type, action: a.action, doc, ledger });
  if (guard) {
    const [code, msg] = guard.split(': ');
    throw new DomainError(code, msg || guard);
  }

  const main = await insertTransition(client, {
    enrollmentId, doc, fromState: doc.state, toState: next,
    action: a.action, opId: a.client_op_id, clientTs: a.client_ts, deviceId: a.device_id,
  });
  await client.query('UPDATE docs SET state=$1 WHERE enrollment_id=$2 AND doc_uid=$3',
    [next, enrollmentId, doc.doc_uid]);
  doc.state = next;

  // 级联动作（月结关闭=>冻结预算；月结重开=>解冻预算）
  const extra = [];
  for (const c of cascades(a.action, doc.doc_type, ledger)) {
    const b = ledger.find(d => d.doc_uid === c.doc_uid);
    const cNext = TRANSITIONS[b.doc_type][b.state][c.action];
    const t = await insertTransition(client, {
      enrollmentId, doc: b, fromState: b.state, toState: cNext,
      action: c.action, opId: null, deviceId: a.device_id,
    });
    await client.query('UPDATE docs SET state=$1 WHERE enrollment_id=$2 AND doc_uid=$3',
      [cNext, enrollmentId, b.doc_uid]);
    b.state = cNext;
    extra.push(t);
  }

  await client.query('UPDATE enrollments SET ledger_version=ledger_version+1 WHERE id=$1', [enrollmentId]);

  return { idempotent: false, transition: main, cascaded: extra,
           serverVersion: enr.ledger_version + 1 };
}

// 回滚某条历史转移（撤回模拟单据的一步）。后续步骤可能因此失去依据 -> needs_redo。
// 事件溯源：不删除历史，只标记 undone_at，并追加带 undo_of_id 的补偿转移。
async function rollbackTransition(client, enrollmentId, transitionId, opts = {}) {
  const enr = await getEnrollment(client, enrollmentId);
  const tgt = await client.query(
    'SELECT * FROM transitions WHERE id=$1 AND enrollment_id=$2 AND undone_at IS NULL AND undo_of_id IS NULL',
    [transitionId, enrollmentId]);
  if (tgt.rowCount === 0) {
    throw new DomainError('TRANSITION_NOT_ACTIVE', '该转移不存在或已被撤销');
  }
  const target = tgt.rows[0];

  // 1) 撤销：目标转移 + 同单据上其后的所有用户转移
  const later = await client.query(`
    SELECT * FROM transitions
    WHERE enrollment_id=$1 AND doc_uid=$2 AND id>=$3
      AND undone_at IS NULL AND undo_of_id IS NULL
    ORDER BY id`, [enrollmentId, target.doc_uid, target.id]);
  const toUndo = [...later.rows];
  const undoIds = new Set(toUndo.map(t => t.id));

  const autoCompensations = [];

  // 2) 相互影响：撤回其他单据时若账套已月结，必须先联动「重开月结 + 解冻预算」
  const meDoc = (await client.query(
    "SELECT state FROM docs WHERE enrollment_id=$1 AND doc_type='month_end'",
    [enrollmentId])).rows[0];
  if (meDoc && meDoc.state === 'closed') {
    const closeTr = (await client.query(`
      SELECT * FROM transitions WHERE enrollment_id=$1 AND action='close'
        AND undone_at IS NULL AND undo_of_id IS NULL ORDER BY id DESC LIMIT 1`,
      [enrollmentId])).rows[0];
    const freezeTr = (await client.query(`
      SELECT * FROM transitions WHERE enrollment_id=$1 AND action='freeze'
        AND undone_at IS NULL AND undo_of_id IS NULL ORDER BY id DESC LIMIT 1`,
      [enrollmentId])).rows[0];
    if (closeTr && !undoIds.has(closeTr.id)) {
      toUndo.push(closeTr); undoIds.add(closeTr.id);
      // reopen 即 close 的补偿转移（语义上就是反向动作）
      const reopen = await insertTransition(client, {
        enrollmentId, doc: { doc_uid: closeTr.doc_uid, doc_type: 'month_end' },
        fromState: 'closed', toState: 'open', action: 'reopen',
        deviceId: opts.device_id, undoOfId: closeTr.id });
      await client.query(
        "UPDATE docs SET state='open' WHERE enrollment_id=$1 AND doc_uid=$2",
        [enrollmentId, closeTr.doc_uid]);
      autoCompensations.push(reopen);
      // 旧截图凭证因月结重开失效（重传后可恢复）
      await client.query(`
        UPDATE evidences SET status='failed',
          failure_note='月结已被撤回重开，原截图凭证失效，需重新上传'
        WHERE enrollment_id=$1 AND node_code='prac_month_end' AND status='uploaded'`,
        [enrollmentId]);
    }
    if (freezeTr && !undoIds.has(freezeTr.id)) {
      toUndo.push(freezeTr); undoIds.add(freezeTr.id);
      const unfreeze = await insertTransition(client, {
        enrollmentId, doc: { doc_uid: freezeTr.doc_uid, doc_type: 'budget' },
        fromState: 'frozen', toState: 'approved', action: 'unfreeze',
        deviceId: opts.device_id, undoOfId: freezeTr.id });
      await client.query(
        "UPDATE docs SET state='approved' WHERE enrollment_id=$1 AND doc_uid=$2",
        [enrollmentId, freezeTr.doc_uid]);
      autoCompensations.push(unfreeze);
    }
  }

  // 3) 为每个被撤销的转移写补偿（跳过已用规范反向动作处理过的 close/freeze）
  const canonicalReverse = { close: 'reopen', freeze: 'unfreeze' };
  for (const t of toUndo) {
    await client.query('UPDATE transitions SET undone_at=now() WHERE id=$1', [t.id]);
    if (canonicalReverse[t.action]) continue; // 已在第 2 步写入 reopen/unfreeze
    const comp = await insertTransition(client, {
      enrollmentId,
      doc: { doc_uid: t.doc_uid, doc_type: t.doc_type },
      fromState: t.to_state, toState: t.from_state,
      action: REVERSE_ACTION[t.action] || ('rollback_' + t.action),
      deviceId: opts.device_id, undoOfId: t.id,
    });
    await client.query('UPDATE docs SET state=$1 WHERE enrollment_id=$2 AND doc_uid=$3',
      [t.from_state, enrollmentId, t.doc_uid]);
    autoCompensations.push(comp);
  }

  await client.query('UPDATE enrollments SET ledger_version=ledger_version+1 WHERE id=$1', [enrollmentId]);
  return { undone: [...undoIds], auto: autoCompensations.map(t => t.id),
           serverVersion: enr.ledger_version + 1 };
}

module.exports = { applyAction, rollbackTransition, DomainError, loadLedger };
