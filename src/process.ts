import type { ChildProcess } from "node:child_process";
import { experimental_spawnHostProcess as spawn } from "@get-bb/plugin-sdk/process";

/** Terminate our own process tree, including CLI launchers on Windows. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  const exited = alreadyExited ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    if (alreadyExited) return;
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("error", () => { child.kill(); resolve(); });
      killer.once("exit", () => resolve());
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    // A launcher can exit while one of its children ignores SIGTERM.
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 250))]);
  }
}
