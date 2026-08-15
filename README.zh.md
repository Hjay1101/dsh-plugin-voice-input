# dsh-plugin-voice-input

DeepSeek Harness 语音输入插件：在 Web 界面的聊天输入框加一个麦克风按钮，
录音后交给**可插拔的语音识别（STT）服务**转成文字并填入输入框，你确认后
发送——**执行仍然由你在 DSH 里选定的那个大模型完成**，语音识别只负责
「听写」，两者完全解耦。

内置两个 provider，按优先级故障转移：

| 优先级 | provider | 模型 | 接口 |
| --- | --- | --- | --- |
| 1（默认） | 阿里云百炼 | `qwen3-asr-flash` | DashScope OpenAI 兼容模式（公共域名，无需业务空间） |
| 2（备用） | 小米 MiMo | `mimo-v2.5-asr` | `api.xiaomimimo.com/v1/chat/completions`（OpenAI 兼容） |

第一个失败自动切换下一个；全部失败时返回每个 provider 的错误明细。

## 特性

- 🎙️ 输入框工具栏（发送按钮左侧）的麦克风按钮，点击录音 / 再点结束转写。
- ⏱️ **实时字幕**：录音中每 2.5 秒（可配置 `liveIntervalMs`）增量转写并实时写入
  输入框草稿；停止时用整段音频做一次准确转写替换为定稿。
- ✨ **文案整理**：定稿自动整理（去语气词、口吃叠字、重复口头禅，补结尾标点），
  更便于大模型理解；可选接入 LLM 深度润色（`polishMode: llm`）。
- ✍️ 识别文字填入输入框草稿（保留你录音前已写的内容），可修改后再发送。
- 🔀 多 provider + 优先级故障转移，配置化支持任意 OpenAI 兼容的 `input_audio`
  ASR 端点（零代码接入，见下文「通用适配器」）。
- 🔑 API Key 只在 DSH 服务器进程内使用（插件配置或环境变量 / DSH 凭据 seam），
  绝不下发浏览器。
- 🌐 中 / 英文界面文案，跟随 harness 主题变量。

## 安装

推荐从 GitHub 安装（开源仓库：`github:Hjay1101/dsh-plugin-voice-input`）：

```bash
# 1. 在 profile 目录加入依赖（任意一种方式）
cd ~/.dsh/profiles/web
pnpm add github:Hjay1101/dsh-plugin-voice-input
# 或本地开发：
# pnpm add file:/path/to/dsh-plugin-voice-input

# 2. 在 cordis.patch.yml 追加插件条目（见下）
# 3. 重启 dsh web 服务，刷新页面
```

`cordis.patch.yml`（保持你已有的 insert 列表，追加一项）：

```yaml
- insert:
    - id: voice-input
      name: 'dsh-plugin-voice-input'
```

> 不配置任何东西也能先跑起来：默认内置阿里云百炼（优先）与小米 MiMo（备用），
> 只需给服务器进程提供对应的环境变量（见下）。

## 配置

插件配置通过 profile 的 `cordis.patch.yml` 的 `config` 字段下发（服务器端，
浏览器不可见）：

```yaml
- insert:
    - id: voice-input
      name: 'dsh-plugin-voice-input'
      config:
        timeoutMs: 30000          # 单次 provider 请求超时（毫秒）
        liveIntervalMs: 2500      # 录音中实时字幕的增量转写间隔（毫秒）；0 = 关闭实时
        polishMode: local         # 文案整理：off（不整理）| local（本地规则，默认）| llm（LLM 润色）
        polishLlm: {}             # 可选 LLM 整理配置（polishMode=llm 时必填），见下
        defaultProvider: ''       # 空 = 按 priority 排序；可固定 'aliyun-bailian'
        providers:
          - id: aliyun-bailian
            type: aliyun-bailian
            enabled: true
            priority: 10
            apiKey: ''            # 直接填 Key（优先）；留空走 apiKeyEnv
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

### API Key 的三种提供方式（按优先级）

1. 插件配置里直接写 `providers[].apiKey`；
2. `providers[].apiKeyEnv` 指向的环境变量 / DSH 凭据 seam（如 `DASHSCOPE_API_KEY`、
   `MIMO_API_KEY`，也可写入 `~/.dsh/.credentials.yaml`）；
3. 都不填时派生自 provider id：`ALIYUN_BAILIAN_API_KEY` / `XIAOMI_MIMO_API_KEY`。

### 可选：LLM 深度整理（polishMode: llm）

本地规则整理免费离线、处理语气词和叠字；如需更高质量的润色（补全标点、理顺
语序、结构化），可接入任意 OpenAI 兼容 LLM（如 DeepSeek API）：

```yaml
config:
  polishMode: llm
  polishLlm:
    baseUrl: https://api.deepseek.com/v1/chat/completions   # 任意 OpenAI 兼容端点
    model: deepseek-chat
    apiKey: ''                    # 直接填 Key，或走 apiKeyEnv
    apiKeyEnv: POLISH_LLM_API_KEY # 环境变量 / 凭据 seam 名（缺省派生 POLISH_LLM_API_KEY）
    systemPrompt: ''              # 留空用内置整理提示词
