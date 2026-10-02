-- 财务软件培训中心：课程版、评分规则与学习进度的持久化结构
-- 练习分支采用事件溯源；成绩仅追加、永不覆盖（原成绩保留）

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrollments (
  user_id    BIGINT NOT NULL REFERENCES users(id),
  course_id  TEXT NOT NULL,
  version    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS readings (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  course_id    TEXT NOT NULL,
  version      TEXT NOT NULL,
  node_key     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id, node_key)
);

CREATE TABLE IF NOT EXISTS branches (
  id               TEXT PRIMARY KEY,                       -- uuid
  user_id          BIGINT NOT NULL REFERENCES users(id),
  course_id        TEXT NOT NULL,
  version          TEXT NOT NULL,
  node_key         TEXT NOT NULL,
  name             TEXT NOT NULL,
  parent_branch_id TEXT REFERENCES branches(id),
  fork_seq         INTEGER,                                -- 回滚/分支复制到此 seq（种子事件 seq=0）
  origin           TEXT NOT NULL DEFAULT 'native',         -- native | rollback | migrated
  source_branch_id TEXT REFERENCES branches(id),
  status           TEXT NOT NULL DEFAULT 'active',         -- active | archived
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branches_user ON branches(user_id, course_id, node_key);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  branch_id     TEXT NOT NULL REFERENCES branches(id),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'valid',             -- valid | invalid（点击审计，不产生状态转移）
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  annuls        JSONB NOT NULL DEFAULT '[]',               -- 被本事件废止的历史事件 id
  error_code    TEXT,
  error_message TEXT,
  client_op_id  TEXT,                                      -- 离线/多设备幂等键
  device_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, seq),
  UNIQUE (branch_id, client_op_id)
);
CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch_id, seq);

CREATE TABLE IF NOT EXISTS grades (
  id          BIGSERIAL PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  at_seq      INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  passed      BOOLEAN NOT NULL,
  detail      JSONB NOT NULL,
  rule_hash   TEXT NOT NULL,                               -- 评分规则版本指纹
  origin      TEXT NOT NULL DEFAULT 'native',              -- native | inherited
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grades_branch ON grades(branch_id, at_seq);

CREATE TABLE IF NOT EXISTS screenshots (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  event_id    TEXT REFERENCES events(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'image/png',
  bytes       BYTEA,
  status      TEXT NOT NULL DEFAULT 'stored',              -- stored（失败不写库；用注入模拟）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shots_branch ON screenshots(branch_id);
