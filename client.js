// dsh-plugin-voice-input —— 客户端半（浏览器 bundle）。
//
// 以 lazy-CJS 格式交给客户端模块加载器：这里只注册工厂函数，真正执行
// 发生在物化（materialize）时。做的事有三件：
//   1. 挂载 voiceInput Typert Remote（拿到调用 Host 的通道）
//   2. 在输入框工具栏（conversation.input.right，发送按钮左侧）注册麦克风按钮
//   3. 录音（ScriptProcessor → 16kHz 单声道 WAV）→ 交给 Host 转写 →
//      识别文字填入输入框草稿（确认后可修改再发送）
//
// 注意：结果编解码器是透传——业务结果在 Host 侧已用 zod 校验过，这里
// 只需要描述符的严格形态来挂载和调用，不再重复校验。
// 语音识别只负责「听写」，发送后由用户选定的主模型执行。

window.__ModuleLoader__.load({
  id: "dsh-plugin-voice-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const NS = "voiceInput";
    const inject = ["slots", "locale", "remote"];

    // ---------- 文案（中 / 英） ----------
    const zh = {
      label: "语音输入",
      startHint: "点击开始录音",
      stopHint: "点击结束并转写",
      recording: "录音中",
      transcribing: "识别中…",
      micDenied: "无法访问麦克风，请检查浏览器权限。",
      recordFailed: "录音启动失败，请重试。",
      emptyAudio: "没有录到声音，请重试。",
      done: "已通过 {provider} 识别，请确认后发送。",
      doneNoProvider: "识别完成，请确认后发送。",
      noApiKey: "语音服务未配置 API Key（请检查插件配置或环境变量）。",
      unauthorized: "语音服务 API Key 无效（401）。",
      network: "语音服务网络请求失败。",
      allFailed: "所有语音服务都失败了：{first}",
      noProviders: "未配置可用的语音服务。",
      tooLarge: "录音超出语音服务的大小限制。",
      emptyTranscript: "语音服务没有识别出文字。",
      error: "语音识别失败：{msg}",
      unexpected: "识别服务返回了异常结果，请重试。",
      providerAliyun: "阿里云百炼",
      providerMimo: "小米 MiMo",
    };
    const en = {
      label: "Voice input",
      startHint: "Click to start recording",
      stopHint: "Click to stop and transcribe",
      recording: "Recording",
      transcribing: "Transcribing…",
      micDenied: "Microphone is not available; check the browser permission.",
      recordFailed: "Failed to start recording, try again.",
      emptyAudio: "No audio was captured, try again.",
      done: "Transcribed via {provider}. Review it and send.",
      doneNoProvider: "Transcribed. Review it and send.",
      noApiKey: "No API key configured for the voice provider (check plugin config or environment).",
      unauthorized: "Voice provider rejected the API key (401).",
      network: "Voice provider network request failed.",
      allFailed: "All voice providers failed: {first}",
      noProviders: "No voice provider is configured.",
      tooLarge: "The recording exceeds the voice provider size limit.",
      emptyTranscript: "The voice provider returned no text.",
      error: "Voice transcription failed: {msg}",
      unexpected: "The transcription service returned an unexpected result.",
      providerAliyun: "Alibaba Bailian",
      providerMimo: "Xiaomi MiMo",
    };

    // ---------- Remote 描述符 ----------
    const TYPERT_REMOTE = {
      package: "dsh-plugin-voice-input",
      descriptors: [
        {
          id: "dsh-plugin-voice-input#voiceInput/transcribe",
          service: "voiceInput",
          namespace: "voiceInput",
          method: "transcribe",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "request",
              wire: "request",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-plugin-voice-input#TranscribeRequest",
                schema: { parse(value) { return value; } },
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-plugin-voice-input#TranscribeResult",
            schema: { parse(value) { return value; } },
          },
        },
        {
          id: "dsh-plugin-voice-input#voiceInput/describe",
          service: "voiceInput",
          namespace: "voiceInput",
          method: "describe",
          invocation: { kind: "direct" },
          parameters: [],
          result: {
            mode: "strict",
            typeSymbol: "dsh-plugin-voice-input#DescribeResult",
            schema: { parse(value) { return value; } },
          },
        },
        {
          id: "dsh-plugin-voice-input#voiceInput/polish",
          service: "voiceInput",
          namespace: "voiceInput",
          method: "polish",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "request",
              wire: "request",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-plugin-voice-input#PolishRequest",
                schema: { parse(value) { return value; } },
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-plugin-voice-input#PolishResult",
            schema: { parse(value) { return value; } },
          },
        },
      ],
    };

    // ---------- 录音与 WAV 编码工具 ----------

    function concatFloat32(chunks) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
    }

    /** 线性插值重采样到 16kHz。 */
    function resample16k(input, fromRate) {
      if (fromRate === 16000 || input.length === 0) return input;
      const ratio = fromRate / 16000;
      const outLen = Math.max(1, Math.round(input.length / ratio));
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i += 1) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = pos - i0;
        out[i] = input[i0] * (1 - frac) + input[i1] * frac;
      }
      return out;
    }

    /** 16-bit PCM 单声道 WAV 编码。 */
    function encodeWav(samples, sampleRate) {
      const dataLen = samples.length * 2;
      const buffer = new ArrayBuffer(44 + dataLen);
      const view = new DataView(buffer);
      const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + dataLen, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); // byte rate
      view.setUint16(32, 2, true); // block align
      view.setUint16(34, 16, true); // bits per sample
      writeStr(36, "data");
      view.setUint32(40, dataLen, true);
      for (let i = 0; i < samples.length; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([view], { type: "audio/wav" });
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
    }

    // ---------- 样式（跟随 harness 主题变量） ----------
    const styles = {
      wrap: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 32,
        padding: "0 2px",
      },
      button: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        padding: 0,
        cursor: "pointer",
        flex: "none",
        font: "inherit",
        position: "relative",
      },
      // 录音中：红色提示环（内联 border 覆盖类样式里的 border:none）。
      buttonRecording: {
        border: "1px solid var(--dsw-alias-state-error-primary)",
        color: "var(--dsw-alias-state-error-primary)",
      },
      status: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        color: "var(--dsw-alias-label-secondary)",
        fontFamily: "Inter, var(--dsw-font-family)",
      },
      statusError: { color: "var(--dsw-alias-state-error-primary)" },
      statusInfo: { color: "var(--dsw-alias-label-secondary)" },
      dot: {
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--dsw-alias-state-error-primary)",
        animation: "dsh-voice-pulse 1s ease-in-out infinite",
        flex: "none",
      },
      spinner: {
        width: 12,
        height: 12,
        borderRadius: "50%",
        border: "2px solid var(--dsw-alias-border-l2)",
        borderTopColor: "var(--dsw-alias-state-business-primary)",
        animation: "dsh-voice-spin 0.8s linear infinite",
        flex: "none",
      },
    };

    // 注入全局关键帧 + 按钮样式（幂等）。
    if (typeof document !== "undefined") {
      const keyframesId = "dsh-plugin-voice-input-keyframes";
      if (!document.getElementById(keyframesId)) {
        const tag = document.createElement("style");
        tag.id = keyframesId;
        tag.textContent =
          "@keyframes dsh-voice-pulse{0%,100%{opacity:1}50%{opacity:.25}}" +
          "@keyframes dsh-voice-spin{to{transform:rotate(360deg)}}" +
          // 空闲态无边框，与输入框工具栏原生图标按钮融为一体；
          // hover 给轻微底色反馈，录音态由内联样式加红色提示环。
          ".dsh-voice-mic-btn{box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:8px}" +
          ".dsh-voice-mic-btn:hover{background:var(--dsw-alias-bg-layer-2)}" +
          ".dsh-voice-mic-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}" +
          ".dsh-voice-mic-btn:disabled{opacity:.55;cursor:default}";
        document.head.appendChild(tag);
      }
    }

    function MicIcon() {
      return React.createElement(
        "svg",
        {
          width: 16,
          height: 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        React.createElement("rect", { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
        React.createElement("path", { d: "M5 10v1a7 7 0 0 0 14 0v-1" }),
        React.createElement("line", { x1: 12, y1: 18, x2: 12, y2: 22 })
      );
    }

    function StopIcon() {
      return React.createElement(
        "svg",
        {
          width: 12,
          height: 12,
          viewBox: "0 0 24 24",
          fill: "currentColor",
          "aria-hidden": true,
        },
        React.createElement("rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 })
      );
    }

    // ---------- 错误/提示文案 ----------
    function providerLabel(provider, t) {
      if (!provider) return null;
      if (provider.id === "aliyun-bailian") return t("providerAliyun");
      if (provider.id === "xiaomi-mimo") return t("providerMimo");
      return provider.id;
    }

    function friendlyError(error, t) {
      if (!error) return t("unexpected");
      const code = error.code;
      if (code === "no-api-key") return t("noApiKey");
      if (code === "unauthorized") return t("unauthorized");
      if (code === "network") return t("network");
      if (code === "no-providers") return t("noProviders");
      if (code === "audio-too-large") return t("tooLarge");
      if (code === "empty-transcript") return t("emptyTranscript");
      if (code === "all-providers-failed") {
        const first = error.details && error.details[0];
        return t("allFailed").replace("{first}", first ? `${first.id}: ${first.message}` : "");
      }
      return t("error").replace("{msg}", error.message || code || "unknown");
    }

    // ---------- 麦克风按钮 ----------
    /** 增量分片最短时长（秒）：不足则等下一片。 */
    const MIN_SLICE_SECONDS = 0.4;
    /** describe 失败时的默认增量间隔（毫秒）。 */
    const DEFAULT_LIVE_INTERVAL = 2500;

    function VoiceMicButton(props) {
      const { transcribe, polish, describe, t, useInput, inputActions } = props;
      const draft = useInput((s) => (s ? s.draft : ""));
      const draftRef = React.useRef(draft);
      React.useEffect(() => { draftRef.current = draft; }, [draft]);

      const recRef = React.useRef(null);
      const [phase, setPhase] = React.useState("idle"); // idle | recording | busy
      const [elapsed, setElapsed] = React.useState(0);
      const [note, setNote] = React.useState(null); // { kind, text }
      const noteTimer = React.useRef(null);

      // 录音中的增量转写间隔（来自服务端 describe，可配置）。
      const [liveInterval, setLiveInterval] = React.useState(DEFAULT_LIVE_INTERVAL);
      const liveIntervalRef = React.useRef(DEFAULT_LIVE_INTERVAL);
      React.useEffect(() => { liveIntervalRef.current = liveInterval; }, [liveInterval]);

      // 挂载后拉取服务端运行参数（失败则用默认间隔）。
      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const env = await describe();
            const v = env && env.ok === true ? env.value : null;
            if (alive && v && typeof v.liveIntervalMs === "number" && v.liveIntervalMs > 0) {
              setLiveInterval(v.liveIntervalMs);
            }
          } catch { /* 使用默认间隔 */ }
        })();
        return () => { alive = false; };
      }, [describe]);

      const showNote = React.useCallback((kind, text) => {
        setNote({ kind, text });
        clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setNote(null), 8000);
      }, []);

      /** 把"基稿 + 实时累积"写回输入框草稿。 */
      const writeDraft = React.useCallback((rec, accumulated) => {
        const base = rec.baseDraft || "";
        inputActions.setDraft(base ? `${base}\n${accumulated}` : accumulated);
      }, [inputActions]);

      /** 增量转写：把自上次以来新录的音频片段转写并追加显示。 */
      const runChunk = React.useCallback(async (rec) => {
        if (!rec || rec.stopped || rec.chunkBusy) return;
        const all = concatFloat32(rec.chunks);
        if (all.length - rec.lastSlice < Math.floor(MIN_SLICE_SECONDS * rec.rate)) return;
        const slice = all.slice(rec.lastSlice);
        rec.lastSlice = all.length;
        rec.chunkBusy = true;
        try {
          const dataUrl = await blobToDataUrl(encodeWav(resample16k(slice, rec.rate), 16000));
          const env = await transcribe({
            audio: dataUrl,
            mime: "audio/wav",
            format: "wav",
            language: "zh",
          });
          const txt = env && env.ok === true && env.value && env.value.ok === true && env.value.text
            ? env.value.text
            : "";
          if (txt && !rec.stopped) {
            rec.accumulated += txt;
            writeDraft(rec, rec.accumulated);
          }
        } catch { /* 增量失败静默，不影响录音 */ } finally {
          rec.chunkBusy = false;
        }
      }, [transcribe, writeDraft]);

      // 组件卸载时兜底停止录音。
      React.useEffect(() => () => {
        clearTimeout(noteTimer.current);
        const rec = recRef.current;
        if (!rec) return;
        clearInterval(rec.timer);
        clearInterval(rec.chunkTimer);
        try { rec.source.disconnect(); rec.gain.disconnect(); rec.processor.disconnect(); } catch { /* noop */ }
        rec.stream.getTracks().forEach((tr) => tr.stop());
        try { rec.audioCtx.close(); } catch { /* noop */ }
        recRef.current = null;
      }, []);

      const begin = React.useCallback(async () => {
        if (phase !== "idle") return;
        setNote(null);
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          showNote("error", t("micDenied"));
          return;
        }
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          const audioCtx = new AudioCtx();
          const source = audioCtx.createMediaStreamSource(stream);
          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          const chunks = [];
          processor.onaudioprocess = (event) => {
            chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
          };
          const gain = audioCtx.createGain();
          gain.gain.value = 0; // 静音输出，避免回声
          source.connect(processor);
          processor.connect(gain);
          gain.connect(audioCtx.destination);
          const startedAt = Date.now();
          const rate = audioCtx.sampleRate || 48000;
          recRef.current = {
            stream, audioCtx, source, processor, gain, chunks,
            startedAt, timer: null, chunkTimer: null,
            baseDraft: draftRef.current || "",
            accumulated: "",
            lastSlice: 0,
            chunkBusy: false,
            stopped: false,
            rate,
          };
          setPhase("recording");
          setElapsed(0);
          const rec = recRef.current;
          rec.timer = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startedAt) / 1000));
          }, 500);
          // 增量转写定时器：间隔由服务端配置（describe），默认 2.5s。
          rec.chunkTimer = setInterval(() => {
            runChunk(recRef.current);
          }, Math.max(500, liveIntervalRef.current));
        } catch {
          stream.getTracks().forEach((tr) => tr.stop());
          showNote("error", t("recordFailed"));
        }
      }, [phase, showNote, t, runChunk]);

      const stop = React.useCallback(async () => {
        const rec = recRef.current;
        if (!rec || phase !== "recording") return;
        rec.stopped = true;
        recRef.current = null;
        clearInterval(rec.timer);
        clearInterval(rec.chunkTimer);
        try { rec.source.disconnect(); rec.gain.disconnect(); rec.processor.disconnect(); } catch { /* noop */ }
        rec.stream.getTracks().forEach((tr) => tr.stop());
        try { await rec.audioCtx.close(); } catch { /* noop */ }
        setPhase("busy");
        setNote(null);
        try {
          const samples = concatFloat32(rec.chunks);
          if (samples.length === 0) {
            showNote("error", t("emptyAudio"));
            setPhase("idle");
            return;
          }
          const resampled = resample16k(samples, rec.rate);
          const wav = encodeWav(resampled, 16000);
          const dataUrl = await blobToDataUrl(wav);
          // api.<method>() 返回 RPC 信封 {ok, value, error}（narrow form），
          // 业务结果在 value 上；transport 级失败信封 ok=false 且带 error。
          const envelope = await transcribe({
            audio: dataUrl,
            mime: "audio/wav",
            format: "wav",
            language: "zh",
          });

          let finalText = "";
          let providerInfo = null;
          let failure = null;
          if (envelope && envelope.ok === true && envelope.value) {
            const result = envelope.value;
            if (result.ok === true && result.text) {
              finalText = result.text;
              providerInfo = result.provider;
            } else {
              failure = friendlyError(result.error, t);
            }
          } else if (envelope && envelope.ok === false) {
            failure = friendlyError(envelope.error, t);
          } else {
            failure = t("unexpected");
          }

          if (finalText) {
            // 文案整理（服务端按配置执行 local/llm/off；失败则回退原文）。
            try {
              const penv = await polish({ text: finalText, mode: "auto" });
              if (penv && penv.ok === true && penv.value && penv.value.ok === true && penv.value.text) {
                finalText = penv.value.text;
              }
            } catch { /* 整理失败用原文 */ }
            writeDraft(rec, finalText);
            const label = providerLabel(providerInfo, t);
            showNote("info", label ? t("done").replace("{provider}", label) : t("doneNoProvider"));
          } else if (rec.accumulated) {
            // 定稿为空：保留实时累积的文字，避免把已经显示的内容清掉。
            writeDraft(rec, rec.accumulated);
            showNote("error", failure || t("unexpected"));
          } else {
            showNote("error", failure || t("unexpected"));
          }
        } catch (err) {
          showNote("error", t("error").replace("{msg}", String((err && err.message) || err)));
        } finally {
          setPhase("idle");
        }
      }, [phase, showNote, t, transcribe, polish, writeDraft]);

      const recording = phase === "recording";
      const busy = phase === "busy";
      const buttonStyle = {
        ...styles.button,
        ...(recording ? styles.buttonRecording : null),
      };

      const statusEl =
        note !== null
          ? React.createElement(
              "span",
              { style: { ...styles.status, ...(note.kind === "error" ? styles.statusError : styles.statusInfo) } },
              note.text
            )
          : recording
            ? React.createElement(
                "span",
                { style: styles.status },
                React.createElement("span", { style: styles.dot }),
                `${t("recording")} ${elapsed}s`
              )
            : busy
              ? React.createElement(
                  "span",
                  { style: styles.status },
                  React.createElement("span", { style: styles.spinner }),
                  t("transcribing")
                )
              : null;

      return React.createElement(
        "div",
        { style: styles.wrap },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dsh-voice-mic-btn",
            style: buttonStyle,
            title: recording ? t("stopHint") : t("startHint"),
            "aria-label": recording ? t("stopHint") : t("startHint"),
            disabled: busy,
            onClick: recording ? stop : begin,
          },
          recording ? React.createElement(StopIcon) : React.createElement(MicIcon)
        ),
        statusEl
      );
    }

    // ---------- 插件装配 ----------
    function apply(ctx) {
      // 挂载 Remote：调用 Host 的 transcribe() 前必须先等它就绪。
      const mountReady = ctx.remote.$mount(TYPERT_REMOTE);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-voice-input: dictionaries");
      const t = ctx.locale.bind(NS);

      const remoteApi = async () => {
        await mountReady;
        const api = ctx.get("remote.voiceInput");
        if (!api) throw new Error("voiceInput remote is unavailable");
        return api;
      };

      const transcribe = async (request) => (await remoteApi()).transcribe(request);
      const polish = async (request) => (await remoteApi()).polish(request);
      const describe = async () => (await remoteApi()).describe();

      // 把 transcribe / polish / describe 与 t 注入给输入框工具栏里的组件。
      const injected = () => ({ transcribe, polish, describe, t });

      ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
        name: "conversation.input.right",
        id: "voice-input",
        order: 40,
        locale: NS,
        inject: injected,
      }, VoiceMicButton));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
