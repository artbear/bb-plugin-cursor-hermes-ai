import { ClientApp, ndJsonStream, RequestError, type ClientConnection, type NewSessionResponse } from "@agentclientprotocol/sdk";
import { experimental_spawnHostProcess as spawn } from "@get-bb/plugin-sdk/process";
import { Readable, Writable } from "node:stream";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { abortable } from "./abort.js";
import { stopProcess } from "./process.js";
import type { AgentConfig, ServiceStatus } from "./contract.js";

const PREPARE_TIMEOUT_MS = 30_000;
const MAX_TEXT = 32_768;
const MAX_SESSIONS = 32;

export type LaunchAgent = (config: AgentConfig, cwd: string) => ChildProcessWithoutNullStreams;
const launchAgent: LaunchAgent = (config, cwd) => spawn(config.command, ["acp"], {
  cwd,
  env: { ...process.env, ...(config.proxy ? { HTTPS_PROXY: config.proxy } : {}) },
  windowsHide: true,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});

export class TextAgent {
  private connection?: ClientConnection;
  private child?: ChildProcess;
  private session?: NewSessionResponse;
  private preparing?: Promise<void>;
  private lifetime = new AbortController();
  private message = "Подготовка ACP-сессии";
  private busy = false;
  private completed = 0;
  private active?: { sessionId: string; text: string };
  private stage = "Запуск CLI";

  constructor(readonly config: AgentConfig, private readonly cwd: string, private readonly launch: LaunchAgent = launchAgent) {}

  start(): void {
    if (this.preparing) return;
    this.preparing = this.open();
    void this.preparing.catch(() => {});
  }

  status(): ServiceStatus {
    return this.session && !this.busy
      ? { ready: true }
      : { ready: false, message: this.busy ? "Сервис выполняет другой запрос" : this.message };
  }

  async waitUntilReady(signal: AbortSignal): Promise<void> {
    this.start();
    await abortable(this.preparing!, signal);
    if (!this.session) throw new Error(this.message);
  }

  private async open(): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]);
    try {
      signal.throwIfAborted();
      this.child = this.launch(this.config, this.cwd);
      const child = this.child;
      child.stderr!.resume(); // Native diagnostics may contain private account data.
      child.once("error", () => {
        if (!this.lifetime.signal.aborted) void this.fail("Не удалось запустить CLI; проверьте путь команды на выбранной машине");
      });
      child.once("exit", () => {
        if (!this.lifetime.signal.aborted) void this.fail("Процесс ACP завершён; запустите проверку сервиса заново");
      });
      const app = new ClientApp()
        .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }))
        .onNotification("session/update", ({ params: { sessionId, update } }) => {
          if (this.lifetime.signal.aborted || this.active?.sessionId !== sessionId) return;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            this.active.text += update.content.text;
            if (this.active.text.length > MAX_TEXT) void this.fail("Ответ превышает допустимый размер");
          }
        });
      this.connection = app.connect(ndJsonStream(
        Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!), { maxMessageBytes: 1024 * 1024 },
      ));
      this.stage = "initialize";
      await abortable(this.connection.agent.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "bb-cursor-hermes-ai", version: "0.1.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }), signal);
      await this.prepareSession(signal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Ошибка подготовки ACP";
      const data = error instanceof RequestError && typeof error.data === "object" && error.data !== null
        && "details" in error.data && typeof error.data.details === "string" ? error.data.details : "";
      await this.fail(`${this.stage}: ${detail}${data ? `. ${data}` : ""}`);
      throw new Error(this.message);
    }
  }

  private async prepareSession(signal: AbortSignal): Promise<void> {
    const connection = this.connection!;
    this.stage = "session/new";
    const session = await abortable(connection.agent.request("session/new", { cwd: this.cwd, mcpServers: [] }), signal);
    const modeId = this.config.service === "cursor" ? "ask" : "default";
    if (!session.modes?.availableModes.some(mode => mode.id === modeId)) {
      throw new Error(`ACP не предоставляет ожидаемый режим ${modeId}`);
    }
    if (session.modes.currentModeId !== modeId) {
      this.stage = "session/set_mode";
      await abortable(connection.agent.request("session/set_mode", { sessionId: session.sessionId, modeId }), signal);
    }
    if (this.config.model) {
      this.stage = "session/set_config_option: model";
      await abortable(connection.agent.request("session/set_config_option", {
        sessionId: session.sessionId, configId: "model", value: this.config.model,
      }), signal);
    }
    if (this.config.service === "hermes" && session.configOptions?.some(option => option.id === "reasoning_effort")) {
      this.stage = "session/set_config_option: reasoning_effort";
      await abortable(connection.agent.request("session/set_config_option", {
        sessionId: session.sessionId, configId: "reasoning_effort", value: "none",
      }), signal);
    }
    signal.throwIfAborted();
    this.session = session;
  }

  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const status = this.status();
    if (!status.ready) throw new Error(status.message);
    const session = this.session!;
    this.session = undefined;
    this.busy = true;
    this.active = { sessionId: session.sessionId, text: "" };
    const stop = () => {
      void this.connection?.agent.notify("session/cancel", { sessionId: session.sessionId }).catch(() => {});
      void this.fail("Запрос отменён или превысил тайм-аут BB (5 секунд)");
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const response = await abortable(this.connection!.agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Generate only the requested text. Do not use tools or access files.\n\n" + prompt }],
      }), signal);
      signal.throwIfAborted();
      if (this.lifetime.signal.aborted) throw new Error(this.message);
      if (response.stopReason !== "end_turn") throw new Error(`ACP завершил запрос: ${response.stopReason}`);
      const text = this.active.text.trim();
      if (!text) throw new Error("ACP вернул пустой ответ");
      return text;
    } finally {
      signal.removeEventListener("abort", stop);
      this.active = undefined;
      this.busy = false;
      this.completed++;
      if (!this.lifetime.signal.aborted) {
        // Bound agent-side session state; every prompt gets a fresh conversation.
        this.preparing = this.completed >= MAX_SESSIONS ? this.recycle() : this.prepareSession(
          AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]),
        );
        void this.preparing.catch(error => this.fail(error instanceof Error ? error.message : "Ошибка подготовки сессии"));
      }
    }
  }

  private async recycle(): Promise<void> {
    this.connection?.close();
    if (this.child) {
      this.child.removeAllListeners("exit");
      await stopProcess(this.child);
    }
    this.completed = 0;
    await this.open();
  }

  private async fail(message: string): Promise<void> {
    this.message = message.slice(0, 400);
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.session = undefined;
    this.lifetime.abort();
    this.connection?.close();
    if (this.child) await stopProcess(this.child);
  }
}
