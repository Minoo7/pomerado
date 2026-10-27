import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess } from "node:child_process";
import { deserialize } from "node:v8";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { resolveDiagnosticSelection, superviseOperation } from "../../src/execution/local-operation-supervisor.js";
import { readReplayBundle } from "../../src/execution/local-operation-replay.js";
import { createLocalProcess } from "../../src/execution/local-process.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { openJobTrace, validateTraceDirectory } from "../../src/standalone/job-trace.js";

const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "pomerado-diagnostics-")); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const entrypoint = "src/tool.mjs";
const source = (body: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({input:Schema.Struct({}),output:Schema.Unknown}, async ({kernel,sessionId})=>{${body}});`;

describe("diagnostic selection", () => {
  it("keeps directory-only payload capture and parses depth independently", () => {
    expect(resolveDiagnosticSelection({})).toEqual({ depth: "normal", capture: "payload" });
    expect(resolveDiagnosticSelection({ depth: "profile", capture: "none" })).toEqual({ depth: "profile", capture: "none" });
    expect(() => resolveDiagnosticSelection({ depth: "verbose" })).toThrow();
    expect(() => resolveDiagnosticSelection({ capture: "all", surprise: true })).toThrow();
  });
  it("does not inspect or retain metadata-only payloads", () => {
    const directory = temporary(); const id = randomUUID();
    const trace = openJobTrace(directory, id, { selection: { depth: "trace", capture: "none" } });
    const payload = new Proxy({}, { ownKeys() { throw new Error("payload traversed"); }, get() { throw new Error("payload read"); } });
    trace.event("model.result", payload); trace.close();
    expect(readFileSync(join(directory, `${id}.jsonl`), "utf8")).toContain('"traceCapture":"disabled"');
    expect(readdirSync(directory)).toEqual([`${id}.jsonl`]);
  });
});

describe("actual child supervision", { timeout: 25_000 }, () => {
  describe.each([undefined, "normal", "debug", "trace", "profile"] as const)("result getters at depth %s", (depth) => {
    it.each([false, true])("delivers the second getter value when a third read throws %s", async (throwOnThird) => {
      const trace = depth === undefined ? undefined : openJobTrace(temporary(), randomUUID(), { selection: { depth, capture: "none" } });
      try {
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint,
            sources: [[entrypoint, source(`let reads = 0;
return { get read() {
  if (++reads === 3 && ${throwOnThird}) throw new Error("Unexpected third result getter read");
  return reads;
} };`)]],
            input: {},
            target: "pureFiles",
            timeoutMs: 6_000,
            ...(trace === undefined ? {} : { diagnostics: trace.operations }),
          });
        })));
        expect(result.output).toEqual({ read: 2 });
      } finally {
        trace?.close();
      }
    });
  });

  for (const depth of ["normal", "debug", "trace", "profile"] as const) it(`preserves a large browser result at ${depth}`, async () => {
    const directory = temporary(); const id = randomUUID();
    const trace = openJobTrace(directory, id, { selection: { depth, capture: "none" } });
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source('return (await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();"})).result;')]], input: {}, timeoutMs: 6_000, browser: { sessionId: "synthetic", executeResponse: () => Effect.succeed({ success: true, result: "x".repeat(433_070) }) }, diagnostics: trace.operations });
      })));
      expect(result.output).toBe("x".repeat(433_070)); expect(result.stderr).not.toContain("Debugger");
    } finally { trace.close(); }
    const text = readFileSync(join(directory, `${id}.jsonl`), "utf8");
    expect(text).not.toContain("x".repeat(100));
    if (depth !== "normal") for (const phase of ["module.import", "schema.input.export", "input.decode", "operation.run", "browser.request", "reply.decode", "output.validate", "result.serialize", "result.send", "parent.receipt", "cleanup"]) expect(text).toContain(phase);
  });
  for (const body of ['function syntheticSpin(){while(true){Math.sqrt(17)}} syntheticSpin();', 'await new Promise(()=>{});']) it(`profiles and reports the unfinished authored run ${body.slice(0, 8)}`, async () => {
    const directory = temporary(); const id = randomUUID();
    const trace = openJobTrace(directory, id, { selection: { depth: "profile", capture: "payload" } });
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* Effect.either(runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source(body)]], input: {}, target: "pureFiles", timeoutMs: 3_000, diagnostics: trace.operations }));
      })));
      expect(result._tag).toBe("Left");
    } finally { trace.close(); }
    const text = readFileSync(join(directory, `${id}.jsonl`), "utf8");
    expect(text).toContain('"kind":"span.unfinished"'); expect(text).toContain('"deadline":"operation"'); expect(text).toContain('"budgetMs":3000'); expect(text).toContain("heartbeat"); expect(text).toContain("operation.run");
    const artifacts = readdirSync(directory).filter((name) => name.endsWith(".cpuprofile")); expect(artifacts.length).toBeGreaterThan(0); expect(artifacts.length).toBeLessThanOrEqual(5);
    const profiles = artifacts.map((file) => { const path = join(directory, file); expect(statSync(path).mode & 0o777).toBe(0o600); return JSON.parse(readFileSync(path, "utf8")); });
    expect(profiles.some((profile) => profile.samples.length > 0)).toBe(true);
    if (body.startsWith("function")) expect(profiles.some((profile) => profile.nodes.some((node: {callFrame:{functionName:string}}) => node.callFrame.functionName === "syntheticSpin"))).toBe(true);
  });
  it("snapshots before outer interruption and closes its child", async () => {
    const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id, { selection: { depth: "trace", capture: "none" } });
    const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source("await new Promise(()=>{});")]], input: {}, timeoutMs: 10_000, diagnostics: trace.operations }); })));
    try { await new Promise((resolve) => setTimeout(resolve, 1_000)); await Effect.runPromise(Fiber.interrupt(fiber)); } finally { trace.close(); }
    const text = readFileSync(join(directory, `${id}.jsonl`), "utf8"); expect(text).toContain('"reason":"interrupted"'); expect(text).toContain('"phase":"cleanup"');
  });
});

it("captures a late synchronous spin after a slow large browser reply", async () => {
  const directory = temporary(); const id = randomUUID();
  const trace = openJobTrace(directory, id, { selection: { depth: "profile", capture: "none" } });
  try { await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* Effect.either(runLocalOperation({ workspace, entrypoint, input: {}, sources: [[entrypoint, source('await kernel.browsers.playwright.execute(sessionId,{code:"return slowSynthetic();"}); await new Promise(resolve=>setTimeout(resolve,2500)); function syntheticLateSpin(){while(true){Math.sqrt(21)}} syntheticLateSpin();')]], browser: { sessionId: "synthetic", executeResponse: () => Effect.sleep(9_500).pipe(Effect.as({ success: true, result: "x".repeat(433_070) })) }, timeoutMs: 16_500, diagnostics: trace.operations }));
  }))); } finally { trace.close(); }
  const artifacts = readdirSync(directory).filter((name) => name.endsWith(".cpuprofile"));
  expect(artifacts.length).toBeGreaterThan(1); expect(artifacts.length).toBeLessThanOrEqual(5);
  expect(artifacts.some((name) => JSON.parse(readFileSync(join(directory, name), "utf8")).nodes.some((node: {callFrame:{functionName:string}}) => node.callFrame.functionName === "syntheticLateSpin"))).toBe(true);
}, 25_000);

it("keeps contiguous written sequences and a terminal reserve at the byte cap", () => {
  const directory = temporary(); const id = randomUUID();
  const trace = openJobTrace(directory, id, { jobBytes: 4_096 });
  trace.event("payload", "x".repeat(5_000)); trace.event("payload", "y".repeat(5_000)); trace.event("job.end", { done: true }); trace.close();
  const events = readFileSync(join(directory, `${id}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
  expect(events.filter((event) => event.kind === "diagnostic.gap")).toEqual([expect.objectContaining({ data: { reason: "job_cap" } })]);
  expect(events.at(-1)).toMatchObject({ kind: "job.end" });
});

