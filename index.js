// dsh-plugin-voice-input —— Host 半。
//
// 职责：把「语音转写」发布为一个 Typert Remote 服务（服务键 voiceInput），
// 浏览器的输入框经 harness 的 /api RPC 调用 transcribe()。服务端按配置的
// 优先级依次尝试已启用的 STT provider（内置：阿里云百炼 / 小米 MiMo /
// 通用 OpenAI 兼容），失败自动切换下一个，成功返回转写文本。
//
// API Key 只在 Host 进程内使用（插件配置 apiKey，或 apiKeyEnv 指向的
// 环境变量 / DSH 凭据 seam），绝不下发到浏览器。
//
// 设计：provider 以「适配器类型」区分（type 字段）。内置三种：
//   - "aliyun-bailian"      阿里云百炼 Qwen-Audio-3.0-ASR-Flash 同步接口
//   - "xiaomi-mimo"         小米 MiMo-V2.5-ASR（OpenAI 兼容 chat/completions）
//   - "openai-compatible"   任意 OpenAI 兼容的「input_audio」ASR 端点
// 社区可零代码接入任何同类服务：配置 baseUrl/model/apiKey 即可。

import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

/** 单次 provider 请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30000;
/** 阿里云百炼同步接口的 base64 输入上限（编码后 10MB）。 */
const ALIYUN_BASE64_LIMIT_BYTES = 10 * 1024 * 1024;

// ---------- 配置 ----------

export const ProviderConfig = z.object({
  /** 唯一标识，如 "aliyun-bailian"。错误信息里会展示给用户。 */
  id: z.string().required(),
  /** 适配器类型：aliyun-bailian | xiaomi-mimo | openai-compatible。 */
  type: z.string().required(),
  /** false 时跳过该 provider。 */
  enabled: z.boolean().default(true),
  /** 数字越小越先尝试。 */
  priority: z.number().default(100),
  /** 直接配置 API Key（优先）。留空则走 apiKeyEnv / 派生环境变量。 */
  apiKey: z.string().default(""),
  /** 环境变量名或 DSH 凭据 seam 名；留空则派生自 id（如 ALIYUN_BAILIAN_API_KEY）。 */
  apiKeyEnv: z.string().default(""),
  /** 完整请求地址（含路径）。留空使用内置默认。 */
  baseUrl: z.string().default(""),
  /** 模型名；留空使用内置默认。 */
  model: z.string().default(""),
  /** 语种提示（可选，如 "zh"）。 */
  language: z.string().default(""),
  /** 额外请求头（键值对象），按需透传给 provider。 */
  extraHeaders: z.dict(z.string()).default({}),
});

export const Config = z.object({
  /** 优先使用指定 id 的 provider（忽略其 priority）；空 = 按 priority 排序。 */
  defaultProvider: z.string().default(""),
  /** 单次 provider 请求超时。 */
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  /** 录音中实时转写的增量间隔（毫秒）；0 = 关闭实时显示。 */
  liveIntervalMs: z.number().default(2500),
  /**
   * 文案整理模式：off（不整理）| local（本地规则）| llm（调用 polishLlm）。
   * 客户端始终请求 polish，服务端按此配置决定实际做法。
   */
  polishMode: z.string().default("local"),
  /** 可选的 LLM 整理配置（polishMode=llm 时启用；OpenAI 兼容端点）。 */
  polishLlm: z
    .object({
      baseUrl: z.string().default(""),
      model: z.string().default(""),
      apiKey: z.string().default(""),
      apiKeyEnv: z.string().default(""),
      systemPrompt: z.string().default(""),
    })
    .default({}),
  /** provider 列表：默认阿里云百炼优先、小米 MiMo 备用。 */
  providers: z
    .array(ProviderConfig)
    .default([
      {
        id: "aliyun-bailian",
        type: "aliyun-bailian",
        enabled: true,
        priority: 10,
        apiKey: "",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        model: "qwen3-asr-flash",
        language: "zh",
        extraHeaders: {},
      },
      {
        id: "xiaomi-mimo",
        type: "xiaomi-mimo",
        enabled: true,
        priority: 20,
        apiKey: "",
        apiKeyEnv: "MIMO_API_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        model: "mimo-v2.5-asr",
        language: "zh",
        extraHeaders: {},
      },
    ]),
});

// ---------- 工具 ----------

