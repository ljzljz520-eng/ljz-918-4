// 清理服务 cleanup
// 定期清理临时帧与过期缓存（演示实现）
const http = require('http');
const PORT = Number(process.env.PORT || 7103);
const SERVICE = 'cleanup';

let swept = 0;
const freedMB = () => (Math.random() * 400 + 50).toFixed(1);

const log = (level, msg) =>
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);

log('info', `清理服务启动, 监听端口 ${PORT}`);

const timer = setInterval(() => {
  swept++;
  const mb = freedMB();
  log('info', `第 ${swept} 轮清理：扫描 TEMP/ 与 CACHE/`);
  setTimeout(() => {
    if (swept % 4 === 0) log('warn', '部分缓存被占用，已跳过（属正常）');
    log('info', `清理完成，释放约 ${mb} MB`);
  }, 600);
}, 8000);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ service: SERVICE, status: 'ok', swept }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => log('info', `HTTP 健康检查 http://127.0.0.1:${PORT}/health`));

function shutdown(sig) {
  log('info', `收到 ${sig}，终止清理任务并退出`);
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