it("keeps six operation receipts equal with diagnostics off and at each depth", async () => {
  const cases = [
    { body: 'return { value: "synthetic" };', input: {} },
    { body: 'throw new Error("synthetic failure");', input: {} },
    { body: 'return "x".repeat(1024*1024);', input: {} },
    { body: 'return { $file: { id: "missing", name: "synthetic", media_type: "text/plain", size: 0, sha256: "0".repeat(64) } };', input: {} },
    { body: 'return "synthetic";', input: "invalid input" },
    { body: 'return "synthetic";', input: {}, contract: true },
  ];
  const run = async (test: typeof cases[number], depth?: "normal" | "debug" | "trace" | "profile") => {
    const trace = depth === undefined ? undefined : openJobTrace(temporary(), randomUUID(), { selection: { depth, capture: "none" } });
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* Effect.either(runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source(test.body)]], input: test.input, target: "pureFiles", timeoutMs: 6_000, ...(test.contract === true ? { mode: "contract" } : {}), ...(trace === undefined ? {} : { diagnostics: trace.operations }) })); })));
      return result._tag === "Right" ? { ...result, right: { ...result.right, stderr: result.right.stderr.replace(/\(node:\d+\)/gu, "(node:<pid>)") } } : { _tag: result._tag, message: result.left.message, ...("journal" in result.left ? { journal: result.left.journal } : {}), ...("reported" in result.left ? { reported: result.left.reported } : {}) };
    } finally { trace?.close(); }
  };
  for (const test of cases) {
    const baseline = await run(test);
    for (const depth of ["normal", "debug", "trace", "profile"] as const) expect(await run(test, depth)).toEqual(baseline);
  }
}, 60_000);

