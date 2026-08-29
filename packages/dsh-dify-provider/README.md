# dsh-dify-provider

Native DSH `LlmAdapter` for Dify Chat applications. It receives DSH `GenerateOptions.sessionId` directly and maps each `(sessionId, providerId, appId)` to an independent Dify `conversation_id`.

## Local development install

```bash
cd packages/dsh-dify-provider
pnpm install

dsh plugin --profile headless add "$PWD" --reporter=append-only
```

## Minimal configuration

The bundled patch reads these environment variables:

```bash
export DIFY_API_URL="https://your-dify.example/v1"
export DIFY_API_KEY="app-..."
export DIFY_PROVIDER_ID="dify"
export DIFY_APP_ID="default"
export DIFY_MODEL_NAME="Dify"
```

Select the provider/model in `$DSH_HOME/settings.yaml`:

```yaml
agent-default-model:
  provider: dify
  model: default
```

Then run:

```bash
dsh --profile headless "Reply using the configured Dify application."
```

The API key is resolved from the configured credential reference (`DIFY_API_KEY` by default) and is never included in structured traces.

## Lifecycle

- `BOOTSTRAP`: no downstream cursor exists; full canonical DSH history is sent with an empty Dify `conversation_id`.
- `CONTINUE`: the same DSH session/provider/app reuses its saved Dify `conversation_id` and sends only the gap since the last response produced by this provider/app.
- `TOOL_CONTINUE`: DSH tool results retain the original `ToolCallId` and are forwarded on the same Dify conversation.
- `RECOVER`: an invalid downstream conversation cursor is invalidated and rebuilt once from DSH history.
- `RESET`: exposed by the adapter's `resetSession(sessionId, appId)` lifecycle seam; a future DSH command/UI can bind to it without changing the state store.

Provider switching does not delete mappings, so returning to the same Dify app resumes its previous downstream cursor.

Current limitation: image attachment blocks are rejected with `UNSUPPORTED_CONTENT` instead of being silently dropped. Text, tools, tool-result continuation, Dify SSE, usage, cancellation signal propagation, timeout, and invalid-conversation recovery are implemented.
