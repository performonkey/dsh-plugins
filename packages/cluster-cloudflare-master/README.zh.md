# DeepSeek Harness 集群 Master (Cloudflare Workers & Durable Objects)

[English](README.md) | 中文

基于 **Cloudflare Workers** 与全局单例 **Durable Object** (`ClusterMasterDO`) 实现的 Serverless 版 DeepSeek Harness (DSH) 集群 Master 节点。

本模块提供零运维成本、免买免配服务器的 Master 转发网关，**内存零磁盘读写**，专为 **Cloudflare 免费套餐** 设计。

---

## 核心特性

- **Serverless 全球边缘加速**：基于 Cloudflare 全球 300+ 城市边缘节点，自动处理 SSL/TLS 证书终止、抗 DDoS 与低延迟接入。
- **0 磁盘读写，免超限**：反向 WebSocket 隧道、浏览器会话以及 HTTP 请求关联 ID (`TunnelRequestId`) 全部驻留于 Durable Object 运行时内存。不调用 `state.storage.get()` 或 `put()`，不消耗免费套餐的读写配额。
- **内置 HTTP Basic Auth 鉴权**：边缘级内置时序安全的 HTTP Basic Auth 校验，直接拦截未授权请求。反向隧道接口 (`/api/worker/connect`) 自动豁免 Basic Auth 并由集群 Token 握手保护。
- **全双工 WebSocket 与 HTTP RPC 转发**：支持浏览器端 WebSocket 多路复用 (`/api/remote.mux`) 与一元 HTTP RPC (`/api/*`) 双向穿透转发。
- **完全兼容免费套餐**：
  - Cloudflare 免费计划提供每日 100,000 次 Workers 请求与基础 Durable Objects 配额。
  - 纯内存运行彻底避开 DO 存储计费门槛。

---

## 架构拓扑

```
                    Cloudflare Edge (Worker / DO)
┌────────────────┐      HTTPS / WSS (Basic Auth)      ┌─────────────────────────┐
│ Browser Client │ ─────────────────────────────────> │ Cloudflare Worker Edge  │
└────────────────┘                                    └────────────┬────────────┘
                                                                   │
                                                                   ▼
┌────────────────┐     WSS Reverse Tunnel (Cluster Token)   ┌─────────────────────┐
│  Local Worker  │ ───────────────────────────────────────> │  ClusterMasterDO    │
│  (promaxgb10)  │ <─────────────────────────────────────── │ (In-Memory Gateway) │
└────────────────┘                                          └─────────────────────┘
```

图中四个方框依次为：浏览器 Web 客户端、Cloudflare 边缘 Worker、本地 Worker 节点、纯内存网关路由的 `ClusterMasterDO`。

1. **反向隧道连接**：本地 Worker 主动向 `wss://<your-worker>.workers.dev/api/worker/connect` 发起长连接。本地完全无需公网 IP 或路由器端口映射。
2. **集群握手鉴权**：Worker 在建立连接时发送 `control:hello` 报文，核验 `AUTH_TOKEN`。
3. **Web 页面访问**：用户访问 `https://<your-worker>.workers.dev`，边缘 Worker 校验 HTTP Basic Auth (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS`)。
4. **全双工转发**：鉴权通过后，浏览器的 WebSocket 多路复用信道 (`/api/remote.mux`) 与所有 HTTP 请求直接透传到在线的本地 Worker。

---

## 环境变量配置

在 `wrangler.jsonc` 的 `vars` 中配置，或通过 Cloudflare 密钥管理配置：

| 变量名 | 作用说明 | 默认值 |
|---|---|---|
| `AUTH_TOKEN` | Worker 握手鉴权所需的预共享密钥 | 随机十六进制字符串 |
| `BASIC_AUTH_USER` | Web 界面与 API 访问的 Basic Auth 用户名 | `admin` |
| `BASIC_AUTH_PASS` | Web 界面与 API 访问的 Basic Auth 密码 | `dsh2026` |

在生产环境中推荐使用 Cloudflare Secrets 避免密码入库：
```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
```

---

## 一键部署步骤

### 1. 准备工作
进入该模块目录：
```bash
cd packages/experimental/cluster-cloudflare-master
```

### 2. 本地测试与运行
运行自动化单元测试与集成测试：
```bash
pnpm test
```

启动本地调试开发服务器：
```bash
pnpm dev
```

### 3. 发布到 Cloudflare
执行部署命令：
```bash
npx wrangler deploy
```

部署成功后，控制台会输出访问地址：
```text
Uploaded dsh-cluster-master (x.xx sec)
Deployed dsh-cluster-master triggers (x.xx sec)
  https://dsh-cluster-master.<your-subdomain>.workers.dev
```

---

## 连接本地 Worker 节点

在拥有算力或本地开发环境的机器上运行：

```bash
DSH_CLUSTER_MASTER_URL="wss://dsh-cluster-master.<your-subdomain>.workers.dev/api/worker/connect" \
DSH_CLUSTER_AUTH_TOKEN="<your-auth-token>" \
DSH_CLUSTER_WORKER_NAME="Promax-Worker" \
pnpm dsh --profile web --patch packages/experimental/cluster-worker/cordis.patch.yml
```

如果本地需要通过网络代理访问外网，`@deepseek-ai/dsh-cluster-worker` 会自动读取并适配 `https_proxy` / `http_proxy` / `ALL_PROXY`。

---

## 请求生命周期

浏览器的每个 HTTP 请求都会经隧道转发给 Worker，并由最先发生的一方决定结果：

| 结果 | 发给 Worker 的信号 | 浏览器看到 |
|---|---|---|
| Worker 按时响应 | 无 | Worker 自己的状态码与响应体 |
| Worker 静默 60 秒 | `http:cancel` | `504`，错误码 `gateway/timeout` |
| 浏览器放弃该请求 | `http:cancel` | `499`；此时调用方已经离开 |

浏览器离开页面、刷新页面或关掉正在等待的对话框，都算放弃请求。中转层会把这次放弃转告 Worker，让 Worker 及时停掉对应的操作，而不是一直等到超时。放弃之后才到达的 Worker 响应会被丢弃。

---

## 许可协议

MIT
