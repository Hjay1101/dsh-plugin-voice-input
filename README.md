# dsh-plugin-voice-input

A voice input plugin for DeepSeek Harness: a microphone button in the chat
composer transcribes your speech through **pluggable STT providers** and fills
the input draft for you to review — **the model you selected in DSH still
executes the request**. Speech recognition is only the "dictation" layer and
stays fully decoupled from the main model.

Two built-in providers with priority failover:

| Priority | Provider | Model | API |
| --- | --- | --- | --- |
| 1 (default) | Alibaba Cloud Bailian | `qwen3-asr-flash` | DashScope OpenAI-compatible mode (public domain, no workspace needed) |
| 2 (fallback) | Xiaomi MiMo | `mimo-v2.5-asr` | `api.xiaomimimo.com/v1/chat/completions` (OpenAI-compatible) |

If the first provider fails, the next one is tried automatically; when all
fail, per-provider error details are returned.

## Features

- 🎙️ Mic button in the composer tool row (left of the send button); click to
  record, click again to stop and transcribe.
- ✍️ The transcribed text is **filled into the composer draft** (appended on a
  new line when a draft already exists), so you can review before sending.
- 🔀 Multiple providers with priority failover; any OpenAI-compatible
  `input_audio` ASR endpoint can be added **without code** (see below).
- 🔑 API keys live only in the DSH server process (plugin config or
  environment / DSH credentials seam), never in the browser.
- 🌐 Chinese / English UI strings, themed with harness CSS variables.

## Install

Add the plugin as a `file:` dependency of your DSH profile (example: `web`):

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-plugin-voice-input
```

Then append to `cordis.patch.yml` (keep your existing insert list):

```yaml
- insert:
    - id: voice-input
      name: 'dsh-plugin-voice-input'
```

Restart the `dsh web` server and refresh the page.

> It runs out of the box with the built-in defaults: just provide the
> corresponding environment variables to the server process (see below).

## Configuration

Plugin config is delivered via the profile's `cordis.patch.yml` `config` field
(server-side, invisible to the browser):

```yaml
- insert:
    - id: voice-input
      name: 'dsh-plugin-voice-input'
      config:
        timeoutMs: 30000
        defaultProvider: ''
        providers:
          - id: aliyun-bailian
            type: aliyun-bailian
            enabled: true
            priority: 10
            apiKey: ''
            apiKeyEnv: DASHSCOPE_API_KEY
            model: qwen3-asr-flash
            baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
            language: zh
          - id: xiaomi-mimo
            type: xiaomi-mimo
            enabled: true
            priority: 20
            apiKey: ''
            apiKeyEnv: MIMO_API_KEY
            model: mimo-v2.5-asr
            baseUrl: https://api.xiaomimimo.com/v1/chat/completions
            language: zh
```

### API key resolution (in priority order)

1. `providers[].apiKey` in the plugin config;
2. the environment variable / DSH credentials seam named by
   `providers[].apiKeyEnv` (e.g. `DASHSCOPE_API_KEY`, `MIMO_API_KEY`; can also
   be stored in `~/.dsh/.credentials.yaml`);
3. otherwise derived from the provider id: `ALIYUN_BAILIAN_API_KEY` /
   `XIAOMI_MIMO_API_KEY`.

### Generic adapter: any OpenAI-compatible ASR

`type: openai-compatible` wires any chat/completions endpoint that accepts an
`input_audio` part (base64 data URL + format) with zero code:

```yaml
- id: my-asr
  type: openai-compatible
  enabled: true
  priority: 30
  apiKeyEnv: MY_ASR_API_KEY
  baseUrl: https://example.com/v1/chat/completions
  model: my-asr-model
```

(Xiaomi MiMo is just a pre-configured `openai-compatible` instance.)

### Adding a custom adapter

Register an `async (provider, request, apiKey, timeoutMs) => text` function in
the `ADAPTERS` map in `index.js`. PRs for more providers are welcome.

## Usage

1. Click the 🎙️ button in the composer tool row to start recording (allow the
   browser microphone permission).
2. Click again (or the red square) to stop; the status shows "Transcribing…".
3. The text is filled into the composer draft (appended on a new line when a
   draft exists); review, edit, and press Enter — your currently selected
   model executes it.

## Known limitations

- Browser recording is encoded as 16 kHz mono WAV; both Alibaba Bailian and
  Xiaomi MiMo cap the base64 input at 10 MB encoded (~5 minutes of audio — far
  beyond a voice-input use case).
- The default uses Alibaba's OpenAI-compatible mode
  (`dashscope.aliyuncs.com/compatible-mode` + `qwen3-asr-flash`) on the public
  domain. To use `qwen-audio-3.0-asr-flash` instead, `baseUrl` must point at the
  workspace-specific domain
  `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
  (WorkspaceId is shown in the Bailian console); the public domain does not
  serve that model.
- Alibaba Bailian requires a Beijing or Singapore API key matching the region
  of `baseUrl` (US-region models carry a `-us` suffix).
- Adding the plugin or changing `cordis.patch.yml` requires a **server
  restart** of `dsh web`.
- Client bundle changes hot-reload without a refresh only while the
  `pnpm run dev:web` watcher is running; otherwise restart the server and
  refresh the page.

## Troubleshooting

- **Button reports "API key is invalid (401)"**: verify the provider's key value
  and that the **endpoint matches the key type**. Xiaomi MiMo has two
  independent key types with non-interchangeable endpoints:
  - Pay-as-you-go `sk-` keys → `https://api.xiaomimimo.com/v1/chat/completions`
  - Token Plan `tp-` keys → `https://token-plan-cn.xiaomimimo.com/v1/chat/completions`
  - The plugin auto-switches to the Token Plan endpoint for `tp-` keys (unless
    an explicit `baseUrl` is configured).
  Otherwise MiMo returns the same `Invalid API Key` for missing auth, Bearer,
  and `api-key` header alike, so a 401 almost always means the key is invalid
  or expired — not a header-format problem (the plugin sends both auth headers
  for MiMo anyway).
- **"No API key configured"**: `providers[].apiKey` is empty and neither the
  `apiKeyEnv` environment variable nor the DSH credentials seam
  (`~/.dsh/.credentials.yaml`) has the key. Configure one of the three ways
  described above.
- **All providers failed**: the button shows each provider's specific error
  (including a snippet of the provider's response body) to pinpoint network,
  auth, or format issues.
- **Microphone unavailable**: the page must be served from localhost
  (127.0.0.1) and microphone permission granted; non-local origins are not
  secure contexts and `getUserMedia` is unavailable.

## License

MIT