for (const phase of ["module.import", "input.decode", "output.validate"] as const) it(`names a synchronous hang in ${phase}`, async () => {
  const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id, { selection: { depth: "debug", capture: "none" } });
  const prefix = 'import {Schema} from "effect"; import {defineOperation} from "../runtime/index.js";';
  const spin = '()=>{while(true){Math.sqrt(3)}}';
  const code = phase === "module.import" ? `${prefix} while(true){Math.sqrt(3)}` : `${prefix} const hang=Schema.Unknown.pipe(Schema.filter(${spin},{jsonSchema:{}})); export default defineOperation({input:${phase === "input.decode" ? "hang" : "Schema.Unknown"},output:${phase === "output.validate" ? "hang" : "Schema.Unknown"}},async()=>({}));`;
  try { await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* Effect.either(runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, code]], input: {}, timeoutMs: 2_000, diagnostics: trace.operations })); }))); } finally { trace.close(); }
  const text = readFileSync(join(directory, `${id}.jsonl`), "utf8"); const unfinished = text.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.kind === "span.unfinished");
  expect(unfinished.data.active, text).toContainEqual(expect.objectContaining({ phase }));
}, 8_000);

it("keeps a job.end reserve after a flood of span endings", () => {
  const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id, { jobBytes: 4_096 });
  for (let index = 0; index < 100; index++) trace.event("span.end", { id: index, outcome: "ok" });
  trace.event("job.end", { done: true }); trace.close();
  const events = readFileSync(join(directory, `${id}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ kind: "job.end" });
});
it("never treats authored deadline prose as a fired deadline or stores forged child metadata", async () => {
  const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id, { selection: { depth: "trace", capture: "none" } });
  try { await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* Effect.either(runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source('process.send({kind:"diagnostic",event:"start",id:"SYNTHETIC_FORGED_PRIVATE",parent:"SYNTHETIC_FORGED_PRIVATE",phase:"SYNTHETIC_FORGED_PRIVATE",rpc:"SYNTHETIC_FORGED_PRIVATE"}); process.send({kind:"error",error:"authored deadline expired",code:"DeadlineExceeded",effect:"not_started",commits:[]}); await new Promise(()=>{});')]], input: {}, timeoutMs: 6_000, diagnostics: trace.operations })); }))); } finally { trace.close(); }
  const text = readFileSync(join(directory, `${id}.jsonl`), "utf8"); expect(text).not.toContain("SYNTHETIC_FORGED_PRIVATE");
  const report = text.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.kind === "span.unfinished");
  expect(report).toBeDefined(); expect(report.data.reason).toBe("error"); expect(report.data.deadline).toBeNull();
});

it("preserves the receipt when diagnostic callbacks fail", async () => {
  const fail = () => { throw new Error("synthetic diagnostic failure"); };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source('return (await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();"})).result;')]], input: {}, timeoutMs: 2_000,
      browser: { sessionId: "synthetic", executeResponse: () => Effect.succeed({ success: true, result: "ok" }) },
      diagnostics: { open: () => ({ id: randomUUID(), selection: { depth: "debug", capture: "none" }, event: fail, request: fail, reply: fail, gap: fail, reserveProfile: fail, profile: fail, finish: fail }) },
    });
  })));
  expect(result.output).toBe("ok");
}, 8_000);

it("captures concurrent browser replies in actual delivery order", async () => {
  class DelayedStart extends WebSocket {
    private starts = 0;
    override send(data: Parameters<WebSocket["send"]>[0]) {
      if (typeof data === "string" && JSON.parse(data).method === "Profiler.start" && ++this.starts === 2) { setTimeout(() => super.send(data), 100); return; }
      super.send(data);
    }
  }
  vi.stubGlobal("WebSocket", DelayedStart);
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "profile", capture: "replay" } });
  let observed: unknown;
  try { observed = (await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source('const order=[]; await Promise.all(["first","second"].map(async name=>{const reply=await kernel.browsers.playwright.execute(sessionId,{code:name}); order.push(reply.result);}));return order;')]], input: {}, timeoutMs: 6_000,
      browser: { sessionId: "synthetic", executeResponse: (code) => Effect.sleep(code === "first" ? 2_500 : 2_520).pipe(Effect.as({ success: true, result: code })) }, diagnostics: trace.operations });
  })))).output; } finally { trace.close(); vi.unstubAllGlobals(); }
  const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".replay.json")) ?? "missing");
  const bundle = readReplayBundle(path);
  const captured = [...bundle.exchanges].sort((a, b) => a.delivery - b.delivery).map((exchange) => deserialize(Buffer.from(exchange.reply, "base64")).value.result);
  expect(observed).toEqual(["second", "first"]);
  expect(captured).toEqual(observed);
}, 12_000);

it("uses one startup inspector announcement and retires send spans after any terminal receipt", async () => {
  const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id, { selection: { depth: "profile", capture: "none" } });
  const recorder = await Effect.runPromise(Effect.scoped(createLocalWorkspace().pipe(Effect.map((workspace) => trace.operations.open({ workspace, entrypoint, sources: [], input: {} })))));
  const supervisor = superviseOperation(recorder, 1_000, Deadline.after(1_000));
  const child = new ChildProcess();
  try {
    supervisor.accept({ kind: "inspector", url: "invalid" }, child);
    supervisor.accept({ kind: "inspector", url: "invalid" }, child);
    supervisor.accept({ kind: "diagnostic", event: "start", id: "child:1", parent: "operation", phase: "result.send" }, child);
    supervisor.received();
    supervisor.begin("host.output.check");
    await Effect.runPromise(supervisor.beforeKill("error"));
  } finally { await Effect.runPromise(supervisor.close()); trace.close(); }
  const events = readFileSync(join(directory, `${id}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.filter((event) => event.data?.reason === "inspector_unavailable")).toHaveLength(1);
  const report = events.find((event) => event.kind === "span.unfinished");
  expect(report.data.delivery).toBe("parent_received");
  expect(report.data.active).not.toContainEqual(expect.objectContaining({ phase: "result.send" }));
});

