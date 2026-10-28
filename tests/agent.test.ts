import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test, type TestContext } from "node:test";
import { TextAgent } from "../src/agent.js";

async function fixture(t: TestContext, scenario = "normal", service: "cursor" | "hermes" = "cursor") {
  const cwd = await mkdtemp(join(tmpdir(), "bb-helper-ai-test-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  const agent = new TextAgent({ service, command: "fixture", model: "test-model", proxy: "" }, cwd, () => {
    child = spawn(process.execPath, [resolve("tests/fixtures/agent.mjs"), scenario], {
      cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    return child;
  });
  t.after(async () => { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { agent, child: () => child! };
}

test("Каждый запрос использует новую сессию; мысли не попадают в ответ", async t => {
  const { agent } = await fixture(t);
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  assert.equal(await agent.complete("first", AbortSignal.timeout(2000)), "session-1");
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  assert.equal(await agent.complete("second", AbortSignal.timeout(2000)), "session-2");
});

test("Hermes получает отказ на запрос разрешения инструмента", async t => {
  const { agent } = await fixture(t, "normal", "hermes");
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  assert.equal(await agent.complete("PERMISSION", AbortSignal.timeout(2000)), "denied");
});

test("Отмена ограничивает ожидание даже если агент игнорирует cancel; процесс остановлен", async t => {
  const { agent, child } = await fixture(t);
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  const exited = once(child(), "exit");
  const controller = new AbortController();
  const pending = agent.complete("HANG", controller.signal);
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(pending, /cancelled by user/);
  await exited;
  assert.equal(agent.status().ready, false);
});

test("Параллельный запрос не попадает в занятую сессию", async t => {
  const { agent } = await fixture(t);
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  const controller = new AbortController();
  const pending = agent.complete("HANG", controller.signal);
  await assert.rejects(agent.complete("second", AbortSignal.timeout(2000)), /другой запрос/);
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
});

test("Пустой ответ считается ошибкой, следующая сессия остаётся независимой", async t => {
  const { agent } = await fixture(t);
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  await assert.rejects(agent.complete("EMPTY", AbortSignal.timeout(2000)), /пустой ответ/);
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  assert.equal(await agent.complete("next", AbortSignal.timeout(2000)), "session-2");
});

test("Слишком большой ответ останавливает процесс", async t => {
  const { agent, child } = await fixture(t);
  await agent.waitUntilReady(AbortSignal.timeout(2000));
  const exited = once(child(), "exit");
  await assert.rejects(agent.complete("OVERSIZED", AbortSignal.timeout(2000)));
  await exited;
  assert.equal(agent.status().ready, false);
});

test("Удаление плагина во время initialize освобождает процесс и ожидание", async t => {
  const { agent, child } = await fixture(t, "initialization-hangs");
  const ready = agent.waitUntilReady(AbortSignal.timeout(2000));
  const rejected = assert.rejects(ready);
  const exited = once(child(), "exit");
  await agent.dispose();
  await rejected;
  await exited;
});
