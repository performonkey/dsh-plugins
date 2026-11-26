---
kind: upgrade-guide
description: "Cluster relay HTTP requests return 503 when the worker disconnects instead of 504."
---
# Cluster relay disconnect responses

English | [中文](guide.zh.md)

## Change

The Cloudflare cluster relay returns HTTP 503 with `code: "gateway/worker-disconnected"` when a worker disconnects during an HTTP request. A relay timeout returns HTTP 504 with `code: "gateway/timeout"`. Clients that classified both outcomes by HTTP 504 must handle the disconnect separately.

## Migration

1. Update cluster relay HTTP clients that handle status 504 to also handle status 503 for worker disconnection. Inspect the JSON `code` when distinguishing a disconnect from other 503 responses.
2. Disconnect the worker during a pending request and confirm the client reports the 503 disconnect outcome; confirm a request that reaches the relay timeout reports 504.
