import { spawn } from "child_process";
import { once } from "events";
import fs from "fs";
import { ensureDir, pathExists, readFileLines } from "./fs";
import { delay, runCommand } from "./process";
import { startTailscaled } from "./tailscale";

const logPath = "/var/log/dockerd.log";
let dockerdProcess: ReturnType<typeof spawn> | null = null;

export const startDockerd = () => {
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn("/usr/local/bin/dockerd-entrypoint.sh", ["dockerd", "--host=unix:///var/run/docker.sock", "--host=tcp://0.0.0.0:2376"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });
  child.once("exit", () => {
    stream.write("[entrypoint] dockerd exited\n");
    stream.end();
    dockerdProcess = null;
  });
  child.once("error", (error) => {
    stream.write(`[entrypoint] dockerd error: ${error.message}\n`);
    stream.end();
    dockerdProcess = null;
  });
  dockerdProcess = child;
  return child;
};

export const ensureDockerd = () => {
  if (!dockerdProcess) {
    startDockerd();
  }
  return dockerdProcess;
};

export const startSshd = async () => {
  await ensureDir("/var/log");
  await runCommand("/usr/sbin/sshd", [], { logFile: "/var/log/sshd.log", ignoreFailure: true });
};

const isProcessRunning = async (name: string) => {
  const result = await runCommand("pgrep", ["-x", name], { ignoreFailure: true });
  return result.code === 0;
};

export const monitorServices = async () => {
  console.log("[entrypoint] Starting service monitor...");
  const hasTailscale = !!process.env.TS_AUTHKEY;
  const useExternalDocker = !!process.env.DOCKER_HOST;
  while (true) {
    await delay(10000);
    if (!useExternalDocker && !(await isProcessRunning("dockerd"))) {
      console.log("[entrypoint] Restarting Docker daemon...");
      startDockerd();
      await delay(2000);
    }
    if (!(await isProcessRunning("sshd"))) {
      console.log("[entrypoint] Restarting SSH daemon...");
      await startSshd();
    }
    if (hasTailscale && !(await isProcessRunning("tailscaled"))) {
      console.log("[entrypoint] Restarting Tailscale daemon...");
      startTailscaled();
      await delay(2000);
    }
  }
};

export const waitForDocker = async () => {
  console.log("[entrypoint] Waiting for Docker daemon to be ready...");
  for (let i = 1; i <= 30; i += 1) {
    const result = await runCommand("docker", ["version"], { ignoreFailure: true });
    if (result.code === 0) {
      console.log(`[entrypoint] Docker daemon is ready (took ${i}s)`);
      return true;
    }
    await delay(1000);
  }
  console.log("[entrypoint] ERROR: Docker daemon failed to start after 30 seconds");
  if (await pathExists(logPath)) {
    const lines = (await readFileLines(logPath)).filter((line) => line.trim());
    const tail = lines.slice(-50);
    console.log("[entrypoint] Docker daemon logs:");
    for (const line of tail) {
      console.log(line);
    }
  }
  return false;
};

export const tailDockerdLogs = async () => {
  console.log("[entrypoint] All services started. Container will stay alive.");
  console.log("[entrypoint] Logs: /var/log/dockerd.log, /var/log/sshd.log");
  const tail = spawn("tail", ["-f", logPath], { stdio: "inherit" });
  await once(tail, "exit");
};