it("disables inspector discovery and preserves ordinary stderr", async () => {
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "profile", capture: "none" } });
  try {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace();
      return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source('const inspector=await import("node:inspector"); const endpoint=new URL(inspector.url()); const reply=await fetch("http://"+endpoint.host+"/json/list"); process.stderr.write("synthetic ordinary stderr\\n"); return reply.status;')]], input: {}, target: "pureFiles", timeoutMs: 5_000, diagnostics: trace.operations });
    })));
    expect(result.output).toBe(404); expect(result.stderr).toContain("synthetic ordinary stderr\n"); expect(result.stderr).not.toContain("Debugger"); expect(result.stderr).not.toContain("For help");
  } finally { trace.close(); }
}, 10_000);

it("ignores the ambient offline marker for live process lifecycle", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const child = yield* createLocalProcess({ command: process.execPath, args: ["-e", 'const fs=require("node:fs"); const group=Number(fs.readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ")[2]); process.stdout.write(JSON.stringify({pid:process.pid,group}));'], cwd: temporary(), environment: { POMERADO_OFFLINE_REPLAY: "1" } });
    const channels = yield* child.result;
    return { pid: child.child.pid, stdout: channels.stdout };
  })));
  expect(JSON.parse(result.stdout)).toEqual({ pid: result.pid, group: result.pid });
});

