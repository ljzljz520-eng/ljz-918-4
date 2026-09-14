/**
 * 摄影棚渲染队列控制台 —— Web 控制台后端
 * 零依赖：静态托管 + 进程监管 + 会话认证 + 分服务日志
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'LOG');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.CONSOLE_PORT || 8080);

// 账号（演示用，生产环境应接入用户系统并使用强口令）
const AUTH_USER = process.env.CONSOLE_USER || 'admin';
const AUTH_PASS = process.env.CONSOLE_PASS || 'studio123';

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------- 服务定义 ----------------
const SERVICES = {
  'render-daemon': {
    name: 'render-daemon',
    title: '渲染守护',
    desc: '轮询渲染队列并派发帧渲染任务',
    script: path.join(__dirname, 'render-daemon.js'),
    port: 7101,
  },
  transcoder: {
    name: 'transcoder',
    title: '素材转码',
    desc: '将相机素材转码为剪辑代理格式',
    script: path.join(__dirname, 'transcoder.js'),
    port: 7102,
  },
  cleanup: {
    name: 'cleanup',
    title: '清理服务',
    desc: '清理临时帧与过期缓存，回收磁盘',
    script: path.join(__dirname, 'cleanup.js'),
    port: 7103,
  },
};

// 运行态：pid / 启动时间 / 进程对象 / 健康状态
const runtime = new Map();
const restarting = new Set(); // 防重复重启

function logFile(name) {
  return path.join(LOG_DIR, `${name}.log`);
}

function appendConsoleLog(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  fs.appendFile(path.join(LOG_DIR, 'console.log'), line, () => {});
}

function startService(name) {
  const def = SERVICES[name];
  if (!def) return;
  const existing = runtime.get(name);
  if (existing && existing.child && !existing.child.killed) return;

  const out = fs.openSync(logFile(name), 'a');
  const startedAt = Date.now();
  fs.appendFileSync(
    logFile(name),
    `\n${new Date().toISOString()} [console] ===== 启动 ${def.title}（端口 ${def.port}） =====\n`
  );

  const child = spawn(process.execPath, [def.script], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(def.port) },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  const state = {
    pid: child.pid,
    port: def.port,
    startedAt,
    child,
    healthy: false,
    exitCode: null,
  };
  runtime.set(name, state);
  appendConsoleLog('info', `启动 ${def.title}, pid=${child.pid}, 端口=${def.port}`);

  child.on('exit', (code, signal) => {
    state.exitCode = code;
    state.healthy = false;
    appendConsoleLog(
      'warn',
      `${def.title} 退出 pid=${state.pid} code=${code} signal=${signal || '-'}`
    );
  });
}

function stopService(name) {
  const state = runtime.get(name);
  if (!state || !state.child || state.child.killed) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    state.child.once('exit', finish);
    try {
      state.child.kill('SIGTERM');
    } catch {
      finish();
    }
    // 宽限 3 秒，仍未退出则强杀
    setTimeout(() => {
      if (!done && state.child && !state.child.killed) {
        try {
          state.child.kill('SIGKILL');
        } catch {}
      }
      finish();
    }, 3000).unref();
  });
}

async function restartService(name) {
  if (restarting.has(name)) throw { status: 409, message: '该服务正在重启中，请稍候' };
  restarting.add(name);
  try {
    await stopService(name);
    await new Promise((r) => setTimeout(r, 400));
    startService(name);
    // 等待健康检查通过（最多约 10 秒）
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const state = runtime.get(name);
      if (state && state.healthy) return { ok: true, pid: state.pid };
      if (state && state.exitCode !== null && i > 3) {
        throw { status: 500, message: '服务进程启动后退出，请查看日志' };
      }
    }
    const state = runtime.get(name);
    return { ok: false, pid: state ? state.pid : null, message: '进程已拉起但健康检查未通过' };
  } finally {
    restarting.delete(name);
  }
}

// 健康探测
function healthCheck(name) {
  const def = SERVICES[name];
  const state = runtime.get(name);
  return new Promise((resolve) => {
    if (!state || state.child.killed || state.exitCode !== null) {
      if (state) state.healthy = false;
      return resolve(false);
    }
    const req = http.get(
      { host: '127.0.0.1', port: def.port, path: '/health', timeout: 800 },
      (res) => {
        res.resume();
        state.healthy = res.statusCode === 200;
        resolve(state.healthy);
      }
    );
    req.on('error', () => {
      state.healthy = false;
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      state.healthy = false;
      resolve(false);
    });
  });
}

setInterval(() => {
  Object.keys(SERVICES).forEach((n) => healthCheck(n));
}, 3000);

function buildStatus() {
  return Object.values(SERVICES).map((def) => {
    const s = runtime.get(def.name);
    const restart = restarting.has(def.name);
    const alive = !!(s && !s.child.killed && s.exitCode === null);
    let status = 'stopped';
    if (restart) status = 'restarting';
    else if (alive && s.healthy) status = 'running';
    else if (alive) status = 'starting';
    return {
      name: def.name,
      title: def.title,
      desc: def.desc,
      port: def.port,
      pid: s ? s.pid : null,
      startedAt: s ? s.startedAt : null,
      healthy: s ? s.healthy : false,
      restarting: restart,
      status,
    };
  });
}

// ---------------- 会话 ----------------
const sessions = new Map(); // token -> user

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function getUser(req) {
  const token = parseCookies(req).session || req.headers['x-csrf-token'];
  return token && sessions.has(token) ? sessions.get(token) : null;
}

// ---------------- HTTP 工具 ----------------
function sendJSON(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject({ status: 413, message: '请求体过大' });
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject({ status: 400, message: 'JSON 格式错误' });
      }
    });
    req.on('error', () => reject({ status: 400, message: '读取请求失败' }));
  });
}

function tailLines(filePath, lines) {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  const arr = content.split('\n');
  // 去掉末尾空行影响
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr.slice(-lines).join('\n');
}

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 未找到');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    // 会话状态（任何人可查，用于前端决定按钮可用性）
    if (pathname === '/api/session' && req.method === 'GET') {
      const user = getUser(req);
      return sendJSON(res, 200, { authenticated: !!user, user: user || null });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      if (username === AUTH_USER && password === AUTH_PASS) {
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, username);
        appendConsoleLog('info', `用户 ${username} 登录`);
        return sendJSON(res, 200, { ok: true, user: username }, {
          'Set-Cookie':
            `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
        });
      }
      appendConsoleLog('warn', `登录失败 user=${username || '(空)'}`);
      return sendJSON(res, 401, { ok: false, message: '用户名或密码错误' });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req).session;
      if (token) sessions.delete(token);
      return sendJSON(res, 200, { ok: true }, {
        'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
      });
    }

    // 服务状态：只读，允许未登录查看
    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, { services: buildStatus(), now: Date.now() });
    }

    // 日志：只读，允许未登录查看
    let m = pathname.match(/^\/api\/logs\/([a-z-]+)$/);
    if (m && req.method === 'GET') {
      const name = m[1];
      if (!SERVICES[name]) return sendJSON(res, 404, { message: '未知服务' });
      const lines = Math.min(Number(url.searchParams.get('lines')) || 300, 2000);
      return sendJSON(res, 200, {
        service: name,
        file: path.relative(ROOT, logFile(name)),
        content: tailLines(logFile(name), lines),
      });
    }

    // 重启服务：控制动作，必须登录
    m = pathname.match(/^\/api\/services\/([a-z-]+)\/restart$/);
    if (m && req.method === 'POST') {
      const user = getUser(req);
      if (!user) {
        return sendJSON(res, 401, { ok: false, message: '未登录或会话已过期，请先登录' });
      }
      const name = m[1];
      if (!SERVICES[name]) return sendJSON(res, 404, { ok: false, message: '未知服务' });
      appendConsoleLog('info', `用户 ${user} 请求重启 ${SERVICES[name].title}`);
      const result = await restartService(name);
      return sendJSON(res, 200, { ok: true, ...result });
    }

    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { message: '接口不存在' });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end('method not allowed');
  } catch (err) {
    const status = err.status || 500;
    appendConsoleLog('error', `${req.method} ${pathname} -> ${status} ${err.message || err}`);
    sendJSON(res, status, { ok: false, message: err.message || '服务器内部错误' });
  }
});

// 启动全部服务并开始监听
Object.keys(SERVICES).forEach(startService);

server.listen(PORT, () => {
  appendConsoleLog('info', `控制台启动: http://127.0.0.1:${PORT} （账号 ${AUTH_USER}）`);
  console.log(`摄影棚渲染队列控制台: http://127.0.0.1:${PORT}`);
  console.log(`默认账号: ${AUTH_USER} / ${AUTH_PASS}`);
});

// 控制台退出时停掉全部被管服务，避免孤儿进程占用端口
async function shutdownAll() {
  appendConsoleLog('info', '控制台关闭，停止全部被管服务');
  await Promise.all(Object.keys(SERVICES).map(stopService));
  process.exit(0);
}
process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);
