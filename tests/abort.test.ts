import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { abortable } from "../src/abort.js";

test("Уже отменённый запрос поглощает позднюю ошибку транспорта", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(abortable(Promise.reject(new Error("transport closed")), controller.signal), /cancelled/);
  await setImmediate();
});
