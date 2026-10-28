import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const serviceSchema = z.enum(["cursor", "hermes"]);
export type Service = z.infer<typeof serviceSchema>;

export const configSchema = z.object({
  service: serviceSchema,
  command: z.string().trim().min(1).max(4096),
  model: z.string().trim().max(512),
  proxy: z.string().trim().max(2048),
}).strict();
export type AgentConfig = z.infer<typeof configSchema>;

export const statusSchema = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }).strict(),
  z.object({ ready: z.literal(false), message: z.string() }).strict(),
]);
export type ServiceStatus = z.infer<typeof statusSchema>;

export const textResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string(), durationMs: z.number() }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type TextResult = z.infer<typeof textResultSchema>;

export const hostContract = defineRpcContract({
  prepare: { input: configSchema, output: statusSchema },
  complete: {
    input: z.object({ config: configSchema, prompt: z.string().min(1).max(131072) }).strict(),
    output: textResultSchema,
  },
  test: { input: z.object({ config: configSchema, prompt: z.string() }).strict(), output: textResultSchema },
  stop: { input: z.object({ service: serviceSchema }).strict(), output: z.null() },
});
