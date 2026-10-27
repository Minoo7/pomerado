import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "pomerado-replay-cli-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const cli = resolve("dist/typescript/src/standalone/replay-cli.js");
const command = (args: string[], interruptWhen?: () => boolean) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", SYNTHETIC_ACCOUNT_SECRET: "must_not_survive" } }); let stdout = ""; let stderr = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const interrupt = interruptWhen === undefined ? undefined : setInterval(() => { if (interruptWhen()) { clearInterval(interrupt); child.kill("SIGINT"); } }, 50);
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); }); child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); }); child.on("error", reject); child.on("close", (code) => { clearTimeout(timeout); clearInterval(interrupt); resolve({ code, stdout, stderr }); });
});

const filesIn = (directory: string): string[] => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)]) : [];
const authored = (body: string) => `import {Schema} from 'effect'; import {defineOperation} from '../runtime/index.js'; export default defineOperation({input:Schema.Struct({}),output:Schema.Unknown},async({kernel,sessionId})=>{${body}});`;
const syntheticBundle = async (directory: string, body: string, target: "browser" | "pureFiles" = "pureFiles") => {
  const path = join(directory, "synthetic.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {runtimeIdentity,encodeReplayValue} from './dist/typescript/src/execution/local-operation-replay.js';
    import {writeFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    writeFileSync(process.argv[1], JSON.stringify({version:1,operation:randomUUID(),runtime:runtimeIdentity(),snapshot:encodeReplayValue(JSON.parse(process.argv[2])),exchanges:[],gaps:[]}),{mode:0o600,flag:'wx'});
  `, path, JSON.stringify({ entrypoint: "src/tool.mjs", sources: [["src/tool.mjs", authored(body)]], input: {}, target })], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  expect(await new Promise((resolve) => child.on("close", resolve)), stderr).toBe(0);
  return path;
};
const replayArgs = (path: string, out: string, timeout = 6_000) => ["--bundle", path, "--runtime", resolve("."), "--timeout-ms", String(timeout), "--out", out];
it("denies native process controls, shared IPC, keyrings and scratch binary execution", () => {
  const directory = temporary(); const scratch = temporary();
  const helper = join(directory, "offline-sandbox"); const executable = join(directory, "native-probe"); const source = join(directory, "native-probe.c");
  writeFileSync(source, `
    #define _GNU_SOURCE
    #include <errno.h>
    #include <fcntl.h>
    #include <signal.h>
    #include <stdio.h>
    #include <string.h>
    #include <sys/ipc.h>
    #include <sys/resource.h>
    #include <sys/sem.h>
    #include <sys/shm.h>
    #include <sys/msg.h>
    #include <sys/stat.h>
    #include <sys/syscall.h>
    #include <sys/wait.h>
    #include <unistd.h>
    #define CHECK(name, call) do { errno = 0; long result = (call); printf("%s:%ld:%d\\n", name, result, errno); } while (0)
    int main(int argc, char **argv) {
      if (argc != 2) return 90;
      if (!strcmp(argv[1], "payload")) return 99;
      int pipes[2]; if (pipe(pipes)) return 91;
      struct f_owner_ex owner = {.type = F_OWNER_PID, .pid = getpid()};
      CHECK("fcntl_setown", syscall(SYS_fcntl, pipes[0], F_SETOWN, getpid()));
      CHECK("fcntl_setown_ex", syscall(SYS_fcntl, pipes[0], F_SETOWN_EX, &owner));
      CHECK("fcntl_setsig", syscall(SYS_fcntl, pipes[0], F_SETSIG, SIGUSR1));
      CHECK("fcntl_setown_high", syscall(SYS_fcntl, pipes[0], (1UL << 32) | F_SETOWN, getpid()));
      CHECK("fcntl_setfl", fcntl(pipes[0], F_SETFL, O_NONBLOCK));
      struct rlimit limit = {0, 0};
      CHECK("prlimit_other", syscall(SYS_prlimit64, getppid(), RLIMIT_CORE, NULL, &limit));
      CHECK("prlimit_zero", syscall(SYS_prlimit64, 0, RLIMIT_CORE, NULL, &limit));
      CHECK("setrlimit_self", setrlimit(RLIMIT_CORE, &limit));
      CHECK("setpriority", setpriority(PRIO_PROCESS, 0, getpriority(PRIO_PROCESS, 0)));
      CHECK("sched_setparam", syscall(SYS_sched_setparam, 0, NULL));
      CHECK("sched_setscheduler", syscall(SYS_sched_setscheduler, 0, 0, NULL));
      CHECK("sched_setaffinity", syscall(SYS_sched_setaffinity, 0, 0, NULL));
      CHECK("sched_setattr", syscall(SYS_sched_setattr, 0, NULL, 0));
      CHECK("ioprio_set", syscall(SYS_ioprio_set, 1, 0, 0));
      CHECK("shmget", syscall(SYS_shmget, IPC_PRIVATE, 0, 0));
      CHECK("shmat", syscall(SYS_shmat, -1, NULL, 0));
      CHECK("shmctl", syscall(SYS_shmctl, -1, IPC_STAT, NULL));
      CHECK("shmdt", syscall(SYS_shmdt, NULL));
      CHECK("semget", syscall(SYS_semget, IPC_PRIVATE, 0, 0));
      CHECK("semctl", syscall(SYS_semctl, -1, 0, GETVAL));
      CHECK("semop", syscall(SYS_semop, -1, NULL, 0));
      CHECK("semtimedop", syscall(SYS_semtimedop, -1, NULL, 0, NULL));
      CHECK("msgget", syscall(SYS_msgget, 1, 0));
      CHECK("msgctl", syscall(SYS_msgctl, -1, IPC_STAT, NULL));
      CHECK("msgsnd", syscall(SYS_msgsnd, -1, NULL, 0, IPC_NOWAIT));
      CHECK("msgrcv", syscall(SYS_msgrcv, -1, NULL, 0, 0, IPC_NOWAIT));
      CHECK("add_key", syscall(SYS_add_key, NULL, NULL, NULL, 0, 0));
      CHECK("request_key", syscall(SYS_request_key, NULL, NULL, NULL, 0));
      CHECK("keyctl", syscall(SYS_keyctl, -1));
      #if defined(__NR_setxattrat)
      CHECK("setxattrat", syscall(SYS_setxattrat, -1, NULL, 0, NULL, NULL, 0));
      #endif
      #if defined(__NR_getxattrat)
      CHECK("getxattrat", syscall(SYS_getxattrat, -1, NULL, 0, NULL, NULL, 0));
      #endif
      #if defined(__NR_listxattrat)
      CHECK("listxattrat", syscall(SYS_listxattrat, -1, NULL, 0, NULL, 0));
      #endif
      #if defined(__NR_removexattrat)
      CHECK("removexattrat", syscall(SYS_removexattrat, -1, NULL, 0, NULL));
      #endif
      umask(0);
      int input = open(argv[0], O_RDONLY), output = open(argv[1], O_WRONLY|O_CREAT|O_EXCL, 0755);
      if (input < 0 || output < 0) return 92;
      char buffer[4096]; ssize_t length;
      while ((length = read(input, buffer, sizeof(buffer))) > 0) if (write(output, buffer, length) != length) return 93;
      struct stat info; if (length < 0 || fstat(output, &info)) return 94;
      printf("scratch_mode:%u:0\\n", info.st_mode & 0777);
      close(input); close(output); close(pipes[0]); close(pipes[1]);
      fflush(stdout);
      pid_t child = fork(); if (child < 0) return 95;
      if (!child) { execl(argv[1], argv[1], "payload", NULL); _exit(errno); }
      int status; if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 96;
      printf("scratch_exec:%d\\n", WEXITSTATUS(status));
      return 0;
    }
  `);
  for (const { input, output } of [{ input: resolve("typescript/src/standalone/offline-sandbox.c"), output: helper }, { input: source, output: executable }]) {
    const compiled = spawnSync("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Werror", input, "-o", output], { encoding: "utf8", timeout: 10_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
  }
  const reads = [directory, "/usr/lib", "/lib", "/lib64", "/etc/ld.so.cache"].filter(existsSync);
  const result = spawnSync(helper, [scratch, String(reads.length), ...reads, executable, join(scratch, "created-0755")], { encoding: "utf8", timeout: 5_000, env: { PATH: "/usr/bin:/bin" } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const rows = result.stdout.trim().split("\n");
  const allowed = new Set(["fcntl_setfl", "prlimit_zero", "setrlimit_self"]);
  for (const row of rows) {
    const name = row.split(":")[0];
    if (name === "scratch_mode") expect.soft(row).toBe("scratch_mode:493:0");
    else if (name === "scratch_exec") expect.soft(row).toBe("scratch_exec:13");
    else expect.soft(row).toBe(`${name}:${name !== undefined && allowed.has(name) ? "0:0" : "-1:1"}`);
  }
  expect(rows).toContain("prlimit_other:-1:1"); expect(rows).toContain("fcntl_setown:-1:1"); expect(rows).toContain("fcntl_setsig:-1:1"); expect(rows).toContain("scratch_exec:13");
}, 30_000);

it("runs the built CLI privately with real socket, account-read and write isolation", async () => {
  const directory = temporary(); const output = join(directory, "out"); const path = join(directory, "bundle.json");
  const capture = spawn(process.execPath, ["--input-type=module", "-e", `
    import {Effect} from 'effect'; import {openJobTrace} from './dist/typescript/src/standalone/job-trace.js'; import {createLocalWorkspace} from './dist/typescript/src/execution/local-workspace.js'; import {runLocalOperation} from './dist/typescript/src/execution/local-operation.js'; import {readdirSync,renameSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    const trace=openJobTrace(process.argv[1],randomUUID(),{selection:{depth:'trace',capture:'replay'}});
    const entrypoint='src/tool.mjs'; const source=\`import {Schema} from 'effect'; import {defineOperation} from '../runtime/index.js'; export default defineOperation({input:Schema.Struct({}),output:Schema.String},async()=>{return 'SYNTHETIC_CLI_PRIVATE_RESULT';});\`;
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const workspace=yield*createLocalWorkspace();return yield*runLocalOperation({workspace,entrypoint,sources:[[entrypoint,source]],input:{},target:'pureFiles',diagnostics:trace.operations,timeoutMs:6000});}))); trace.close(); renameSync(process.argv[1]+'/'+readdirSync(process.argv[1]).find(n=>n.endsWith('.replay.json')),process.argv[2]);
  `, directory, path], { stdio: ["ignore", "pipe", "pipe"] });
  let captureError = ""; capture.stderr.on("data", (bytes: Buffer) => { captureError += bytes.toString(); });
  expect(await new Promise((resolve) => capture.on("close", resolve)), captureError).toBe(0);
  const result = await command(["--bundle", path, "--runtime", resolve("."), "--timeout-ms", "6000", "--out", output]);
  expect(result.code, result.stdout + result.stderr).toBe(0); expect(result.stdout).not.toContain("SYNTHETIC_CLI_PRIVATE_RESULT"); expect(result.stderr).not.toContain("SYNTHETIC_CLI_PRIVATE_RESULT");
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "completed", sandbox: "seccomp_landlock" });
  const reportPath = JSON.parse(result.stdout).report;
  const report = JSON.parse(readFileSync(reportPath, "utf8")); expect(report.isolation).toMatchObject({ socketDenied: true, outsideWriteDenied: true, outsideChmodDenied: true, outsideSignalDenied: true, accountReadDenied: true, environmentCleared: true, scratchExecutableDenied: true });
  expect(statSync(output).mode & 0o777).toBe(0o700); expect(statSync(reportPath).mode & 0o777).toBe(0o600);
}, 30_000);

