import { addSshKeys } from "./add-ssh-key";
import { syncUserWithHost } from "./sync-user";
import { ensureDockerd, monitorServices, startSshd, tailDockerdLogs, waitForDocker } from "../lib/services";
import { runCommand } from "../lib/process";
import { writeEnvironmentFile } from "../lib/environment";
import { ensureTailscaled, waitForTailscaled, isTailscaleInstalled } from "../lib/tailscale";

export const runEntrypoint = async () => {
  console.log("[entrypoint] Syncing user with host...");
  await syncUserWithHost();
  console.log("[entrypoint] Adding SSH key...");
  try {
    await addSshKeys();
  } catch (error) {
    console.log(`[entrypoint] Failed to add SSH key (non-fatal): ${(error as Error).message}`);
  }

  // Skip Docker daemon setup if DOCKER_HOST is set (external container engine)
  const useExternalDocker = !!process.env.DOCKER_HOST;
  if (!useExternalDocker) {
    console.log("[entrypoint] Starting Docker daemon...");
    ensureDockerd();
    const ready = await waitForDocker();
    if (!ready) {
      process.exit(1);
      return;
    }
  } else {
    console.log("[entrypoint] Using external container engine at DOCKER_HOST");
  }

  console.log("[entrypoint] Running workspace initialization as workspace user...");
  try {
    await runCommand("sudo", ["-u", "workspace", "-E", "/usr/local/bin/workspace-internal", "init"], {
      env: process.env,
    });
  } catch (error) {
    console.log(`[entrypoint] Initialization failed (non-fatal): ${(error as Error).message}`);
    console.log("[entrypoint] SSH will still start - connect to debug the issue");
  }
  console.log("[entrypoint] Writing environment file...");
  try {
    await writeEnvironmentFile(process.env as Record<string, string>);
  } catch (error) {
    console.log(`[entrypoint] Failed to write environment file (non-fatal): ${(error as Error).message}`);
  }
  console.log("[entrypoint] Starting SSH daemon...");
  await startSshd();
  if (process.env.TS_AUTHKEY && (await isTailscaleInstalled())) {
    console.log("[entrypoint] Starting Tailscale daemon...");
    ensureTailscaled();
    await waitForTailscaled();
  }
  void monitorServices();

  // Skip tailing dockerd logs if using external container engine
  if (!useExternalDocker) {
    await tailDockerdLogs();
  } else {
    // Keep process alive for external container engine mode
    await new Promise(() => {});
  }
};
