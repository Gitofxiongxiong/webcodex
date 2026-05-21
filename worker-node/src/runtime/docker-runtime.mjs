import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 24_000;
export const DOCKER_SANDBOX_ROOT = "/sandbox";
export const DOCKER_ARTIFACTS_ROOT = "/artifacts";

export async function createAgentRuntime({
  mode,
  runId,
  workspaceDir,
  artifactsDir,
  image,
  containerName,
  autoBuild,
  dockerfilePath,
  network,
  cpus,
  memory,
  pidsLimit,
  keepContainer,
}) {
  const runtimeMode = mode || "docker";
  if (runtimeMode === "local") {
    const runtime = new LocalAgentRuntime({ workspaceDir, artifactsDir });
    await runtime.start();
    return runtime;
  }
  if (runtimeMode !== "docker") {
    throw new Error(`Unsupported worker runtime: ${runtimeMode}`);
  }
  const runtime = new DockerAgentRuntime({
    runId,
    workspaceDir,
    artifactsDir,
    image,
    containerName,
    autoBuild,
    dockerfilePath,
    network,
    cpus,
    memory,
    pidsLimit,
    keepContainer,
  });
  await runtime.start();
  return runtime;
}

export class DockerAgentRuntime {
  constructor({
    runId,
    workspaceDir,
    artifactsDir,
    image = "webcodex-agent-runtime:latest",
    containerName,
    autoBuild = true,
    dockerfilePath,
    network = "bridge",
    cpus = "2",
    memory = "4g",
    pidsLimit = "512",
    keepContainer = false,
  }) {
    this.mode = "docker";
    this.runId = runId;
    this.workspaceDir = path.resolve(workspaceDir);
    this.artifactsDir = path.resolve(artifactsDir);
    this.image = image;
    this.containerName = containerName || `webcodex-${safeDockerName(runId)}`;
    this.autoBuild = Boolean(autoBuild);
    this.dockerfilePath = dockerfilePath ? path.resolve(dockerfilePath) : defaultDockerfilePath();
    this.network = network || "bridge";
    this.cpus = String(cpus || "2");
    this.memory = String(memory || "4g");
    this.pidsLimit = String(pidsLimit || "512");
    this.keepContainer = Boolean(keepContainer);
    this.containerId = null;
    this.sandboxRoot = DOCKER_SANDBOX_ROOT;
    this.artifactsRoot = DOCKER_ARTIFACTS_ROOT;
    this.cwd = this.sandboxRoot;
  }