it("retains the operation deadline report and kills descendants after a real hang", async () => {
  const directory = temporary(); const output = join(directory, "out");
  const path = await syntheticBundle(directory, 'const {spawn}=await import("node:child_process"); const {writeFileSync}=await import("node:fs"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); writeFileSync(process.env.TMPDIR+"/descendant.pid",String(child.pid)); function syntheticReplaySpin(){while(true){Math.sqrt(3)}} syntheticReplaySpin();');
  const result = await command(replayArgs(path, output, 1_500));
  expect(result.code, result.stdout + result.stderr).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ kind: "stopped", reason: "operation_failed" });
  const events = filesIn(output).filter((file) => file.endsWith(".jsonl")).flatMap((file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  expect(events).toContainEqual(expect.objectContaining({ kind: "span.unfinished", data: expect.objectContaining({ reason: "deadline", deadline: "operation", budgetMs: 1_500, active: expect.arrayContaining([expect.objectContaining({ phase: "operation.run" })]) }) }));
  const pidFile = filesIn(output).find((file) => file.endsWith("descendant.pid")); expect(pidFile).toBeDefined();
  const pid = Number(readFileSync(pidFile ?? "missing", "utf8"));
  if (existsSync(`/proc/${pid}/stat`)) expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[0]).toBe("Z");
}, 30_000);

