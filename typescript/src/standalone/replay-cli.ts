#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { Effect, Schema } from "effect";
import { readReplayBundle, replayLocalOperation } from "../execution/local-operation-replay.js";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { openJobTrace, validateTraceDirectory } from "./job-trace.js";

class ReplayDeadline extends Error {
  constructor(readonly deadline: "replay.startup" | "replay.outer", readonly budgetMs: number) { super("timeout"); }
}

const optionsOf = (argv: readonly string[]) => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === undefined || value === undefined || !["--bundle", "--runtime", "--out", "--timeout-ms", "--inner", "--probe-file", "--depth"].includes(key) || values.has(key)) throw new Error("invalid_arguments");
    values.set(key, value);
  }
  const bundle = values.get("--bundle"); const runtime = values.get("--runtime"); const out = values.get("--out");
  const timeoutMs = Number(values.get("--timeout-ms") ?? 15_000);
  const depth = Schema.decodeUnknownSync(Schema.Literal("normal", "debug", "trace", "profile"))(values.get("--depth") ?? "trace");
  if (bundle === undefined || runtime === undefined || out === undefined || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("invalid_arguments");
  return { bundle: resolve(bundle), runtime: realpathSync(runtime), out: resolve(out), timeoutMs, depth, inner: values.get("--inner"), probeFile: values.get("--probe-file") };
};
const denied = (work: () => unknown) => { try { work(); return false; } catch (error) { return error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM"); } };
const probe = async (probeFile: string) => {
  const socketDenied = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 9 });
    socket.once("error", (error) => { socket.destroy(); resolve("code" in error && (error.code === "EPERM" || error.code === "EACCES")); });
    socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
  const executable = join(process.cwd(), `probe-${randomUUID()}`);
  let scratchExecutableDenied = false;
  try {
    writeFileSync(executable, `#!${process.execPath}\nprocess.exit(97);\n`, { mode: 0o755, flag: "wx" });
    scratchExecutableDenied = denied(() => { const result = spawnSync(executable, [], { timeout: 500 }); if (result.error !== undefined) throw result.error; });
  } finally { rmSync(executable, { force: true }); }
  return { socketDenied, scratchExecutableDenied, outsideChmodDenied: denied(() => chmodSync(probeFile, 0o644)), outsideSignalDenied: denied(() => process.kill(process.ppid, 0)), outsideWriteDenied: denied(() => writeFileSync(probeFile, "sandbox_probe")), accountReadDenied: denied(() => readFileSync("/etc/passwd")) && denied(() => readFileSync(probeFile)), environmentCleared: Object.keys(process.env).every((key) => ["PATH", "TMPDIR", "LANG", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(key)) };
};
const inner = async (options: ReturnType<typeof optionsOf>) => {
  if (options.probeFile === undefined || options.inner === undefined) throw new Error("sandbox_unavailable");
  const isolation = await probe(options.probeFile);
  if (!Object.values(isolation).every(Boolean)) throw new Error("sandbox_unavailable");
  if (options.inner === "probe") { process.stdout.write(JSON.stringify({ kind: "isolated" }) + "\n"); return; }
  const bundle = readReplayBundle(options.bundle);
  const trace = openJobTrace(options.out, randomUUID(), { selection: { depth: options.depth, capture: "none" } });
  try {
    const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace({ environment: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: options.out } });
      return yield* replayLocalOperation({ bundle, workspace, timeoutMs: options.timeoutMs, diagnostics: trace.operations,
        ready: Effect.async<void>((resume) => { process.send?.({ kind: "replay.ready" }, () => resume(Effect.void)); }),
        processLifecycle: { kind: "inherited", stop: (child) => { if (child.pid !== undefined && process.connected) process.send?.({ kind: "replay.kill", pid: child.pid }, () => {}); } },
      });
    })));
    const file = trace.artifact("report.json", Buffer.from(JSON.stringify({ ...report, isolation })));
    if (!file) throw new Error("artifact_failed");
    process.stdout.write(JSON.stringify({ kind: report.kind, ...(report.kind === "stopped" ? { reason: report.reason, ...(report.divergence === undefined ? {} : { divergence: report.divergence }) } : {}), sandbox: "seccomp_landlock", report: file }) + "\n");
    if (report.kind === "stopped") process.exitCode = 1;
  } finally { trace.close(); }
};
const outer = async (options: ReturnType<typeof optionsOf>) => {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("sandbox_unavailable");
  readReplayBundle(options.bundle);
  validateTraceDirectory(options.out);
  const scratch = mkdtempSync(join(options.out, "scratch-"));
  const probeFile = join(options.out, `probe-${randomUUID()}`);
  writeFileSync(probeFile, "private_probe", { mode: 0o600, flag: "wx" });
  try {
    const helper = join(scratch, "offline-sandbox");
    const source = fileURLToPath(new URL("./offline-sandbox.c", import.meta.url));
    const compiled = spawnSync("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Werror", source, "-o", helper], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, maxBuffer: 64 * 1024 });
    if (compiled.status !== 0) throw new Error("sandbox_unavailable");
    const cli = join(options.runtime, "dist/typescript/src/standalone/replay-cli.js");
    const dependencyDirectory = realpathSync(join(options.runtime, "node_modules"));
    const reads = [...new Set([join(options.runtime, "dist"), join(options.runtime, "package.json"), dependencyDirectory, options.bundle, realpathSync(process.execPath), "/usr/lib", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/ssl/openssl.cnf", "/dev/null", "/dev/urandom"].filter(existsSync).map((path) => realpathSync(path)))];
    if (reads.some((path) => path === "/" || path === "/home" || path === dirname(options.out))) throw new Error("sandbox_unavailable");
    const run = (mode: string, timeout: number) => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(helper, [scratch, String(reads.length), ...reads, process.execPath, "--max-old-space-size=512", cli, "--inner", mode, "--bundle", options.bundle, "--runtime", options.runtime, "--out", scratch, "--timeout-ms", String(options.timeoutMs), "--depth", options.depth, "--probe-file", probeFile], { cwd: scratch, env: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: scratch }, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stdout = ""; let bytes = 0; let expired = false; let interrupted = false;
      const kill = () => { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
      const stop = () => { interrupted = true; kill(); };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      let ready = false;
      let timer = setTimeout(() => { expired = true; kill(); }, 5_000);
      child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) kill(); else stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) kill(); });
      child.on("message", (raw: unknown) => {
        if (!ready && mode === "run" && typeof raw === "object" && raw !== null && Reflect.get(raw, "kind") === "replay.ready") {
          ready = true; clearTimeout(timer); timer = setTimeout(() => { expired = true; kill(); }, timeout); return;
        }
        const request = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.Literal("replay.kill"), pid: Schema.Int.pipe(Schema.positive()) }))(raw);
        if (request._tag === "None" || child.pid === undefined || request.value.pid === child.pid) return;
        try {
          const fields = readFileSync(`/proc/${request.value.pid}/stat`, "utf8").split(") ").slice(1).join(") ").split(" ");
          if (Number(fields[2]) === child.pid) process.kill(request.value.pid, "SIGKILL");
        } catch {}
      });
      child.once("error", reject);
      child.once("close", (code) => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); kill(); if (expired || interrupted) reject(expired ? new ReplayDeadline(ready ? "replay.outer" : "replay.startup", ready ? timeout : 5_000) : new Error("interrupted")); else resolve({ code, stdout }); });
    });
    const preflight = await run("probe", 5_000);
    if (preflight.code !== 0 || JSON.parse(preflight.stdout).kind !== "isolated") throw new Error("sandbox_unavailable");
    if ((lstatSync(probeFile).mode & 0o777) !== 0o600 || readFileSync(probeFile, "utf8") !== "private_probe") throw new Error("sandbox_unavailable");
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run("run", options.timeoutMs + 1_000); }
    catch (error) {
      if (!(error instanceof ReplayDeadline) && !(error instanceof Error && error.message === "interrupted")) throw error;
      const trace = openJobTrace(options.out, randomUUID(), { selection: { depth: "normal", capture: "none" } });
      try {
        const report = { kind: "stopped", reason: error.message, ...(error instanceof ReplayDeadline ? { deadline: error.deadline, budgetMs: error.budgetMs } : {}) };
        trace.event("diagnostic.gap", report);
        const file = trace.artifact("report.json", Buffer.from(JSON.stringify(report)));
        process.stdout.write(JSON.stringify({ ...report, ...(file ? { report: join(options.out, file) } : {}) }) + "\n"); process.exitCode = 1; return;
      } finally { trace.close(); }
    }
    const summary = Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.Literal("completed", "stopped"), reason: Schema.optionalWith(Schema.String, { exact: true }), sandbox: Schema.Literal("seccomp_landlock"), report: Schema.String.pipe(Schema.pattern(/^[0-9a-f.-]+report\.json$/u)), divergence: Schema.optionalWith(Schema.Struct({ order: Schema.Int, expected: Schema.String, actual: Schema.String }), { exact: true }) }))(JSON.parse(result.stdout));
    process.stdout.write(JSON.stringify({ ...summary, report: join(scratch, summary.report) }) + "\n");
    process.exitCode = result.code === 0 ? 0 : 1;
  } finally { rmSync(probeFile, { force: true }); rmSync(join(scratch, "offline-sandbox"), { force: true }); }
};
if (process.argv.includes("--help")) process.stdout.write("Usage: node replay-cli.js --bundle FILE --runtime PACKAGE --out PRIVATE_DIRECTORY [--timeout-ms 15000] [--depth trace]\n");
else {
  try { const options = optionsOf(process.argv.slice(2)); if (options.inner !== undefined) await inner(options); else await outer(options); }
  catch (error) { const reason = error instanceof Error && ["capture_gap", "unsupported_capability", "unsafe_bundle", "runtime_mismatch", "invalid_arguments", "sandbox_unavailable", "artifact_failed", "timeout", "interrupted"].includes(error.message) ? error.message : "replay_failed"; process.stdout.write(JSON.stringify({ kind: "stopped", reason }) + "\n"); process.exitCode = 1; }
}
if (process.connected) process.disconnect?.();
