// dsh-plugin-voice-input —— Typert 主机清单（手写）。
//
// typert-loader 通过 package.json 的 exports["./typert"] 引入本文件，
// 注册到 ctx.typert.local；Host 网关据此在严格模式下认领并分发
// "voiceInput/transcribe" 端点：入参（音频 base64 + 可选 mime/format/language）
// 与出参均用 zod schema 校验，校验通过的结果才会跨 RPC 传给浏览器端。

import { z } from "zod";

const transcribeRequestSchema = z.object({
  /** 录音内容：base64 字符串或完整 data URL（data:<mime>;base64,...）。 */
  audio: z.string(),
  /** MIME 类型，如 audio/wav、audio/mpeg。 */
  mime: z.string().optional(),
  /** 音频格式，如 wav、mp3。 */
  format: z.string().optional(),
  /** 语种提示，如 zh。 */
  language: z.string().optional(),
});

const providerInfoSchema = z.object({
  id: z.string(),
  type: z.string(),
  model: z.string(),
});

const failureSchema = z.object({
  id: z.string(),
  code: z.string(),
  message: z.string(),
});

const errorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.array(failureSchema),
  })
  .nullable();

const transcribeResultSchema = z.object({
  ok: z.boolean(),
  text: z.string().nullable(),
  provider: providerInfoSchema.nullable(),
  error: errorSchema,
});

export const TYPERT = {
  package: "dsh-plugin-voice-input",
  face: "host",
  schemas: [],
  invocations: [
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
            schema: transcribeRequestSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-plugin-voice-input#TranscribeResult",
        schema: transcribeResultSchema,
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
};
