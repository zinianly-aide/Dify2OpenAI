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

## Context-aware compression

The native provider uses the shared deterministic `ContextProfiler -> CompressionPolicy -> ContextCompressor` pipeline before building the outbound Dify query. Compression changes only the context sent downstream; DSH lifecycle, tool correlation, attachment lookup, and conversation bookkeeping continue to operate on the original canonical messages.

Default utilization rules are configuration values, not branches duplicated through request handling code:

```text
< 0.55       none
0.55 - 0.70  tool_prune
0.70 - 0.82  light
0.82 - 0.92  heavy
>= 0.92      forced heavy
```

The final band deliberately performs forced deterministic compression in this stage. It does not automatically route to another backend and does not tune thresholds from telemetry.

For the gateway and the native provider, defaults can be overridden with:

```bash
export GATEWAY_COMPRESSION_TOOL_PRUNE_THRESHOLD=0.55
export GATEWAY_COMPRESSION_LIGHT_THRESHOLD=0.70
export GATEWAY_COMPRESSION_HEAVY_THRESHOLD=0.82
export GATEWAY_COMPRESSION_FORCE_THRESHOLD=0.92
export GATEWAY_COMPRESSION_RECENT_TURNS=3
export GATEWAY_COMPRESSION_LIGHT_SUMMARY_MAX_CHARS=2400
export GATEWAY_COMPRESSION_HEAVY_SUMMARY_MAX_CHARS=1200
```

A native provider config can also override the same values explicitly:

```yaml
compression:
  toolPruneThreshold: 0.55
  lightThreshold: 0.70
  heavyThreshold: 0.82
  forceThreshold: 0.92
  preservedRecentTurns: 3
  lightSummaryMaxChars: 2400
  heavySummaryMaxChars: 1200
```

`CompressionPolicy` also accepts deterministic in-process profile rules keyed by `clientType`, `backendId`, and `model`. This allows callers embedding `dify-core` to use different configured thresholds for a known route without machine learning or online adaptation.

Compression invariants are intentionally conservative: system/developer instructions are retained, the current human request and recent turns are retained, unfinished or trailing tool-call/result chains stay intact, and light/heavy summaries preferentially preserve file paths, task-state markers, errors, and code symbols. A generated historical summary is an assistant message rather than a system/developer message, so compressed user content is never promoted to privileged instructions.

`CompressionResult` records only metadata: mode, token estimates before/after, saved-token estimate, preserved recent-turn count, and category/reason codes. Structured telemetry does not store the removed prompt text, tool-result text, API key, raw session id, or image bytes.

## Lifecycle

- `BOOTSTRAP`: no downstream cursor exists; full canonical DSH history is sent with an empty Dify `conversation_id`.
- `CONTINUE`: the same DSH session/provider/app reuses its saved Dify `conversation_id` and sends only the gap since the last response produced by this provider/app.
- `TOOL_CONTINUE`: DSH tool results retain the original `ToolCallId` and are forwarded on the same Dify conversation.
- `RECOVER`: an invalid downstream conversation cursor is invalidated and rebuilt once from DSH history.
- `RESET`: exposed by the adapter's `resetSession(sessionId, appId)` lifecycle seam; a future DSH command/UI can bind to it without changing the state store.

Provider switching does not delete mappings, so returning to the same Dify app resumes its previous downstream cursor.

## Images

The provider advertises `text` and `image` input modalities. Image blocks on the current message are normalized by `@zinianly-aide/dify-core` and mapped to Dify's `files` protocol:

- HTTP/HTTPS image sources become `{ type: "image", transfer_method: "remote_url", url: "..." }`.
- Base64 image sources are uploaded once for that request to `POST /files/upload` using the same hashed Dify `user`; the returned id is sent as `{ type: "image", transfer_method: "local_file", upload_file_id: "..." }`.
- Native DSH durable `ImageBlock` values (`block.attachment`) are read through DSH's `attachments.readImage()` service, then uploaded to Dify. The provider never derives a local filesystem path from `attachmentId`.
- Images nested inside a `tool-result` (for example a `read_image` result) are detected recursively and attached to that `TOOL_CONTINUE` request once.
- An image from a previous user message is not reattached on later tool-result or replay requests unless that current message itself contains a new image.

The bridge also accepts compatibility image-source shapes (`source.url`, `source.data`/`source.base64` plus `mediaType`/`mimeType`) and does not put image bytes, raw URLs, API keys, or raw session ids into decision telemetry.

Text, images, tools, tool-result continuation, Dify SSE, usage, cancellation signal propagation, timeout, invalid-conversation recovery, and deterministic context-aware compression are implemented.
