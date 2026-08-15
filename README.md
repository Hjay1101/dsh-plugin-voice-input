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
- ⏱️ **Live captions**: while recording, incremental transcription runs every
  2.5 s (configurable `liveIntervalMs`) and streams into the composer draft;
  on stop, the full audio is transcribed once and replaces it as the final text.
- ✨ **Text polish**: the final transcript is cleaned up automatically (fillers,
  stutters, repeated phrases removed, terminal punctuation added); optional LLM
  polish (`polishMode: llm`) produces a fully rewritten, structured request.
- ✍️ The text is filled into the composer draft (your pre-existing draft is
  preserved), so you can review before sending.
- 🔀 Multiple providers with priority failover; plug in your own models via
  three adapter types: `openai-whisper` (OpenAI / Groq / SiliconFlow …),
  `openai-compatible` (`input_audio` chat/completions), and the two built-ins
  (Alibaba Bailian / Xiaomi MiMo). Ready-made config templates included.
- 🔑 API keys live only in the DSH server process (plugin config or
  environment / DSH credentials seam), never in the browser.
- 🌐 Chinese / English UI strings, themed with harness CSS variables.

## Install

Recommended: install from the GitHub repo (`github:Hjay1101/dsh-plugin-voice-input`):

```bash
cd ~/.dsh/profiles/web
pnpm add github:Hjay1101/dsh-plugin-voice-input
# local development alternative:
# pnpm add file:/path/to/dsh-plugin-voice-input
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
        liveIntervalMs: 2500      # live-caption incremental interval (ms); 0 disables
        polishMode: local         # off | local (default) | llm
        polishLlm: {}             # optional LLM polish config (required when polishMode=llm)
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

### Optional: LLM deep polish (`polishMode: llm`)

The local rules are free and offline; for higher quality (full punctuation,
reordering, structuring) plug in any OpenAI-compatible LLM (e.g. DeepSeek API):

```yaml
config:
  polishMode: llm
  polishLlm:
    baseUrl: https://api.deepseek.com/v1/chat/completions   # any OpenAI-compatible endpoint
    model: deepseek-chat
    apiKey: ''                    # inline key, or use apiKeyEnv
    apiKeyEnv: POLISH_LLM_API_KEY # env / credentials-seam name (default POLISH_LLM_API_KEY)
    systemPrompt: ''              # empty = built-in polishing prompt
```

One small LLM call per recording (tiny text, negligible cost); falls back to
the raw transcript if the call fails.

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

### Ready-made templates: common speech services (copy & paste)

Not using Alibaba / Xiaomi? The plugin supports three adapter types — add any of
these to the `providers` list (lower `priority` wins; `enabled: false` disables):

**A. `openai-whisper` type — OpenAI Whisper-style (multipart file upload)**

```yaml
- id: openai-whisper        # OpenAI official Whisper
  type: openai-whisper
  enabled: true
  priority: 5
  apiKeyEnv: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1/audio/transcriptions
  model: whisper-1
- id: groq-whisper          # Groq (generous free tier, fast)
  type: openai-whisper
  enabled: true
  priority: 10
  apiKeyEnv: GROQ_API_KEY
  baseUrl: https://api.groq.com/openai/v1/audio/transcriptions
  model: whisper-large-v3
- id: siliconflow-sensevoice  # SiliconFlow SenseVoice (strong Chinese)
  type: openai-whisper
  enabled: true
  priority: 15
  apiKeyEnv: SILICONFLOW_API_KEY
  baseUrl: https://api.siliconflow.cn/v1/audio/transcriptions
  model: FunAudioLLM/SenseVoiceSmall
```

**B. `openai-compatible` type — chat/completions with `input_audio`**

Any chat/completions ASR endpoint accepting an `input_audio` part (base64 data
URL + format); see "Generic adapter" above.

**C. `aliyun-bailian` / `xiaomi-mimo` types** — the two built-ins; you can point
their `baseUrl`/`model` at same-shaped endpoints (e.g. the Alibaba workspace URL).

> Tip: the defaults already include Alibaba + Xiaomi; to replace them, set their
> `enabled: false` and add your own services.

### Adding a custom adapter

Register an `async (provider, request, apiKey, timeoutMs) => text` function in
the `ADAPTERS` map in `index.js`. PRs for more providers are welcome.

## Usage

1. Click the 🎙️ button in the composer tool row to start recording (allow the
   browser microphone permission).
2. While recording, incremental transcription runs every 2.5 s and **streams
   into the composer draft** (live captions).
3. Click again (or the red square) to stop: the full audio is transcribed once,
   then polished (fillers removed / punctuation added, optional LLM rewrite),
   and fills the draft (your pre-existing draft is preserved).
4. Review, edit, and press Enter — your currently selected model executes it.

> Focus on speaking while recording (live text keeps appending); on stop, the
> final text replaces the part produced by this recording.

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