it("redacts registered secrets in profile strings and refuses credential bytes for replay", async () => {
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "profile", capture: "replay" } });
  trace.secrets.register("SYNTHETIC_PROFILE_CREDENTIAL");
  const recorder = await Effect.runPromise(Effect.scoped(createLocalWorkspace().pipe(Effect.map((workspace) => trace.operations.open({ workspace, entrypoint, sources: [], input: new Uint8Array(Buffer.from("SYNTHETIC_PROFILE_CREDENTIAL")) })))));
  recorder.profile(Buffer.from(JSON.stringify({ nodes: [{ id: 1, callFrame: { functionName: "SYNTHETIC_PROFILE_CREDENTIAL", url: "SYNTHETIC_PROFILE_CREDENTIAL", scriptId: "1", lineNumber: 0, columnNumber: 0 } }], startTime: 0, endTime: 1, samples: [1], timeDeltas: [1] })));
  recorder.finish(); trace.close();
  const profilePath = join(directory, readdirSync(directory).find((name) => name.endsWith(".cpuprofile")) ?? "missing");
  const profile = JSON.parse(readFileSync(profilePath, "utf8")); expect(profile.nodes[0].callFrame.functionName).toBe("[private]"); expect(profile.samples).toEqual([1]);
  const bundlePath = join(directory, readdirSync(directory).find((name) => name.endsWith(".replay.json")) ?? "missing");
  expect(() => readReplayBundle(bundlePath)).toThrow("capture_gap");
});

it("rejects symlinked private parents before creating anything behind them", () => {
  const directory = temporary(); const outside = join(directory, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(directory, "linked"));
  expect(() => validateTraceDirectory(join(directory, "linked", "new"))).toThrow();
  expect(existsSync(join(outside, "new"))).toBe(false);
});

it("preserves legacy event payloads larger than one MiB", () => {
  const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id);
  const value = "x".repeat(1024 * 1024 + 1); trace.event("legacy.payload", { value }); trace.close();
  const event = JSON.parse(readFileSync(join(directory, `${id}.jsonl`), "utf8")); expect(event.data).toEqual({ value });
});

it("screens replay values against secrets registered after their capture", async () => {
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "trace", capture: "replay" } });
  const recorder = await Effect.runPromise(Effect.scoped(createLocalWorkspace().pipe(Effect.map((workspace) => trace.operations.open({ workspace, entrypoint, sources: [], input: "SYNTHETIC_LATER_CREDENTIAL" })))));
  trace.secrets.register("SYNTHETIC_LATER_CREDENTIAL"); recorder.finish(); trace.close();
  const file = join(directory, readdirSync(directory).find((name) => name.endsWith(".replay.json")) ?? "missing");
  const bundle = JSON.parse(readFileSync(file, "utf8")); expect(bundle.snapshot).toBe(""); expect(bundle.gaps).toContain("redacted_or_invalid");
});

it("bounds aggregate replay capture before writing its artifact", async () => {
  const directory = temporary(); const id = randomUUID(); const trace = openJobTrace(directory, id, { selection: { depth: "trace", capture: "replay" } });
  const recorder = await Effect.runPromise(Effect.scoped(createLocalWorkspace().pipe(Effect.map((workspace) => trace.operations.open({ workspace, entrypoint, sources: [], input: {} })))));
  const request = { code: "x".repeat(1024 * 1024) };
  for (let index = 0; index < 40; index++) { const order = recorder.request(request); recorder.reply(order, { kind: "reply", value: { success: true, result: null } }); }
  recorder.finish(); trace.close();
  const file = readdirSync(directory).find((name) => name.endsWith(".replay.json"));
  if (file !== undefined) { const bundle = JSON.parse(readFileSync(join(directory, file), "utf8")); expect(bundle.gaps).toContain("job_capture_cap"); expect(bundle.exchanges.length).toBeLessThan(40); }
  else expect(readFileSync(join(directory, `${id}.jsonl`), "utf8")).toContain("replay_write_failed");
});
