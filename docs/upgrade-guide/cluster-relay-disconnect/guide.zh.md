---
kind: upgrade-guide
description: "集群中继的 HTTP 请求在 worker 断开时返回 503，而不是 504。"
---
# 集群中继断开响应

[English](guide.md) | 中文

## 变更

HTTP 请求期间 worker 断开时，Cloudflare 集群中继返回 HTTP 503 和 `code: "gateway/worker-disconnected"`。中继超时返回 HTTP 504 和 `code: "gateway/timeout"`。此前通过 HTTP 504 识别这两种结果的客户端必须单独处理断开情况。

## 迁移

1. 更新处理状态码 504 的集群中继 HTTP 客户端，使其也处理表示 worker 断开的状态码 503。需要区分断开与其他 503 响应时，检查 JSON 中的 `code`。
2. 在请求等待期间断开 worker，确认客户端报告 503 断开结果；确认达到中继超时的请求报告 504。