```

每次录音结束会调用一次整理模型（文本很小，成本极低）；调用失败自动回退原文。


### 通用适配器：接入任意 OpenAI 兼容 ASR

`type: openai-compatible` 可零代码接入任何支持
`input_audio`（base64 data URL + format）的 chat/completions ASR 端点：

```yaml
- id: my-asr
  type: openai-compatible
  enabled: true
  priority: 30
  apiKeyEnv: MY_ASR_API_KEY
  baseUrl: https://example.com/v1/chat/completions
  model: my-asr-model
```

（小米 MiMo 就是 `openai-compatible` 的预置实例，只是默认值不同。）

### 新增自有适配器

在 `index.js` 的 `ADAPTERS` 注册表加一个 `async (provider, request, apiKey, timeoutMs) => text`
函数即可；欢迎 PR 贡献更多 provider。

## 使用

1. 点击输入框工具栏的 🎙️ 按钮开始录音（需允许浏览器麦克风权限）。
2. 录音中：每 2.5 秒自动增量转写，**文字实时显示在输入框**（字幕效果）。
3. 再点一次（或点红色方块）结束录音：整段音频做一次准确转写 → 自动整理文案
   （去语气词 / 补标点，可选 LLM 润色）→ 填入输入框（保留你录音前已写的内容）。
4. 修改确认后按回车发送——由你当前选中的模型执行。

> 录音中请专注说话（实时文字会持续追加）；停止后定稿会替换本次语音产生的部分。

## 已知限制

- 浏览器录音为 16kHz 单声道 WAV；阿里云百炼与小米 MiMo 的 base64 输入上限均为
  编码后 10MB（约 5 分钟录音，远超语音输入场景）。
- 默认使用阿里云 OpenAI 兼容模式（`dashscope.aliyuncs.com/compatible-mode` + `qwen3-asr-flash`），
  公共域名即可调用。如需换用 `qwen-audio-3.0-asr-flash`，必须把 `baseUrl` 换成
  业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
  （WorkspaceId 在百炼控制台查看），公共域名不支持该模型。
- 阿里云百炼需要**北京或新加坡地域的 API Key**（与 baseUrl 地域一致），
  模型名带 `-us` 后缀的是美国地域。
- 新增插件 / 修改 `cordis.patch.yml` 配置后需**重启 dsh web 服务**生效。
- 客户端 bundle 改动在 `pnpm run dev:web` 监听下可免刷新热更新；否则需
  重启服务并刷新页面。

## 故障排查

- **按钮提示「语音服务 API Key 无效（401）」**：先确认对应 provider 的 Key 值本身有效，
  且**端点与 Key 类型匹配**。小米 MiMo 的 Key 有两种、端点互不通用：
  - 按量付费 `sk-` Key → `https://api.xiaomimimo.com/v1/chat/completions`
  - Token Plan `tp-` Key → `https://token-plan-cn.xiaomimimo.com/v1/chat/completions`
  - 插件对 `tp-` Key 会自动切换 Token Plan 端点（默认端点被显式配置覆盖时除外）。
  其余情况（无鉴权头 / Bearer / api-key 都返回相同的 `Invalid API Key`）则基本等于
  Key 无效或过期，而非请求头格式问题（插件对 MiMo 会同时发送两种鉴权头，双保险）。
- **提示「未配置 API Key」**：`providers[].apiKey` 为空且 `apiKeyEnv` 指向的环境变量 /
  DSH 凭据 seam（`~/.dsh/.credentials.yaml`）都不存在。按上文三种方式任选其一配置。
- **所有服务都失败**：按钮会展示每个 provider 的具体错误（含供应商返回的正文片段），
  据此定位是网络、鉴权还是格式问题。
- **无法访问麦克风**：浏览器需在 localhost（127.0.0.1）上打开页面并允许麦克风权限；
  非本地地址不在安全上下文内，`getUserMedia` 不可用。

## License

MIT
