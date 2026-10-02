-- ============================================================
-- 财务软件培训中心 — PostgreSQL schema
-- 课程版本 / 评分规则(基于状态转移) / 学习进度 / 练习账套(事件溯源)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('teacher','student')),
  token         TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  BIGINT REFERENCES users(id)
);

-- 课程版本：升级后产生新版本；练习数据与评分按版本隔离
CREATE TABLE IF NOT EXISTS course_versions (
  id          BIGSERIAL PRIMARY KEY,
  course_id   BIGINT NOT NULL REFERENCES courses(id),
  version     INTEGER NOT NULL,
  parent_id   BIGINT REFERENCES course_versions(id),  -- 由哪个版本升级而来
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, version)
);

-- 评分规则（教师视角包含 expected_path 答案；学生接口永远不返回该字段）
CREATE TABLE IF NOT EXISTS grading_rules (
  id            BIGSERIAL PRIMARY KEY,
  cv_id         BIGINT NOT NULL REFERENCES course_versions(id),
  node_code     TEXT NOT NULL,
  title         TEXT NOT NULL,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('reimbursement','budget','month_end')),
  -- 阅读类节点 required_transitions = '[]'
  required_transitions JSONB NOT NULL,
  requires_evidence INTEGER NOT NULL DEFAULT 0,   -- 是否要求截图
  prereq_node   TEXT,                              -- 前置节点 code（顺序链）
  ordering      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (cv_id, node_code)
);

-- 文档页（阅读材料；与练习节点区分）
CREATE TABLE IF NOT EXISTS doc_pages (
  id      BIGSERIAL PRIMARY KEY,
  cv_id   BIGINT NOT NULL REFERENCES course_versions(id),
  slug    TEXT NOT NULL,
  title   TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  ordering INTEGER NOT NULL DEFAULT 0,
  UNIQUE (cv_id, slug)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id               BIGSERIAL PRIMARY KEY,
  student_id       BIGINT NOT NULL REFERENCES users(id),
  cv_id            BIGINT NOT NULL REFERENCES course_versions(id),
  branch_name      TEXT NOT NULL DEFAULT 'main',
  parent_enrollment BIGINT REFERENCES enrollments(id), -- 重开练习分支指向原报名
  ledger_version   INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, cv_id, branch_name)
);

-- ==================== 练习账套（事件溯源 + 当前状态物化）====================

-- 模拟单据
CREATE TABLE IF NOT EXISTS docs (
  id            BIGSERIAL PRIMARY KEY,
  enrollment_id BIGINT NOT NULL REFERENCES enrollments(id),
  doc_uid       TEXT NOT NULL,              -- 分支内稳定编号
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('reimbursement','budget','month_end')),
  title         TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL DEFAULT 0,
  state         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, doc_uid)
);

-- 状态转移事件（只追加；撤回=追加新事件，从不删除历史）
CREATE TABLE IF NOT EXISTS transitions (
  id            BIGSERIAL PRIMARY KEY,
  enrollment_id BIGINT NOT NULL REFERENCES enrollments(id),
  doc_uid       TEXT NOT NULL,
  doc_type      TEXT NOT NULL,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  action        TEXT NOT NULL,
  client_op_id  TEXT,                        -- 幂等键（离线补交/双设备）
  server_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_ts     TIMESTAMPTZ,
  device_id     TEXT,
  undone_at     TIMESTAMPTZ,                 -- 被回滚撤销的事件
  undo_of_id    BIGINT REFERENCES transitions(id),
  UNIQUE (enrollment_id, client_op_id)
);

-- 节点进度（评分结果）
CREATE TABLE IF NOT EXISTS node_progress (
  id            BIGSERIAL PRIMARY KEY,
  enrollment_id BIGINT NOT NULL REFERENCES enrollments(id),
  node_code     TEXT NOT NULL,
  rule_version  INTEGER NOT NULL,            -- 评分时课程版本（规则升级后旧成绩保留）
  status        TEXT NOT NULL CHECK (status IN ('pending','reading_done','passed','needs_redo')),
  score         INTEGER NOT NULL DEFAULT 0,
  old_score     INTEGER,                          -- 课程升级前的原成绩快照（原成绩保留）
  scored_transitions JSONB NOT NULL DEFAULT '[]', -- 判定通过所依据的具体转移
  reason        TEXT NOT NULL DEFAULT '',
  evidence_id   BIGINT,
  read_at       TIMESTAMPTZ,
  passed_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, node_code)
);

CREATE TABLE IF NOT EXISTS evidences (
  id            BIGSERIAL PRIMARY KEY,
  enrollment_id BIGINT NOT NULL REFERENCES enrollments(id),
  node_code     TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('uploaded','failed')),
  failure_note  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 迁移记录：比较「迁移已完成节点」与「重开练习分支」
CREATE TABLE IF NOT EXISTS migrations (
  id              BIGSERIAL PRIMARY KEY,
  student_id      BIGINT NOT NULL REFERENCES users(id),
  from_cv_id      BIGINT NOT NULL REFERENCES course_versions(id),
  to_cv_id        BIGINT NOT NULL REFERENCES course_versions(id),
  mode            TEXT NOT NULL CHECK (mode IN ('migrate','branch')),
  target_enrollment_id BIGINT REFERENCES enrollments(id),
  inherited_nodes JSONB NOT NULL DEFAULT '[]',   -- 继承依据（匹配到的状态转移）
  old_score_kept  INTEGER NOT NULL DEFAULT 0,    -- 保留的原成绩
  comparison      JSONB NOT NULL DEFAULT '{}',   -- 两种模式的对比结果
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_enr ON docs(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_trans_enr ON transitions(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_progress_enr ON node_progress(enrollment_id);
