# 摄影棚渲染队列控制台

本机服务监管台：展示 **渲染守护 / 素材转码 / 清理服务** 的进程号、端口、启动时间与运行状态，
支持在页面上重启指定服务；日志按服务分文件存放在 `LOG/`。**未登录用户只能查看，不能执行任何控制动作。**

## 启动

```bash
npm start          # 或 node server/console-server.js
```

打开 http://127.0.0.1:8080

默认账号：`admin` / `studio123`（可用环境变量 `CONSOLE_USER` / `CONSOLE_PASS` 修改）

## 服务与端口

| 服务 | 脚本 | 端口 | 日志 |
| --- | --- | --- | --- |
| 渲染守护 render-daemon | `server/render-daemon.js` | 7101 | `LOG/render-daemon.log` |
| 素材转码 transcoder | `server/transcoder.js` | 7102 | `LOG/transcoder.log` |
| 清理服务 cleanup | `server/cleanup.js` | 7103 | `LOG/cleanup.log` |
| 控制台自身 | `server/console-server.js` | 8080 | `LOG/console.log` |

每个服务都有 `/health` 健康检查端点，控制台每 3 秒探测一次并刷新状态
（运行中 / 启动中 / 重启中 / 已停止）。

## 接口

| 方法 | 路径 | 是否需要登录 |
| --- | --- | --- |
| GET | `/api/session` | 否 |
| POST | `/api/login` | 否 |
| POST | `/api/logout` | 否 |
| GET | `/api/status` | 否（只读） |
| GET | `/api/logs/:name` | 否（只读） |
| POST | `/api/services/:name/restart` | **是** |

未登录调用重启接口返回 `401`。会话使用 HttpOnly Cookie（`SameSite=Strict`），服务端内存保存令牌。

## 说明

- 重启流程：SIGTERM 优雅停止 → 等待退出（3 秒超时后 SIGKILL）→ 重新 spawn，并等待健康检查通过。
- 控制台退出时会一并停止其拉起的全部服务，避免孤儿进程占用端口。
- 三个被管服务为演示用模拟器（定时写日志），替换 `server/` 下脚本即可接入真实流水线。
