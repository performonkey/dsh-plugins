# DeepSeek Harness 分布式 Master-Worker 架构实施计划

> **版本**：v1.1 (Reviewed & Refined)  
> **状态**：方案制定 (Approved for Execution)  
> **目标**：将 DeepSeek Harness 改造为分布式架构——主节点（Master）仅用于注册管理和展示 DSH Web，所有代码编辑、命令执行与 Agent 任务下发给 Worker 节点执行。

---

## 1. 核心目标与架构原则

### 1.1 核心目标
1. **Master 纯前端化与控制面化**：Master 节点仅负责托管 `dsh web` 静态界面、管理 Worker 节点反向注册接入、维护透明网络隧道；Master 本机不具备项目代码、不执行本地命令、不读写本地工作区。
2. **Worker 承载所有执行**：Worker 节点部署在拥有真实项目代码、工具链（Git、Node、Python、Docker 等）的机器上，承载 Agent 会话运行、工具调用与交互终端执行。
3. **零侵入核心循环**：基于 Cordis 插件体系与已有的 Typert API Gateway / Connection 切面进行非侵入式扩展，不修改 [`packages/core/agent-loop`](file:///home/liujh/workspaces/deepseek-harness/packages/core/agent-loop)。

### 1.2 关键架构原则
- **反向长连接（Reverse WebSocket Tunnel）**：Worker 主动向公网 Master 发起 WSS 长连接握手，天然穿透 NAT 和内网防火墙，无需配置公网 IP 或复杂端口映射。
- **连接层透明多路复用隧道（Wire-level Multiplexing Tunnel）**：Master 对前端发来的 `/api` HTTP 请求与 `/api/remote.mux` WebSocket 复合流进行帧级（Frame-level）透明路由，而不拆包做业务方法重写；由 Worker 本机的原生 `TypertGatewayService` 进行无缝解包和分发，实现全量 `@Remote` 方法、双向 PTY 终端与交互式 Waterfall（`$events`）的零损耗保真。
- **数据本地化（Data Proximity）**：代码仓库和持久化 Session 日志完全保留在 Worker 本地，跨网络仅传输轻量级的控制流与流式文本帧。
- **分阶段演进**：第一阶段（Phase 1）聚焦“单 Worker 独占绑定”，快速完成全功能闭环验收；第二阶段（Phase 2）扩展为“多 Worker 节点注册与路由选择”。

---

## 2. 总体拓扑与通信协议

### 2.1 系统拓扑结构

```
+-----------------------------------------------------------------------------------------+
|                                Master 主节点 (公共服务器 / 云端)                            |
|                                                                                         |
|   +-------------------+        +--------------------+        +---------------------+    |
|   |  DSH Web UI 前端   |  <-->  |  Worker 注册中心    |  <-->  |  网络隧道网关 (Proxy) |    |
|   | (dsh-web-app 托管)|        | (Worker Registry)  |        | (Wire Tunnel Relay) |    |
|   +---------^---------+        +--------------------+        +----------+----------+    |
+-------------|-----------------------------------------------------------|---------------+
              | 浏览器访问                                                 | 反向长连接
              | (HTTP/WS)                                                 | (WebSocket 隧道)
+-------------v---------------------+                   +-----------------v---------------+
| 终端用户 (Web 浏览器)               |                   | Worker 节点 (开发机 / 独立容器)   |
| - 打开 Master 提供的 Web 页面       |                   | - 本地持有代码工程与 Git 仓库   |
| - 连接指定 Worker 节点             |                   | - 跑 DSH 无头 Agent 运行环境   |
| - 发送 Prompt，交互式终端与问答     |                   | - 真正执行文件读写、Bash 与工具 |
+-----------------------------------+                   +---------------------------------+
```

### 2.2 隧道帧协议设计 (`cluster-protocol`)

Master 与 Worker 之间仅维护一条物理反向 WebSocket 管道，通过轻量级二进制/JSON 复合帧实现多路复用：

| 帧类型 (`type`) | 字段结构 | 说明 |
|---|---|---|
| `control:hello` | `{ workerId, name, workspaces, version }` | Worker 连接成功后上报元数据与工作区根目录 |
| `control:ready` | `{ accepted: boolean, masterTime }` | Master 鉴权通过并返回确认 |
| `http:req` | `{ reqId, method, path, headers, body }` | 透传浏览器发往 Master 的一元 RPC（`/api` POST） |
| `http:resp` | `{ reqId, status, headers, body }` | Worker 回传 HTTP 响应 |
| `stream:open` | `{ streamId, endpoint, payload, peer }` | 浏览器开启 `/api/remote.mux` 逻辑流（如 `terminal`、`session.follow`） |
| `stream:item` | `{ streamId, value }` | 流式数据下行推送（LLM 生成文字、终端输出帧） |
| `stream:uplink` | `{ streamId, item }` | 终端输入按键、交互式卡片决议上行回传 |
| `stream:close` | `{ streamId, reason }` | 逻辑流正常结束或主动取消 |
| `ping` / `pong` | `{ timestamp }` | 链路保活与断线探测（连续 2 次无响应触发退避重连） |

---

## 3. 核心组件与工程结构

按照 DSH 规范，所有新增能力在 `packages/experimental/` 下维护独立模块：

### 3.1 协议包：`@deepseek-ai/dsh-experimental-cluster-protocol`
- **定位**：纯类型与帧编解码库，零外部依赖，Master 与 Worker 共享。
- **核心文件**：
  - `src/frames.ts`：隧道帧 TypeScript 类型定义与序列化/反序列化。
  - `src/constants.ts`：默认心跳间隔（15s）、超时阈值（2 次 missed pongs）与隧道默认路径（`/api/worker/connect`）。

### 3.2 Master 侧插件：`@deepseek-ai/dsh-experimental-cluster-master`
- **定位**：Cordis 插件，挂载于 Master 进程中。
- **核心职责**：
  1. **Worker Registry**：暴露 `/api/worker/connect` 端点，校验 Token 并维护在线 Worker 池。
  2. **Fetch Interceptor**：拦截前来的 `/api` 请求，将其封装为 `http:req` 帧转发至目标 Worker。
  3. **WebSocket Relay**：拦截 `/api/remote.mux`，将逻辑流 `open`/`item`/`uplink` 帧无损代理至 Worker。
  4. **Remote Directory Picker Provider**：向前端提供远程目录选择代理，列出 Worker 报告的合法目录路径。

### 3.3 Worker 侧插件：`@deepseek-ai/dsh-experimental-cluster-worker`
- **定位**：Cordis 插件，挂载于 Worker 进程中。
- **核心职责**：
  1. **Tunnel Client**：启动时主动向 Master 发起反向 WebSocket 连接，支持退避重连。
  2. **Local Gateway Dispatcher**：收到 `http:req` 与 `stream:open` 后，本地调用原生的 `ctx.typertGateway.invoke()` 与 `wireStream.open()`。
  3. **Event Stream Relay**：将 Worker 本机产生的流式输出和 `$events` 广播回传至 Master 隧道。

### 3.4 Profile 组合设计

- **`profiles/master`**：
  - 启用：`dsh-web-app`、`frontend-static`、`webserver`、`identity`、`credentials`、`cluster-master`。
  - 禁用：`ctx.subprocess`、`ctx.fs`、`ctx.agentLoop`、`ctx.terminals`、`ctx.tools`、`ctx.session`。
- **`profiles/worker`**：
  - 启用：`dsh-base`、`agent-loop`、`session`、`tools`、`terminal`、`subprocess`、`fs`、`cluster-worker`。
  - 禁用：`dsh-web-app`、`webserver`、`frontend-static`（不占用本地 HTTP 端口）。

---

## 4. 里程碑实施计划

### Milestone 1：帧协议与反向 WebSocket 隧道 PoC（已完成）
- [x] 创建 `@deepseek-ai/dsh-cluster-protocol` 包，完成帧定义与编解码单元测试。
- [x] 创建 `@deepseek-ai/dsh-cluster-master` 与 `@deepseek-ai/dsh-cluster-worker` 核心骨架。
- [x] 验证 Worker 反向连接 Master、Token 校验握手、心跳保活与自动重连。
- [x] 验证基础 HTTP/RPC 请求与响应的单次端到端往返。

### Milestone 2：Typert Gateway 与双向流式隧道打通（已完成）
- [x] 实现 `MasterRelay.handleHttpRequest`，将 Master 的 `/api` HTTP 路由接入隧道转发。
- [x] 实现 `MasterRelay.handleMuxUpgrade`，将 Master 的 `/api/remote.mux` 复合流无损中继至 Worker。
- [x] 实现 `WorkerStreamDispatcher` 与 `AsyncQueue`，打通 Worker 本地流式执行下行与 Uplink 上行交互通道。
- [x] 端到端验证：Web 前端在 Master 打开，触发 Worker 跑出流式输出（LLM 文本与工具调用帧）以及终端/Waterfall 双向交互。

### Milestone 3：终端 PTY、工作区选择与交互卡片保真（已完成）
- [x] 验证基于 `stream:uplink` 的 Web Terminal（Xterm）在 Worker 上的命令执行与窗口缩放。
- [x] 接入 Remote Directory Picker，支持 Web 界面浏览和选择 Worker 机器上的工程目录。
- [x] 验证 Agent 交互卡片（`ask_question`、权限确认等 `$events` Waterfall）的交互提交与错误降级。

### Milestone 4：Profile 组装、健壮性与自动化测试（已完成）
- [x] 创建 Master 与 Worker 的 `cordis.patch.yml` profile 配置并支持环境变量配置。
- [x] 增加 Worker 离线状态（503 Service Unavailable）的前端友好错误与重连后自动恢复。
- [x] 编写端到端自动化测试用例（覆盖帧协议、透明代理、PTY 终端流式上行交互、Remote Directory Picker、离线恢复）。
