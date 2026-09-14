// 渲染守护服务 render-daemon
// 负责轮询渲染队列并派发渲染任务（演示实现）
const http = require('http');
const PORT = Number(process.env.PORT || 7101);
const SERVICE = 'render-daemon';

let jobsHandled = 0;

const log = (level, msg) =>
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);

log('info', `渲染守护启动, 监听端口 ${PORT}`);

const jobs = ['SHOT_A01_主光比.exr', 'SHOT_B02_环境补光.exr', 'SHOT_C03_逆光轮廓.exr'];

const timer = setInterval(() => {
  const job = jobs[jobsHandled % jobs.length];
  jobsHandled++;
  log('info', `取出队列任务 #${jobsHandled}: ${job} -> 开始渲染`);
  setTimeout(() => {
    if (jobsHandled % 7 === 0) {
      log('warn', `任务 #${jobsHandled} 采样不足，已退回重渲`);
    } else {
      log('info', `任务 #${jobsHandled} 渲染完成，帧已写入 OUTPUT/`);
    }
  }, 800);
}, 5000);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ service: SERVICE, status: 'ok', jobsHandled }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => log('info', `HTTP 健康检查 http://127.0.0.1:${PORT}/health`));

function shutdown(sig) {
  log('info', `收到 ${sig}，停止接单并退出`);
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
