# Provider adapter boundary

A real adapter must implement the methods documented in
`src/contracts/bot-provider.mjs`:

- `createBindingQr({ userId })`
- `getBindingStatus({ bindingRef })`
- `sendText({ providerBotId, toProviderUserId, text })`

The adapter must normalize provider-specific data before returning it. Do not
place provider SDK imports in `src/services` or expose provider secrets to the
HTTP layer.

The CSDN reference supplied for this project is linked in the root README. Its
API contract was not machine-verifiable in the current environment, so this
folder intentionally contains only the Mock provider until concrete SDK
endpoints and callback examples are supplied.