  async start() {
    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    if (!(await dockerImageExists(this.image))) {
      if (!this.autoBuild) {
        throw new Error(`Docker image not found: ${this.image}`);
      }
      await buildRuntimeImage({ image: this.image, dockerfilePath: this.dockerfilePath });
    }
    await runDocker(["rm", "-f", this.containerName], { okExitCodes: [0, 1] });
    const args = [
      "run",
      "-d",
      "--name",
      this.containerName,
      "--workdir",
      this.sandboxRoot,
      "--user",
      "codex",
      "--network",
      this.network,
      "--cpus",
      this.cpus,
      "--memory",
      this.memory,
      "--pids-limit",
      this.pidsLimit,
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,source=${this.workspaceDir},target=${this.sandboxRoot}`,
      "--mount",
      `type=bind,source=${this.artifactsDir},target=${this.artifactsRoot}`,
      this.image,
      "sleep",
      "infinity",
    ];
    const result = await runDocker(args);
    this.containerId = result.stdout.trim() || this.containerName;
    return this;
  }

  async stop() {
    if (this.keepContainer) {
      return;
    }
    await runDocker(["rm", "-f", this.containerName], { okExitCodes: [0, 1] }).catch(() => {});
  }

  async exec(command, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = MAX_OUTPUT_CHARS } = {}) {
    const normalizedTimeout = normalizeTimeoutMs(timeoutMs);
    const normalizedLimit = normalizeOutputLimit(maxOutputChars);
    const seconds = Math.max(1, Math.ceil(normalizedTimeout / 1000));
    const args = [
      "exec",
      "--workdir",
      this.sandboxRoot,
      "--user",
      "codex",
      this.containerName,
      "timeout",
      "--kill-after=1s",
      `${seconds}s`,
      "bash",
      "-lc",
      String(command),
    ];
    const result = await runProcess("docker", args, {
      timeoutMs: normalizedTimeout + 2_000,
      maxOutputChars: normalizedLimit,
      okExitCodes: null,
      commandForOutput: command,
      cwdForOutput: this.sandboxRoot,
    });
    const timedOut = result.timed_out || result.exit_code === 124 || result.exit_code === 137;
    return {
      ...result,
      ok: result.exit_code === 0 && !timedOut,
      timed_out: timedOut,
      cwd: this.sandboxRoot,
      command: String(command),
    };
  }

  resolveWorkspacePath(targetPath) {
    return resolveInside(this.workspaceDir, normalizeSandboxPath(targetPath));
  }

  resolveArtifactPath(targetPath) {
    return resolveInside(this.artifactsDir, normalizeSandboxPath(targetPath));
  }

  relativeWorkspacePath(fullPath) {
    return normalizeSlash(path.relative(this.workspaceDir, fullPath));
  }

  commandWorkspacePath(targetPath) {
    return path.posix.join(this.sandboxRoot, normalizeSandboxPath(targetPath));
  }
}

class LocalAgentRuntime {
  constructor({ workspaceDir, artifactsDir }) {
    this.mode = "local";
    this.workspaceDir = path.resolve(workspaceDir);
    this.artifactsDir = path.resolve(artifactsDir);
    this.containerName = null;
    this.containerId = null;
    this.sandboxRoot = this.workspaceDir;
    this.artifactsRoot = this.artifactsDir;
    this.cwd = this.workspaceDir;
  }

  async start() {
    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
  }

  async stop() {}

  async exec(command, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = MAX_OUTPUT_CHARS } = {}) {
    const result = await runProcess("bash", ["-lc", String(command)], {
      timeoutMs: normalizeTimeoutMs(timeoutMs),
      maxOutputChars: normalizeOutputLimit(maxOutputChars),
      okExitCodes: null,
      cwd: this.workspaceDir,
      commandForOutput: command,
      cwdForOutput: this.workspaceDir,
    });
    return {
      ...result,
      ok: result.exit_code === 0 && !result.timed_out,
      command: String(command),
      cwd: this.workspaceDir,
    };
  }

  resolveWorkspacePath(targetPath) {
    return resolveInside(this.workspaceDir, normalizeSandboxPath(targetPath));
  }

  resolveArtifactPath(targetPath) {
    return resolveInside(this.artifactsDir, normalizeSandboxPath(targetPath));
  }

  relativeWorkspacePath(fullPath) {
    return normalizeSlash(path.relative(this.workspaceDir, fullPath));
  }

  commandWorkspacePath(targetPath) {
    return this.resolveWorkspacePath(targetPath);
  }
}

export class RuntimeShellExecutor {
  constructor({ runtime }) {
    this.runtime = runtime;
  }

  async run(action) {
    const timeoutMs = normalizeTimeoutMs(action?.timeoutMs);
    const maxOutputLength = normalizeOutputLimit(action?.maxOutputLength);
    const commands = Array.isArray(action?.commands) ? action.commands : [];
    const output = [];
    for (const command of commands) {
      const result = await this.runtime.exec(command, { timeoutMs, maxOutputChars: maxOutputLength });
      output.push({
        stdout: result.stdout,
        stderr: result.stderr,
        outcome: result.timed_out ? { type: "timeout" } : { type: "exit", exitCode: result.exit_code },
        command: result.command,
        cwd: result.cwd,
        duration_ms: result.duration_ms,
        signal: result.signal,
      });
    }
    return { output, maxOutputLength };
  }
}

async function dockerImageExists(image) {
  const result = await runDocker(["image", "inspect", image], { okExitCodes: [0, 1] });
  return result.exit_code === 0;
}

async function buildRuntimeImage({ image, dockerfilePath }) {
  const contextDir = path.dirname(dockerfilePath);
  await runDocker(["build", "-t", image, "-f", dockerfilePath, contextDir], {
    timeoutMs: 20 * 60_000,
    maxOutputChars: 80_000,
  });
}

async function runDocker(args, options = {}) {
  return runProcess("docker", args, options);
}

function runProcess(command, args, {
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = MAX_OUTPUT_CHARS,
  okExitCodes = [0],
  commandForOutput,
  cwdForOutput,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: process.env,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString(), maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), maxOutputChars);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCodeAllowed = okExitCodes === null || okExitCodes.includes(code);
      const result = {
        ok: exitCodeAllowed && !timedOut,
        command: commandForOutput ?? [command, ...args].join(" "),
        cwd: cwdForOutput ?? cwd,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
      };
      if (!exitCodeAllowed || timedOut) {
        const error = new Error(`${command} exited with ${code}: ${stderr || stdout}`);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

export async function removeDirectoryIfExists(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

export function normalizeSandboxPath(value) {
  const raw = String(value ?? ".").replaceAll("\\", "/").trim();
  const withoutSandbox = raw.startsWith(`${DOCKER_SANDBOX_ROOT}/`)
    ? raw.slice(`${DOCKER_SANDBOX_ROOT}/`.length)
    : raw;
  if (!withoutSandbox || withoutSandbox === DOCKER_SANDBOX_ROOT) {
    return ".";
  }
  if (withoutSandbox.startsWith("/") || withoutSandbox.includes("\0")) {
    throw new Error(`Path must be inside ${DOCKER_SANDBOX_ROOT}: ${value}`);
  }
  const normalized = path.posix.normalize(withoutSandbox);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Path escapes ${DOCKER_SANDBOX_ROOT}: ${value}`);
  }
  return normalized === "." ? "." : normalized.replace(/^\.\/+/, "");
}

export function resolveInside(root, relativePath) {
  const fullPath = path.resolve(root, relativePath);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${relativePath}`);
  }
  return fullPath;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function normalizeTimeoutMs(value) {
  const number = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(number) || number < 1_000) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(number, MAX_TIMEOUT_MS);
}

function normalizeOutputLimit(value) {
  const number = Number(value ?? MAX_OUTPUT_CHARS);
  if (!Number.isInteger(number) || number < 1) {
    return MAX_OUTPUT_CHARS;
  }
  return Math.min(number, MAX_OUTPUT_CHARS);
}

function appendLimited(current, next, maxOutputChars = MAX_OUTPUT_CHARS) {
  const value = current + next;
  if (value.length <= maxOutputChars) {
    return value;
  }
  return `${value.slice(0, maxOutputChars)}\n[output truncated]`;
}

function defaultDockerfilePath() {
  return fileURLToPath(new URL("../../Dockerfile.agent-runtime", import.meta.url));
}

function safeDockerName(value) {
  return String(value || "run").replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
}

function normalizeSlash(value) {
  return String(value).replaceAll("\\", "/");
}
