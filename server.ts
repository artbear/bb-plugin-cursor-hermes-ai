import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type AgentConfig, type Service, type ServiceStatus } from "./src/contract.js";

const services = ["cursor", "hermes"] as const;
const samples = {
  "thread-title": "Напиши короткий заголовок на русском для задачи: добавить проверку пустого имени при сохранении пользователя. Верни только заголовок, без кавычек.",
  "commit-message": "Напиши короткое сообщение git commit на русском: перед сохранением пользователя добавлена проверка пустого имени, при ошибке сохранение отменяется. Верни только одну строку сообщения.",
};

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
    cursorMachine: { type: "string", label: "Cursor: ID машины", description: "Из bb machine list. Пусто — основная машина BB.", default: "" },
    cursorCommand: { type: "string", label: "Cursor: команда CLI", default: "cursor-agent" },
    cursorModel: { type: "string", label: "Cursor: модель ACP", description: "Пусто — модель CLI. Для малой задержки выбирайте модель без рассуждений.", default: "" },
    cursorProxy: { type: "string", label: "Cursor: HTTPS_PROXY", description: "Пусто — окружение машины. Без логина и пароля в URL.", default: "" },
    hermesMachine: { type: "string", label: "Hermes: ID машины", description: "Из bb machine list. Пусто — основная машина BB.", default: "" },
    hermesCommand: { type: "string", label: "Hermes: команда CLI", default: "hermes" },
    hermesModel: { type: "string", label: "Hermes: модель ACP", description: "Пусто — модель из настроек Hermes.", default: "" },
  });

  async function target(service: Service): Promise<{ hostId: string; config: AgentConfig }> {
    const current = await settings.get();
    const machine = service === "cursor" ? current.cursorMachine : current.hermesMachine;
    const hostId = machine.trim() || (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("Не подключена основная машина BB");
    return {
      hostId,
      config: {
        service,
        command: (service === "cursor" ? current.cursorCommand : current.hermesCommand).trim(),
        model: (service === "cursor" ? current.cursorModel : current.hermesModel).trim(),
        proxy: service === "cursor" ? current.cursorProxy.trim() : "",
      },
    };
  }

  async function status(service: Service): Promise<ServiceStatus> {
    try {
      const { hostId, config } = await target(service);
      const verified = await bb.storage.kv.get<string>(`verified:${service}`);
      if (verified !== JSON.stringify({ hostId, config })) {
        return { ready: false, message: `Требуется проверка: bb cursor-hermes-ai test --service ${service}` };
      }
      return await host.call("prepare", config, { hostId, timeoutMs: 2_000 });
    } catch {
      return { ready: false, message: "Выбранная машина или CLI недоступны; проверьте настройки плагина" };
    }
  }

  for (const service of services) {
    bb.experimental_aiServices.register({
      id: service,
      displayName: service === "cursor" ? "Cursor" : "Hermes",
      status: () => status(service),
      complete: async (prompt, { signal }) => {
        const { hostId, config } = await target(service);
        const result = await host.call("complete", { config, prompt }, { hostId, signal, timeoutMs: 5_000 });
        if (!result.ok) throw new Error(result.message);
        return result.text;
      },
    });
  }

  settings.onChange(async (next, previous) => {
    for (const service of services) {
      const changed = service === "cursor"
        ? next.cursorMachine !== previous.cursorMachine || next.cursorCommand !== previous.cursorCommand || next.cursorModel !== previous.cursorModel || next.cursorProxy !== previous.cursorProxy
        : next.hermesMachine !== previous.hermesMachine || next.hermesCommand !== previous.hermesCommand || next.hermesModel !== previous.hermesModel;
      if (!changed) continue;
      await bb.storage.kv.delete(`verified:${service}`);
      const oldMachine = (service === "cursor" ? previous.cursorMachine : previous.hermesMachine).trim()
        || (await bb.sdk.system.config()).primaryHostId;
      if (oldMachine) await host.call("stop", { service }, { hostId: oldMachine, timeoutMs: 2_000 }).catch(() => {});
    }
  });

  bb.cli.register(defineCli({
    name: "cursor-hermes-ai",
    summary: "Проверка Cursor и Hermes для AI services BB",
    commands: {
      status: cliCommand({
        summary: "Показать готовность сервисов",
        options: { json: { type: "boolean", description: "JSON" } },
        async run(input) {
          const result = Object.fromEntries(await Promise.all(services.map(async service => [service, await status(service)])));
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2) };
        },
      }),
      test: cliCommand({
        summary: "Подготовить ACP и проверить ответ в пределах тайм-аута BB",
        options: {
          service: { type: "enum", values: services, required: true, description: "cursor или hermes" },
          task: { type: "enum", values: ["thread-title", "commit-message"], default: "thread-title", description: "Что генерировать" },
          json: { type: "boolean", description: "JSON" },
        },
        async run(input, context) {
          const service = input.options.service;
          const { hostId, config } = await target(service);
          await bb.storage.kv.delete(`verified:${service}`);
          const result = await host.call("test", { config, prompt: samples[input.options.task] }, {
            hostId, signal: context.signal, timeoutMs: 40_000,
          });
          if (result.ok) {
            await bb.storage.kv.set(`verified:${service}`, JSON.stringify({ hostId, config }));
          }
          bb.log.info(result.ok ? `${service}: проверка ${input.options.task} пройдена за ${result.durationMs} мс`
            : `${service}: проверка ${input.options.task} не пройдена: ${result.message}`);
          return {
            exitCode: result.ok ? 0 : 1,
            stdout: JSON.stringify({ service, task: input.options.task, ...result }, null, input.options.json ? undefined : 2),
          };
        },
      }),
    },
  }));
}
