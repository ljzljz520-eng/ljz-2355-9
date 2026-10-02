// HTTP 服务：静态前端 + JSON API。
// 安全要点：教师答案(expected/seed)仅在教师接口序列化输出；学生接口用 catalog.toStudentNode 剥离。
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const catalog = require('./catalog');
const services = require('./services');

function createApp(repo) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- 鉴权中间件 ----
  async function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: { code: 'NO_TOKEN', message: '未登录' } });
    const user = await repo.findSession(token);
    if (!user) return res.status(401).json({ error: { code: 'BAD_TOKEN', message: '会话无效' } });
    req.user = user;
    req.token = token;
    next();
  }
  const requireTeacher = (req, res, next) => {
    if (req.user.role !== 'teacher') {
      // 学生拿教师接口：403，且响应体绝不包含答案字段
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: '仅教师可访问' } });
    }
    next();
  };

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', async (req, res) => {
    res.json({ ok: true, adapter: repo.kind(), time: new Date().toISOString() });
  });

  // 演示登录：username 任意；内置 demo 用户。真实环境应接密码哈希。
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      let { username } = req.body || {};
      username = (username || '').trim();
      if (!username) return res.status(400).json({ error: { code: 'BAD_INPUT', message: '需要 username' } });
      let user = await repo.findUserByUsername(username);
      if (!user) {
        const role = username.startsWith('teacher') ? 'teacher' : 'student';
        user = await repo.createUser({ username, role, display_name: username });
      }
      const token = crypto.randomBytes(24).toString('hex');
      await repo.createSession(token, user.id);
      res.json({ token, user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name } });
    } catch (e) { next(e); }
  });

  app.get('/api/me', auth, async (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, role: req.user.role, displayName: req.user.display_name });
  });

  app.get('/api/courses', auth, async (req, res) => {
    res.json({ courses: catalog.listCourses() });
  });

  // 学生选课（版本）
  app.post('/api/enrollments', auth, async (req, res, next) => {
    try {
      const { courseId, version } = req.body || {};
      if (!catalog.getCourseVersion(courseId, version)) {
        return res.status(404).json({ error: { code: 'NO_SUCH_VERSION', message: '课程/版本不存在' } });
      }
      await repo.upsertEnrollment(req.user.id, courseId, version);
      res.status(201).json({ courseId, version });
    } catch (e) { next(e); }
  });

  // 学生课程视图（文档含正文；练习不含答案）
  app.get('/api/courses/:courseId', auth, async (req, res, next) => {
    try {
      const enr = await repo.getEnrollment(req.user.id, req.params.courseId);
      const version = req.query.version || (enr && enr.version);
      if (!version) return res.status(404).json({ error: { code: 'NOT_ENROLLED', message: '请先选择课程版本' } });
      const cv = catalog.getCourseVersion(req.params.courseId, version);
      if (!cv) return res.status(404).json({ error: { code: 'NO_SUCH_VERSION', message: '版本不存在' } });
      const serializer = req.user.role === 'teacher' ? catalog.toTeacherNode : catalog.toStudentNode;
      res.json({
        courseId: cv.courseId, version: cv.version, publishedAt: cv.publishedAt, edges: cv.edges,
        nodes: cv.nodes.map((n) => {
          const out = serializer(n);
          return out;
        }),
      });
    } catch (e) { next(e); }
  });

  app.get('/api/progress/:courseId', auth, async (req, res, next) => {
    try {
      const progress = await services.getProgress(repo, req.user, req.params.courseId);
      if (!progress) return res.status(404).json({ error: { code: 'NOT_ENROLLED', message: '请先选择课程版本' } });
      res.json(progress);
    } catch (e) { next(e); }
  });

  app.post('/api/progress/:courseId/read/:nodeKey', auth, async (req, res, next) => {
    try {
      const { courseId, nodeKey } = req.params;
      const enr = await repo.getEnrollment(req.user.id, courseId);
      if (!enr) return res.status(404).json({ error: { code: 'NOT_ENROLLED', message: '请先选择课程版本' } });
      const cv = catalog.getCourseVersion(courseId, enr.version);
      const node = catalog.getNode(cv, nodeKey);
      if (!node || node.kind !== 'reading') return res.status(404).json({ error: { code: 'NO_READING', message: '文档节点不存在' } });
      await repo.completeReading(req.user.id, courseId, enr.version, nodeKey, catalog.contentHash(node));
      res.status(201).json({ nodeKey, status: 'READ_DONE', contentHash: catalog.contentHash(node) });
    } catch (e) { next(e); }
  });

  app.get('/api/practice/:courseId/:nodeKey', auth, async (req, res, next) => {
    try {
      const view = await services.getExerciseView(repo, req.user, req.params.courseId, req.params.nodeKey);
      res.json(view);
    } catch (e) { next(e); }
  });

  // 单次操作
  app.post('/api/practice/:courseId/:nodeKey/ops', auth, async (req, res, next) => {
    try {
      const { type, payload, clientOpId, deviceId } = req.body || {};
      const result = await services.applyOp(repo, req.user, req.params.courseId, req.params.nodeKey,
        { type, payload: payload || {} }, { clientOpId, deviceId });
      res.status(result.rejected ? 422 : 200).json(result);
    } catch (e) { next(e); }
  });

  // 离线批量补交：顺序应用，单项失败不阻塞队列其余操作；返回逐项结果
  app.post('/api/practice/:courseId/:nodeKey/sync', auth, async (req, res, next) => {
    try {
      const { ops, deviceId } = req.body || {};
      if (!Array.isArray(ops)) return res.status(400).json({ error: { code: 'BAD_INPUT', message: 'ops 必须是数组' } });
      const results = [];
      for (const item of ops) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await services.applyOp(repo, req.user, req.params.courseId, req.params.nodeKey,
            { type: item.type, payload: item.payload || {} },
            { clientOpId: item.clientOpId, deviceId: item.deviceId || deviceId });
          results.push({ clientOpId: item.clientOpId, status: r.rejected ? 'rejected' : 'applied', ...r });
        } catch (e) {
          results.push({ clientOpId: item.clientOpId, status: 'error', error: { code: e.code, message: e.message } });
        }
      }
      const view = await services.getExerciseView(repo, req.user, req.params.courseId, req.params.nodeKey);
      res.json({ results, current: view });
    } catch (e) { next(e); }
  });

  // 截图上传（base64 JSON；可注入失败）
  app.post('/api/practice/:courseId/:nodeKey/screenshot', auth, async (req, res, next) => {
    try {
      const { filename, dataUrl } = req.body || {};
      if (!dataUrl) return res.status(400).json({ error: { code: 'BAD_INPUT', message: '缺少 dataUrl' } });
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return res.status(400).json({ error: { code: 'BAD_INPUT', message: 'dataUrl 格式错误' } });
      const bytes = Buffer.from(m[2], 'base64');
      const out = await services.uploadScreenshot(repo, req.user, req.params.courseId, req.params.nodeKey,
        { filename: filename || 'screenshot.png', mime: m[1], bytes });
      res.status(201).json(out);
    } catch (e) {
      if (e.status === 503) return res.status(503).json({ error: { code: e.code, message: e.message, retainedGrading: e.retainedGrading } });
      next(e);
    }
  });

  // 练习回滚（重开练习分支）
  app.post('/api/practice/:courseId/:nodeKey/rollback', auth, async (req, res, next) => {
    try {
      const { toSeq, name } = req.body || {};
      const out = await services.rollbackBranch(repo, req.user, req.params.courseId, req.params.nodeKey,
        { toSeq: Number.isInteger(toSeq) ? toSeq : undefined, name });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  // ---- 课程升级：迁移对比与执行 ----
  app.get('/api/migrations/:courseId/preview/:targetVersion', auth, async (req, res, next) => {
    try {
      res.json(await services.migrationPreview(repo, req.user, req.params.courseId, req.params.targetVersion));
    } catch (e) { next(e); }
  });

  app.post('/api/migrations/:courseId/migrate/:targetVersion', auth, async (req, res, next) => {
    try {
      const out = await services.migrate(repo, req.user, req.params.courseId, req.params.targetVersion, req.body?.choices || {});
      res.json(out);
    } catch (e) { next(e); }
  });

  // ---- 教师接口：含答案、规则、种子事件 ----
  app.get('/api/teacher/courses/:courseId', auth, requireTeacher, async (req, res, next) => {
    try {
      const versions = Object.values(catalog.versions[req.params.courseId]?.versions || {});
      if (!versions.length) return res.status(404).json({ error: { code: 'NO_COURSE', message: '课程不存在' } });
      res.json({
        courseId: req.params.courseId,
        name: catalog.versions[req.params.courseId].name,
        versions: versions.map((cv) => ({
          version: cv.version, publishedAt: cv.publishedAt, edges: cv.edges,
          nodes: cv.nodes.map(catalog.toTeacherNode),
        })),
      });
    } catch (e) { next(e); }
  });

  app.get('/api/teacher/users', auth, requireTeacher, async (req, res) => {
    res.json({ users: await repo.listUsers() });
  });

  // 失败注入：仅教师，开启后所有截图上传返回 503（用于验收“截图失败”）
  app.post('/api/teacher/debug/screenshot-failure', auth, requireTeacher, async (req, res) => {
    repo.forceScreenshotFail = Boolean(req.body?.enabled);
    res.json({ forceScreenshotFail: repo.forceScreenshotFail });
  });

  // SPA fallback
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: { code: err.code || 'INTERNAL', message: err.message } });
  });

  return app;
}

module.exports = { createApp };
