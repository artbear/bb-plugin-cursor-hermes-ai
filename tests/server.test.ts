import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("Сервисы недоступны Automatic до проверки и используют выбранную машину", async t => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "cursor-hermes-ai",
    settings: { cursorMachine: "host-cursor", hermesMachine: "host-hermes" },
    experimental_callHostRpc: async ({ method }) => method === "prepare" ? { ready: true }
      : { ok: true, text: "Проверка имени пользователя", durationMs: 100 },
  });
  t.after(() => harness.lifecycle.dispose());
  plugin(bb);
  const cursor = harness.inspection.registrations.aiServiceRegistrations.find(service => service.id === "cursor")!;
  assert.equal((await cursor.status!()).ready, false);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
  const result = await harness.behavior.runCli(["test", "--service", "cursor", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.equal((await cursor.status!()).ready, true);
  assert.equal(harness.inspection.experimental_hostRpcCalls[0].hostId, "host-cursor");
  assert.equal(harness.inspection.registrations.aiServiceRegistrations.length, 2);
  assert.equal(cursor.transcribe, undefined);

  await harness.behavior.setSettings({ cursorModel: "another-model" });
  assert.equal((await cursor.status!()).ready, false);
});

test("Отказ проверки оставляет сервис неготовым", async t => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "cursor-hermes-ai",
    settings: { hermesMachine: "host-hermes" },
    experimental_callHostRpc: async () => ({ ok: false, message: "Нет авторизации" }),
  });
  t.after(() => harness.lifecycle.dispose());
  plugin(bb);
  const result = await harness.behavior.runCli(["test", "--service", "hermes", "--json"]);
  assert.equal(result.exitCode, 1);
  const hermes = harness.inspection.registrations.aiServiceRegistrations.find(service => service.id === "hermes")!;
  assert.equal((await hermes.status!()).ready, false);
});

test("Исходники используют только публичный SDK", () => {
  const scan = experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [/^@agentclientprotocol\/sdk$/, /^@get-bb\/plugin-sdk\/process$/],
  });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
