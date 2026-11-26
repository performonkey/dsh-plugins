# DSH Plugins (DeepSeek Harness 自定义插件与扩展合集)

[English](#english) | [中文](#中文)

---

<a id="中文"></a>
## 中文说明

本项目是针对 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的社区插件、扩展能力与分布式套件合集。所有插件均遵循 Cordis 插件体系与 DSH Bundle 规范组织，可直接作为独立 Bundle 安装加载。

### 📦 包含的插件与组件

| 目录/包名 | 说明 | 类型 |
|---|---|---|
| [`packages/subagent-agy`](./packages/subagent-agy) | **Antigravity CLI (agy) 子智能体提供商**：支持在 DSH 中直接将子任务委托给 Antigravity CLI 执行，支持只读/全权限沙箱与超时控制。 | DSH Bundle (Host) |
| [`packages/cluster-protocol`](./packages/cluster-protocol) | **分布式集群协议层**：包含 Master 与 Worker 之间反向 WebSocket 多路复用隧道的二进制帧编解码器及消息契约。 | Library |
| [`packages/cluster-master`](./packages/cluster-master) | **分布式集群 Master 节点**：将 DSH 改造为纯前端/控制面，自身不执行代码，通过反向长连接隧道透传 RPC 与 Web 交互到 Worker。 | DSH Bundle (Host) |
| [`packages/cluster-worker`](./packages/cluster-worker) | **分布式集群 Worker 节点**：部署在真实工作区机器上，主动向 Master 发起反向 WSS 连接，承载 Agent 循环、终端 PTY 与工具执行。 | DSH Bundle (Host) |
| [`packages/cluster-cloudflare-master`](./packages/cluster-cloudflare-master) | **Cloudflare Workers / Durable Objects Master**：无服务器版 Master 中继节点。 | Edge Worker |
| [`packages/ui-terminal-mobile-keyboard`](./packages/ui-terminal-mobile-keyboard) | **移动端终端软键盘快捷操作条**：在移动端网页访问 DSH 终端时，在输入法上方浮动快捷按键（Tab、Ctrl、Alt、Esc、方向键等）。 | Client Component |
| [`patches/`](./patches) | 对 DSH 官方包的增强补丁（如目录选择器后端配置支持、Subagent SDK 版本同步等）。 | Patches |
| [`docs/`](./docs) | 架构设计文档（Master-Worker 分布式架构实施计划）及升级指引。 | Documentation |

---

### 🚀 安装与使用方式

DSH 内置支持从 GitHub 安装外部 Bundle。当你将本仓库推送到 GitHub 后（假设仓库名为 `performonkey/dsh-plugins`）：

#### 1. 安装 Antigravity CLI 子智能体 (`subagent-agy`)
在你的 DeepSeek Harness 目录下执行：
```bash
# 通过 CLI 安装到默认或指定 profile（例如 web）
pnpm dsh plugin --profile web add github:performonkey/dsh-plugins#path:packages/subagent-agy

# 或者直接在 DSH Web 界面的「Plugins (插件管理)」页面中输入安装地址：
# github:performonkey/dsh-plugins#path:packages/subagent-agy
```
安装后，系统会自动合并 `cordis.patch.yml`，在 Agent 中启用 `subagent_agy` 工具。

#### 2. 安装分布式集群套件 (`cluster-master` / `cluster-worker`)
- **Master 节点**：
  ```bash
  pnpm dsh plugin --profile web add github:performonkey/dsh-plugins#path:packages/cluster-master
  ```
- **Worker 节点**：
  ```bash
  pnpm dsh plugin --profile headless add github:performonkey/dsh-plugins#path:packages/cluster-worker
  ```

#### 3. 发布到 npm（可选）
如果你将各子包发布到 npm（例如 `npm publish`），安装方式更加直接：
```bash
pnpm dsh plugin add @deepseek-ai/dsh-subagent-agy
```

---

<a id="english"></a>
## English Description

This repository is a collection of community plugins, extensions, and distributed clustering suites for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Built on top of the Cordis plugin framework and DSH Bundle specifications.

### 📦 Packages

- **`packages/subagent-agy`**: Antigravity CLI (`agy`) one-shot delegated subagent provider.
- **`packages/cluster-protocol`**: Frame codecs and type contracts for distributed Master-Worker reverse multiplexed WebSocket tunnels.
- **`packages/cluster-master`**: Pure control-plane & GUI host overlay that relays requests to workers.
- **`packages/cluster-worker`**: Execution engine running on target workspaces, dialing into Master via reverse WebSocket.
- **`packages/cluster-cloudflare-master`**: Cloudflare Workers & Durable Objects implementation of Cluster Master.
- **`packages/ui-terminal-mobile-keyboard`**: Floating quick key strip (Tab, Ctrl, Esc, Arrows) for mobile browser terminal sessions.
- **`patches/`**: Patch files for core enhancements (such as directory-picker-auto backend configurations).
- **`docs/`**: Architecture plans and upgrade references.

### 🚀 Installation via DSH Plugin Manager

Once published to GitHub:
```bash
pnpm dsh plugin --profile web add github:performonkey/dsh-plugins#path:packages/subagent-agy
```
Or install via npm after publishing:
```bash
pnpm dsh plugin add <package-name>
```
