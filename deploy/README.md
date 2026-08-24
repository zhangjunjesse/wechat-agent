# Deployment plan

The server currently has no host Node.js image/runtime. Before deploying the
JavaScript service, use a Node 22 slim image (or install Node 22) and add a
systemd/Docker service. Do not reuse the existing `wechat-sync` container or
Caddy route without an explicit deployment change.

Target URL:

```text
https://datadefender.cn/wechat-agent
```

Required reverse proxy:

```text
handle /wechat-agent* {
    reverse_proxy 127.0.0.1:8789
}
```

The iLink provider requires outbound HTTPS to `ilinkai.weixin.qq.com`; no
credentials should be put in the repository. A production deployment must add
encrypted credential persistence, an authenticated browser session, and a
webhook/worker supervisor before exposing real QR login publicly.
