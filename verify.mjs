// dsh-plugin-voice-input —— 重启后一键验证脚本。
//
// 用法（dsh web 服务重启后）：
//   node verify.mjs
//
// 依次检查：
//   1. /plugins/dsh-plugin-voice-input/client.js 是否已由 web host 提供（200 + 内容特征）
//   2. 首页 boot graph（window.__DSH_BOOT__）是否包含本插件 id
//   3. /api/host.describe 是否可达（确认 RPC 通道正常）
// 全部通过表示插件已被服务器加载并下发给浏览器。

const BASE = process.env.DSH_WEB_URL || "http://127.0.0.1:3080";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`验证目标: ${BASE}\n`);

  // 1. 客户端 bundle
  try {
    const res = await fetch(`${BASE}/plugins/dsh-plugin-voice-input/client.js`);
    const text = await res.text();
    const looksRight =
      res.status === 200 &&
      text.includes("window.__ModuleLoader__.load") &&
      text.includes('"dsh-plugin-voice-input"');
    if (looksRight) {
      console.log(`✓ /plugins/dsh-plugin-voice-input/client.js → HTTP 200（${(text.length / 1024).toFixed(1)} KB，bundle 特征匹配）`);
    } else {
      fail(`/plugins 返回 ${res.status}，或内容不符合预期（前 80 字符: ${text.slice(0, 80).replace(/\n/g, " ")}）`);
    }
  } catch (err) {
    fail(`无法访问 /plugins/dsh-plugin-voice-input/client.js: ${err.message}`);
  }

  // 2. boot graph
  try {
    const html = await (await fetch(`${BASE}/`)).text();
    if (html.includes("dsh-plugin-voice-input")) {
      console.log("✓ 首页 boot graph 已包含 dsh-plugin-voice-input");
    } else {
      fail("首页 boot graph 中未找到 dsh-plugin-voice-input（服务可能未重启，或插件未被 loader 识别）");
    }
  } catch (err) {
    fail(`无法读取首页: ${err.message}`);
  }

  // 3. RPC 通道
  try {
    const res = await fetch(`${BASE}/api/host.describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "verify-1", method: "host.describe", payload: {} }),
    });
    const body = await res.json();
    if (res.status === 200 && body.result && body.result.ok) {
      console.log("✓ /api/host.describe 可达（RPC 通道正常）");
    } else {
      fail(`host.describe 异常: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (err) {
    fail(`RPC 通道不可达: ${err.message}`);
  }

  // 4. live 转写链路（真实语音样本 → voiceInput/transcribe）
  try {
    const audioPath = new URL("./speech-test.wav", import.meta.url);
    const b64 = Buffer.from(await import("node:fs/promises").then((m) => m.readFile(audioPath))).toString("base64");
    const res = await fetch(`${BASE}/api/voiceInput/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "verify-2",
        method: "voiceInput/transcribe",
        payload: { args: { request: { audio: `data:audio/wav;base64,${b64}`, mime: "audio/wav", format: "wav", language: "zh" } } },
      }),
    });
    const body = await res.json();
    const value = body?.result?.value;
    if (res.status === 200 && value && value.ok === true && value.text) {
      console.log(`✓ live 转写成功（${value.provider?.id ?? "?"} / ${value.provider?.model ?? "?"}）: "${value.text}"`);
    } else if (res.status === 200 && value && value.ok === false) {
      const codes = (value.error?.details ?? []).map((d) => `${d.id}:${d.code}`).join(" | ");
      fail(`live 转写未成功: ${value.error?.code}（${codes}）—— 服务器可能还是旧进程，或 Key 未生效`);
    } else {
      fail(`live 转写异常: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (err) {
    fail(`live 转写调用失败: ${err.message}`);
  }

  if (process.exitCode) {
    console.error("\n存在失败项 —— 请确认 dsh web 已重启（新进程），必要时检查服务器日志。");
  } else {
    console.log("\n全部通过：插件已加载且转写链路可用。刷新页面后，输入框工具栏应出现 🎙️ 按钮。");
  }
}

main();
