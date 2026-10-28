import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext, type ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { TextAgent } from "./agent.js";
import { hostContract, type AgentConfig, type Service, type TextResult } from "./contract.js";

const agents = new Map<Service, { key: string; agent: TextAgent; lease: ExperimentalHostWorkerLease }>();
const changes = new Map<Service, Promise<unknown>>();

async function change<T>(service: Service, action: () => Promise<T>): Promise<T> {
  const pending = (changes.get(service) ?? Promise.resolve()).catch(() => {}).then(action);
  changes.set(service, pending);
  try { return await pending; }
  finally { if (changes.get(service) === pending) changes.delete(service); }
}

async function stopAgent(service: Service): Promise<void> {
  const entry = agents.get(service);
  if (!entry) return;
  agents.delete(service);
  await entry.agent.dispose();
  await entry.lease.dispose();
}

function stop(service: Service): Promise<void> {
  return change(service, () => stopAgent(service));
}

async function getAgent(config: AgentConfig, context: ExperimentalHostRpcContext): Promise<TextAgent> {
  return change(config.service, async () => {
    context.signal.throwIfAborted();
    context.lifecycle.signal.throwIfAborted();
    const key = JSON.stringify(config);
    const previous = agents.get(config.service);
    if (previous?.key === key) return previous.agent;
    await stopAgent(config.service);
    const cwd = join(context.experimental_paths.tempDir, config.service);
    await mkdir(cwd, { recursive: true });
    context.signal.throwIfAborted();
    context.lifecycle.signal.throwIfAborted();
    const agent = new TextAgent(config, cwd);
    agents.set(config.service, { key, agent, lease: context.experimental_retainWorker() });
    agent.start();
    return agent;
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Ошибка AI service";
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    prepare: async (config, context) => (await getAgent(config, context)).status(),
    stop: async ({ service }) => { await stop(service); return null; },
    complete: async ({ config, prompt }, context): Promise<TextResult> => {
      const started = performance.now();
      try {
        const agent = await getAgent(config, context);
        const text = await agent.complete(prompt, AbortSignal.any([context.signal, AbortSignal.timeout(4_600)]));
        return { ok: true, text, durationMs: Math.round(performance.now() - started) };
      } catch (error) { return { ok: false, message: message(error) }; }
    },
    test: async ({ config, prompt }, context): Promise<TextResult> => {
      // Preparation is measured separately; production requests still get BB's 5 seconds.
      await stop(config.service);
      const agent = await getAgent(config, context);
      try {
        await agent.waitUntilReady(AbortSignal.any([context.signal, AbortSignal.timeout(32_000)]));
        const started = performance.now();
        const text = await agent.complete(prompt, AbortSignal.any([context.signal, AbortSignal.timeout(4_600)]));
        return { ok: true, text, durationMs: Math.round(performance.now() - started) };
      } catch (error) {
        await stop(config.service);
        return { ok: false, message: message(error) };
      }
    },
  },
  dispose: async () => { await Promise.all([...agents.keys()].map(stop)); },
});
