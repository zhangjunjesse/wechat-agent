# Current status

- Local HTTP service and QR image rendering: verified.
- iLink QR endpoint and protocol adapter: verified with deterministic mocks.
- Real user reported successful Bot connection in the browser, but this session's later status query observed an older binding as expired; the live credential/message path remains unverified.
- Binding records now persist to `data/bindings.json` (configure `BINDINGS_FILE`); production still needs encrypted secret storage and a migration to a real database.
- Agent is not deployed to `datadefender.cn/wechat-agent`.
- GitHub repository was pushed, but earlier API inspection reported public visibility; private visibility must be confirmed by the owner.