it("records an interrupted outer replay and cleans its process group", async () => {
  const directory = temporary(); const output = join(directory, "out");
  const path = await syntheticBundle(directory, 'const {writeFileSync}=await import("node:fs"); writeFileSync(process.env.TMPDIR+"/operation.pid",String(process.pid)); await new Promise(()=>{});');
  const result = await command(replayArgs(path, output, 10_000), () => filesIn(output).some((file) => file.endsWith("operation.pid")));
  expect(result.code, JSON.stringify(result)).not.toBe(0); const summary = JSON.parse(result.stdout); expect(summary).toMatchObject({ kind: "stopped", reason: "interrupted" });
  expect(JSON.parse(readFileSync(summary.report, "utf8"))).toMatchObject({ kind: "stopped", reason: "interrupted" });
  const pidFile = filesIn(output).find((file) => file.endsWith("operation.pid")); expect(pidFile).toBeDefined();
  const pid = Number(readFileSync(pidFile ?? "missing", "utf8"));
  if (existsSync(`/proc/${pid}/stat`)) expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[0]).toBe("Z");
}, 30_000);

it("refuses runtime mismatch, transcript divergence, incomplete bundles, and symlink paths", async () => {
  const directory = temporary(); const path = await syntheticBundle(directory, 'return "synthetic";');
  const original = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...original, runtime: { ...original.runtime, nodeVersion: "v0.0.0" } }));
  expect(JSON.parse((await command(replayArgs(path, join(directory, "mismatch")))).stdout)).toMatchObject({ kind: "stopped", reason: "runtime_mismatch" });
  writeFileSync(path, JSON.stringify({ ...original, gaps: ["redacted"] }));
  expect(JSON.parse((await command(replayArgs(path, join(directory, "gap")))).stdout)).toMatchObject({ kind: "stopped", reason: "capture_gap" });
  writeFileSync(path, JSON.stringify(original));
  const link = join(directory, "symlink.json"); symlinkSync(path, link);
  expect(JSON.parse((await command(replayArgs(link, join(directory, "symlink-out")))).stdout)).toMatchObject({ kind: "stopped" });
  const divergent = await syntheticBundle(temporary(), 'try{await kernel.browsers.playwright.execute(sessionId,{code:"unexpected"});}catch{} return "caught";', "browser");
  const stopped = JSON.parse((await command(replayArgs(divergent, join(directory, "divergent")))).stdout);
  expect(stopped).toMatchObject({ kind: "stopped", reason: "transcript_mismatch", divergence: { order: 0, expected: "end", actual: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
  expect(JSON.stringify(stopped)).not.toContain("caught");
}, 45_000);