/** 派生 API Key 环境变量名：id 转大写、连字符转下划线，追加 _API_KEY。 */
function derivedEnvName(provider) {
  return `${provider.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/**
 * 解析某 provider 的 API Key，按可信度从高到低：
 *   1. 插件配置 provider.apiKey
 *   2. DSH 凭据 seam / 环境变量（provider.apiKeyEnv，或派生名）
 * 找不到返回 undefined，由调用方跳过该 provider。
 */
async function resolveApiKey(ctx, provider) {
  if (provider.apiKey && provider.apiKey.length > 0) return provider.apiKey;
  const env = provider.apiKeyEnv || derivedEnvName(provider);
  try {
    const cred = await ctx.credentials.resolve(credentialRef(env));
    if (cred && typeof cred.value === "string" && cred.value.length > 0) {
      return cred.value;
    }
  } catch {
    /* 凭据 seam 不可用则继续走回退 */
  }
  if (typeof process !== "undefined" && process.env && process.env[env]) {
    return process.env[env];
  }
  return undefined;
}

/** 带 code 的转写错误，便于上层归类。 */
class TranscribeError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** 把 audio 归一化为 data URL 字符串。 */
function toDataUrl(audio, mime) {
  if (typeof audio !== "string" || audio.length === 0) {
    throw new TranscribeError("bad-audio", "audio payload is empty");
  }
  if (audio.startsWith("data:")) return audio;
  const mt = /^[a-z0-9]+\/[a-z0-9.+-]+$/i.test(mime || "") ? mime : "audio/wav";
  return `data:${mt};base64,${audio}`;
}

/** 带超时与错误归类的 fetch 封装。 */
async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    throw new TranscribeError("network", `network request failed: ${String(cause && cause.message || cause)}`, cause);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 尽量带上供应商返回的错误正文，便于诊断（截断，避免刷屏）。
    let detail = "";
    try {
      const text = await res.text();
      if (text && text.length > 0) detail = ` — ${text.slice(0, 300).replace(/\s+/g, " ")}`;
    } catch {
      /* 读不到正文也不影响错误归类 */
    }
    if (res.status === 401 || res.status === 403) {
      throw new TranscribeError("unauthorized", `provider rejected the API key (HTTP ${res.status})${detail}`);
    }
    throw new TranscribeError(`http-${res.status}`, `provider returned HTTP ${res.status}${detail}`);
  }
  let body;
  try {
    body = await res.json();
  } catch (cause) {
    throw new TranscribeError("bad-json", "provider response was not valid JSON", cause);
  }
  return body;
}

// ---------- 适配器 ----------

/**
 * 阿里云百炼语音识别适配器，兼容两种端点：
 *  1. OpenAI 兼容模式（baseUrl 含 compatible-mode / chat/completions）——
 *     默认走这里：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，
 *     模型如 `qwen3-asr-flash`（公共域名可用，无需业务空间），响应为标准
 *     chat.completion（choices[0].message.content）。
 *  2. multimodal-generation 端点（业务空间专属域名，模型如
 *     `qwen-audio-3.0-asr-flash`）：`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/
 *     api/v1/services/aigc/multimodal-generation/generation`；响应结构特殊，
 *     识别文本在 output.text（或 output.output.sentence.text）。
 * 两种端点输入均支持 base64 Data URL（编码后 ≤10MB），且都要求 input_audio 显式
 * 携带 format（缺省会报 UNSUPPORTED_FORMAT: format is empty）。
 */
async function transcribeAliyunBailian(provider, request, apiKey, timeoutMs) {
  const baseUrl =
    provider.baseUrl ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
  const model = provider.model || "qwen3-asr-flash";
  const dataUrl = toDataUrl(request.audio, request.mime);
  if (dataUrl.length > ALIYUN_BASE64_LIMIT_BYTES) {
    throw new TranscribeError(
      "audio-too-large",
      `audio exceeds the ${Math.floor(ALIYUN_BASE64_LIMIT_BYTES / 1024 / 1024)}MB base64 limit for this provider`,
    );
  }
  const asrOptions = { enable_itn: false };
  const language = request.language || provider.language;
  if (language) asrOptions.language = language;
  const format = (request.format || "").toLowerCase() || guessFormat(request.mime);

  const isChatCompletions = /chat\/completions|compatible-mode/.test(baseUrl);
  const body = isChatCompletions
    ? await fetchJson(
        baseUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...provider.extraHeaders,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [{ type: "input_audio", input_audio: { data: dataUrl, format } }],
              },
            ],
            asr_options: asrOptions,
          }),
        },
        timeoutMs,
      )
    : await fetchJson(
        baseUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...provider.extraHeaders,
          },
          body: JSON.stringify({
            model,
            input: {
              messages: [
                {
                  role: "user",
                  content: [{ type: "input_audio", input_audio: { data: dataUrl, format } }],
                },
              ],
            },
            parameters: { asr_options: asrOptions },
          }),
        },
        timeoutMs,
      );

  // 兼容三种响应形态：chat.completion 的 choices[0].message.content、
  // multimodal-generation 的顶层 output.text、output.output.sentence.text。
  const text =
    (body &&
      body.choices &&
      Array.isArray(body.choices) &&
      body.choices[0] &&
      body.choices[0].message &&
      typeof body.choices[0].message.content === "string" &&
      body.choices[0].message.content) ||
    (body && body.output && typeof body.output.text === "string" && body.output.text) ||
    (body && body.output && body.output.output && body.output.output.sentence &&
      typeof body.output.output.sentence.text === "string" &&
      body.output.output.sentence.text) ||
    "";
  return text;
}

/**
 * OpenAI 兼容的「input_audio」ASR 端点（chat/completions）。
 * 小米 MiMo-V2.5-ASR 与任意同类服务共用此实现，区别只是默认 baseUrl/model。
 * 小米官方文档同时支持 `Authorization: Bearer` 与 `api-key` 两种请求头，
 * 实际线上偶有只认其中一种的情况，因此 xiaomi-mimo 类型两种都带上。
 *
 * 小米 MiMo 有两种独立套餐，端点与 Key 互不通用：
 *   - 按量付费（sk- 开头）: https://api.xiaomimimo.com/v1/chat/completions
 *   - Token Plan（tp- 开头）: https://token-plan-cn.xiaomimimo.com/v1/chat/completions
 * 若配置未显式指定 baseUrl（或仍为按量付费默认值）而 Key 以 tp- 开头，
 * 自动切换到 Token Plan 端点，避免 401 Invalid API Key。
 */
async function transcribeOpenAiCompatible(provider, request, apiKey, timeoutMs) {
  const PAYG_BASE = "https://api.xiaomimimo.com/v1/chat/completions";
  const TOKENPLAN_BASE = "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";
  let baseUrl = provider.baseUrl || PAYG_BASE;
  if (
    provider.type === "xiaomi-mimo" &&
    typeof apiKey === "string" &&
    apiKey.startsWith("tp-") &&
    !baseUrl.includes("token-plan")
  ) {
    baseUrl = TOKENPLAN_BASE;
  }
  const model = provider.model || "mimo-v2.5-asr";
  const dataUrl = toDataUrl(request.audio, request.mime);
  const format = (request.format || "").toLowerCase() || guessFormat(request.mime);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...provider.extraHeaders,
  };
  if (provider.type === "xiaomi-mimo") {
    headers["api-key"] = apiKey;
  }

  const body = await fetchJson(
    baseUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: dataUrl, format } }],
          },
        ],
      }),
    },
    timeoutMs,
  );

  const content =
    body &&
    body.choices &&
    Array.isArray(body.choices) &&
    body.choices[0] &&
    body.choices[0].message &&
    typeof body.choices[0].message.content === "string"
      ? body.choices[0].message.content
      : "";
  return content;
}

function guessFormat(mime) {
  if (!mime) return "wav";
  if (mime.includes("mp3") || mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav") || mime.includes("wave")) return "wav";
  return "wav";
}

/**
 * OpenAI Whisper 形态的 ASR 端点（multipart/form-data 文件上传）：
 *   POST <baseUrl>  file=<audio> + model=<model> [+ language]
 *   → 响应 { "text": "..." }
 * 覆盖 OpenAI Whisper、Groq Whisper、SiliconFlow SenseVoice 等一众常见服务，
 * 它们只是 baseUrl / model / Key 不同，复制配置模板即可接入。
 */
async function transcribeOpenAiWhisper(provider, request, apiKey, timeoutMs) {
  const baseUrl =
    provider.baseUrl || "https://api.openai.com/v1/audio/transcriptions";
  const model = provider.model || "whisper-1";
  const dataUrl = toDataUrl(request.audio, request.mime);
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw new TranscribeError("bad-audio", "audio payload is empty");

  const format = (request.format || "").toLowerCase() || guessFormat(request.mime);
  const mime = /^[a-z0-9]+\/[a-z0-9.+-]+$/i.test(request.mime || "") ? request.mime : format === "mp3" ? "audio/mpeg" : "audio/wav";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), `audio.${format}`);
  form.append("model", model);
  const language = request.language || provider.language;
  if (language) form.append("language", language);

  // 注意：FormData 自带 multipart boundary，绝不能手动设置 Content-Type。
  const body = await fetchJson(
    baseUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...provider.extraHeaders,
      },
      body: form,
    },
    timeoutMs,
  );

  return body && typeof body.text === "string" ? body.text : "";
}

/** 适配器注册表：type -> 实现。未知类型回退到 openai-compatible。 */
const ADAPTERS = {
  "aliyun-bailian": transcribeAliyunBailian,
  "xiaomi-mimo": transcribeOpenAiCompatible,
  "openai-compatible": transcribeOpenAiCompatible,
  "openai-whisper": transcribeOpenAiWhisper,
};

// ---------- 文案整理 ----------

/** 默认 LLM 整理提示词（中文）。 */
const DEFAULT_POLISH_PROMPT =
  "你是语音转写文本整理助手。把用户提供的口语化转写整理成书面语，要求：" +
  "1) 补充正确的标点；2) 删除语气词、口头禅和重复；3) 理顺语序，保持原意，不增删事实信息；" +
  "4) 若内容像任务指令，整理成清晰、直接的要求。只输出整理后的文本，不要任何解释、前缀或引号。";

/**
 * 本地规则整理（轻量、离线、免费）：
 *   - 去除语气词/口头禅（嗯、呃、额、就是说、怎么说呢等）
 *   - 口吃叠字归并（"我我我" → "我"）
 *   - 连续重复词归并（"然后然后" → "然后"）
 *   - 中英空格与换行规范
 *   - 补结尾标点
 * 刻意保持保守：只做确定安全的修改，把质量提升交给可选的 LLM 整理。
 */
function localPolish(text) {
  let out = String(text || "");
  // 口吃叠字归并（连续 3 个及以上相同字符 → 保留 1 个）
  out = out.replace(/(.)\1{2,}/g, "$1");
  // 语气词/口头禅
  out = out
    .replace(/[呃额嗯]{1,3}/g, "")
    .replace(/就是说/g, "")
    .replace(/怎么说呢/g, "")
    .replace(/你知道吧/g, "")
    .replace(/你懂的/g, "")
    .replace(/(那个){2,}/g, "")
    .replace(/(然后){2,}/g, "$1")
    .replace(/(就是){2,}/g, "$1")
    .replace(/^(那个|然后)/, "")
    .replace(/em{2,}/gi, "嗯");
  // 标点后的孤立语气词残留（"嗯，" 已被上一条删除，这里清理空段）
  out = out.replace(/[，、；：]\s*[，、；：]/g, "，").replace(/^[，。；、]+/, "");
  // 空格/换行规范
  out = out.replace(/[ \t]{2,}/g, " ").replace(/[ ]*\n[ ]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  // 中文字符之间不应有空格
  out = out.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2");
  // 补结尾标点（整段以句末标点收尾更利于大模型理解）
  if (out.length > 0 && !/[。！？!?…；;]$/.test(out)) {
    out += /[a-zA-Z0-9]$/.test(out) ? "." : "。";
  }
  return out;
}

/** 可选的 LLM 整理（OpenAI 兼容 chat/completions）。 */
async function polishWithLlm(config, text, apiKey, timeoutMs) {
  const baseUrl = config.baseUrl || "https://api.deepseek.com/v1/chat/completions";
  const model = config.model || "deepseek-chat";
  const systemPrompt = config.systemPrompt || DEFAULT_POLISH_PROMPT;
  const body = await fetchJson(
    baseUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        temperature: 0.2,
      }),
    },
    timeoutMs,
  );
  const content =
    body &&
    body.choices &&
    Array.isArray(body.choices) &&
    body.choices[0] &&
    body.choices[0].message &&
    typeof body.choices[0].message.content === "string"
      ? body.choices[0].message.content.trim()
      : "";
  if (!content) throw new TranscribeError("empty-transcript", "polish LLM returned no text");
  return content;
}

// ---------- 服务 ----------

export class VoiceInputGateway extends TypertRemoteService {
  static inject = ["credentials"];
  static Config = Config;

  constructor(ctx, config) {
    super(ctx, "voiceInput");
    this.config = config ?? {};
  }

  /**
   * 转写一段录音。
   * @param request - { audio, mime?, format?, language? }；audio 为 base64 或 data URL。
   * @returns { ok, text, provider, error }
   */
  async transcribe(request) {
    const config = this.config;
    const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const configured = Array.isArray(config.providers) ? config.providers : [];

    let providers = configured.filter((p) => p.enabled !== false);
    if (providers.length === 0) {
      return {
        ok: false,
        text: null,
        provider: null,
        error: {
          code: "no-providers",
          message: "voice-input: no enabled STT provider is configured",
          details: [],
        },
      };
    }
    if (config.defaultProvider) {
      const picked = providers.find((p) => p.id === config.defaultProvider);
      if (picked) providers = [picked, ...providers.filter((p) => p.id !== picked.id)];
    } else {
      providers = [...providers].sort((a, b) => (a.priority || 100) - (b.priority || 100));
    }

    const failures = [];
    for (const provider of providers) {
      try {
        const apiKey = await resolveApiKey(this.ctx, provider);
        if (!apiKey) {
          failures.push({ id: provider.id, code: "no-api-key", message: "no API key configured" });
          continue;
        }
        const adapter = ADAPTERS[provider.type] || transcribeOpenAiCompatible;
        const text = await adapter(provider, request || {}, apiKey, timeoutMs);
        if (!text || text.trim().length === 0) {
          failures.push({ id: provider.id, code: "empty-transcript", message: "provider returned no text" });
          continue;
        }
        return {
          ok: true,
          text: text.trim(),
          provider: { id: provider.id, type: provider.type, model: provider.model || "" },
          error: null,
        };
      } catch (err) {
        failures.push({
          id: provider.id,
          code: err && err.code ? err.code : "error",
          message: String((err && err.message) || err),
        });
      }
    }

    return {
      ok: false,
      text: null,
      provider: null,
      error: {
        code: "all-providers-failed",
        message: "voice-input: every configured STT provider failed",
        details: failures,
      },
    };
  }

  /**
   * 向客户端暴露插件运行参数（实时增量间隔、整理模式等），
   * 客户端据此调度录音中的增量转写。
   * @returns { ok, liveIntervalMs, polishMode }
   */
  async describe() {
    const config = this.config;
    return {
      ok: true,
      liveIntervalMs: typeof config.liveIntervalMs === "number" ? config.liveIntervalMs : 2500,
      polishMode: config.polishMode || "local",
    };
  }

  /**
   * 文案整理：把一段口语转写整理为便于大模型理解的书面语。
   * @param request - { text, mode? }；mode 缺省时按配置（polishMode）执行。
   * @returns { ok, text, method, error }；method ∈ none|local|llm
   */
  async polish(request) {
    const text = request && typeof request.text === "string" ? request.text : "";
    const config = this.config;
    const mode = (request && request.mode) || config.polishMode || "local";
    const error = (code, message) => ({ ok: false, text, method: "none", error: { code, message, details: [] } });

    if (!text.trim()) return error("empty-text", "nothing to polish");
    if (mode === "off") return { ok: true, text, method: "none", error: null };

    if (mode === "local") {
      return { ok: true, text: localPolish(text), method: "local", error: null };
    }

    if (mode === "llm") {
      const llm = config.polishLlm || {};
      try {
        const apiKey = await resolveApiKey(this.ctx, {
          apiKey: llm.apiKey || "",
          apiKeyEnv: llm.apiKeyEnv || "POLISH_LLM_API_KEY",
        });
        if (!apiKey) return error("no-api-key", "polish LLM has no API key configured");
        const polished = await polishWithLlm(llm, text, apiKey, config.timeoutMs || DEFAULT_TIMEOUT_MS);
        return { ok: true, text: polished, method: "llm", error: null };
      } catch (err) {
        return error(
          err && err.code ? err.code : "polish-llm-failed",
          String((err && err.message) || err),
        );
      }
    }

    return error("unknown-mode", `unknown polish mode: ${mode}`);
  }
}

export default VoiceInputGateway;
