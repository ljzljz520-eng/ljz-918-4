(() => {
  const $ = (id) => document.getElementById(id);
  const servicesEl = $('services');
  const logTabsEl = $('logTabs');
  const logView = $('logView');
  const logPath = $('logPath');

  let authenticated = false;
  let statusCache = [];
  let currentLog = null;
  let logAutoTimer = null;

  const STATUS_TEXT = {
    running: '运行中',
    starting: '启动中',
    restarting: '重启中',
    stopped: '已停止',
  };

  // ---------------- 通用请求 ----------------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.message) || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, type = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------------- 会话 / 登录 ----------------
  async function refreshSession() {
    const data = await api('/api/session');
    authenticated = data.authenticated;
    renderSession(data.user);
  }

  function renderSession(user) {
    const loginCard = $('loginCard');
    const logoutBtn = $('logoutBtn');
    const info = $('sessionInfo');
    if (authenticated) {
      loginCard.hidden = true;
      logoutBtn.hidden = false;
      info.innerHTML = `已登录 · <span class="user">${escapeHtml(user)}</span>`;
    } else {
      loginCard.hidden = false;
      logoutBtn.hidden = true;
      info.textContent = '未登录（只能查看，不能重启服务）';
    }
    renderServices();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginSubmit');
    const errBox = $('loginError');
    errBox.hidden = true;
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('username').value.trim(),
          password: $('password').value,
        }),
      });
      authenticated = true;
      renderSession(data.user);
      toast('登录成功', 'ok');
      $('password').value = '';
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    authenticated = false;
    renderSession(null);
    toast('已退出登录');
  });

  // ---------------- 服务状态 ----------------
  function fmtUptime(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}小时${m}分${sec}秒`;
    if (m) return `${m}分${sec}秒`;
    return `${sec}秒`;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderServices() {
    if (!statusCache.length) {
      servicesEl.innerHTML = '<p style="color:var(--muted);font-size:13px">正在获取服务状态…</p>';
      return;
    }
    servicesEl.innerHTML = statusCache.map((s) => {
      const busy = s.status === 'restarting' || s.status === 'starting';
      const btnDisabled = !authenticated || busy;
      const btnLabel = s.status === 'restarting'
        ? '<span class="spin">⟳</span> 重启中'
        : '重启服务';
      const lockHint = authenticated
        ? (busy ? '服务状态变更中…' : '重启将先停止再拉起进程')
        : '登录后可执行重启';
      return `
      <article class="svc">
        <div class="svc-head">
          <div>
            <div class="svc-title">${escapeHtml(s.title)}</div>
            <div class="svc-desc">${escapeHtml(s.desc)}</div>
          </div>
          <span class="badge ${s.status}"><span class="dot"></span>${STATUS_TEXT[s.status]}</span>
        </div>
        <dl class="svc-meta">
          <dt>进程号</dt><dd>${s.pid ?? '—'}</dd>
          <dt>端口</dt><dd>${s.port}</dd>
          <dt>启动时间</dt><dd>${fmtTime(s.startedAt)}</dd>
          <dt>已运行</dt><dd>${fmtUptime(s.startedAt ? Date.now() - s.startedAt : null)}</dd>
        </dl>
        <div class="svc-foot">
          <button class="svc-loglink" data-log="${s.name}">查看日志 ↓</button>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="locked-hint">${lockHint}</span>
            <button class="btn btn-primary restart-btn" data-restart="${s.name}" ${btnDisabled ? 'disabled' : ''}>
              ${btnLabel}
            </button>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  async function pollStatus() {
    try {
      const data = await api('/api/status');
      statusCache = data.services;
      renderServices();
      $('lastTick').textContent = `状态更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
    } catch {
      // 网络抖动时保留上次状态
    }
  }

  // 事件委托：重启 / 跳转日志
  servicesEl.addEventListener('click', async (e) => {
    const restartBtn = e.target.closest('[data-restart]');
    if (restartBtn) {
      if (!authenticated) {
        toast('请先登录后再执行控制动作', 'err');
        return;
      }
      const name = restartBtn.dataset.restart;
      const svc = statusCache.find((x) => x.name === name);
      if (!confirm(`确认重启「${svc.title}」？该服务将短暂中断。`)) return;
      restartBtn.disabled = true;
      restartBtn.innerHTML = '<span class="spin">⟳</span> 重启中';
      try {
        const r = await api(`/api/services/${encodeURIComponent(name)}/restart`, { method: 'POST' });
        if (r.ok === false) toast(r.message || '健康检查未通过，请查看日志', 'err');
        else toast(`「${svc.title}」已重启，新进程号 ${r.pid}`, 'ok');
      } catch (err) {
        toast(err.status === 401 ? '登录已过期，请重新登录' : err.message, 'err');
        if (err.status === 401) { authenticated = false; refreshSession(); }
      }
      pollStatus();
      return;
    }
    const logLink = e.target.closest('[data-log]');
    if (logLink) {
      selectLog(logLink.dataset.log);
    }
  });

  // ---------------- 日志 ----------------
  function colorize(text) {
    return escapeHtml(text)
      .replace(/^(.*\[(?:INFO|console)\].*)$/gm, '<span class="lv-info">$1</span>')
      .replace(/^(.*\[WARN\].*)$/gm, '<span class="lv-warn">$1</span>')
      .replace(/^(.*\[ERROR\].*)$/gm, '<span class="lv-error">$1</span>');
  }

  async function loadLog(name, preserveScroll = false) {
    try {
      const data = await api(`/api/logs/${encodeURIComponent(name)}?lines=400`);
      const stickBottom = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 30;
      logView.innerHTML = colorize(data.content || '（暂无日志）');
      logPath.textContent = `LOG/${data.file.split(/[\\/]/).pop()}（最近 400 行）`;
      if (!preserveScroll || stickBottom) logView.scrollTop = logView.scrollHeight;
    } catch (err) {
      logView.textContent = `日志加载失败：${err.message}`;
    }
  }

  function renderLogTabs() {
    logTabsEl.innerHTML = statusCache.map((s) =>
      `<button class="log-tab ${s.name === currentLog ? 'active' : ''}" data-tab="${s.name}">${escapeHtml(s.title)}</button>`
    ).join('');
  }

  function selectLog(name) {
    currentLog = name;
    renderLogTabs();
    loadLog(name);
  }

  logTabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) selectLog(tab.dataset.tab);
  });

  $('refreshLog').addEventListener('click', () => currentLog && loadLog(currentLog));

  $('autoRefresh').addEventListener('change', (e) => {
    if (e.target.checked) startLogTimer(); else stopLogTimer();
  });

  function startLogTimer() {
    stopLogTimer();
    logAutoTimer = setInterval(() => { if (currentLog) loadLog(currentLog, true); }, 3000);
  }
  function stopLogTimer() {
    if (logAutoTimer) clearInterval(logAutoTimer);
    logAutoTimer = null;
  }

  // ---------------- 启动 ----------------
  (async function init() {
    await refreshSession();
    await pollStatus();
    currentLog = statusCache[0] ? statusCache[0].name : null;
    renderLogTabs();
    if (currentLog) loadLog(currentLog);
    setInterval(pollStatus, 3000);   // 状态轮询
    startLogTimer();                 // 日志自动刷新
  })();
})();
