// 素材转码服务 transcoder
// 将相机素材转码为编辑友好的代理格式（演示实现）
const http = require('http');
const PORT = Number(process.env.PORT || 7102);
const SERVICE = 'transcoder';

let clips = 0;

const log = (level, msg) =>
  console.log(`${new Date().toISOString()} [${level}] ${msg}`);

log('info', `素材转码服务启动, 监听端口 ${PORT}`);

const sources = ['A7S3_0001.MP4', 'A7S3_0002.MP4', 'RONIN_2310.MOV'];
const timer = setInterval(() => {
  const src = sources[clips % sources.length];
  clips++;
  log('info', `发现素材 ${src}，转码为 ProRes Proxy 中...`);
  setTimeout(() => {
    log('info', `${src} 转码完成（${clips}），已移入 PROXY/`);
  }, 1200);
}, 6500);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ service: SERVICE, status: 'ok', clips }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => log('info', `HTTP 健康检查 http://127.0.0.1:${PORT}/health`));

function shutdown(sig) {
  log('info', `收到 ${sig}，排空转码队列后退出`);
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
