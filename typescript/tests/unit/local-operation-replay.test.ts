import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { runLocalOperation, type LocalOperationOptions } from "../../src/execution/local-operation.js";
import { encodeReplayValue, readReplayBundle, replayLocalOperation, requestDigest, ReplayBundle } from "../../src/execution/local-operation-replay.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { openJobTrace } from "../../src/standalone/job-trace.js";
const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "pomerado-replay-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const entrypoint = "src/tool.mjs";
const source = `import { Schema } from "effect"; import { defineOperation } from "../runtime/index.js";
export default defineOperation({input:Schema.Struct({}),output:Schema.Unknown}, async({kernel,sessionId})=>(await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5})).result);`;
export const captureSynthetic = async () => {
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "trace", capture: "replay" } });
  try { await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source]], input: {}, timeoutMs: 6_000, browser: { sessionId: "synthetic", executeResponse: () => Effect.succeed({ success: true, result: "SYNTHETIC_PRIVATE_REPLAY_RESULT" }) }, diagnostics: trace.operations });
  }))); } finally { trace.close(); }
  const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".replay.json")) ?? "missing");
  return { path, bundle: readReplayBundle(path) };
};
it("reuses the operation runner and rejects ordered transcript divergence", async () => {
  const { bundle } = await captureSynthetic();
  const run = (changed = false) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    const request = { code: "return changed();", timeout_sec: 5 };
    return yield* replayLocalOperation({ bundle: changed ? { ...bundle, exchanges: bundle.exchanges.map((exchange) => ({ ...exchange, digest: requestDigest(request), request: encodeReplayValue(request) })) } : bundle, workspace, timeoutMs: 6_000 });
  })));
  expect(await run()).toMatchObject({ kind: "completed", output: { output: "SYNTHETIC_PRIVATE_REPLAY_RESULT" } });
  expect(await run(true)).toMatchObject({ kind: "stopped", reason: "transcript_mismatch", divergence: { order: 0, expected: requestDigest({ code: "return changed();", timeout_sec: 5 }), actual: expect.any(String) } });
}, 25_000);
it("rejects incomplete captures and exact runtime mismatches before running", async () => {
  const { path, bundle } = await captureSynthetic();
  const invalid = join(temporary(), "invalid.json");
  writeFileSync(invalid, JSON.stringify({ ...bundle, gaps: ["redacted"] }), { mode: 0o600 });
  expect(() => readReplayBundle(invalid)).toThrow("capture_gap");
  writeFileSync(invalid, JSON.stringify({ ...bundle, runtime: { ...bundle.runtime, nodeVersion: "v0.0.0" } }));
  const mismatch = readReplayBundle(invalid);
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* replayLocalOperation({ bundle: mismatch, workspace, timeoutMs: 6_000 }); })));
  expect(result).toMatchObject({ kind: "stopped", reason: "runtime_mismatch" });
  expect(readFileSync(path, "utf8")).not.toContain("SYNTHETIC_PRIVATE_REPLAY_RESULT");
}, 20_000);

it("retains the first mismatch and stops even when authored code catches it", async () => {
  const { bundle } = await captureSynthetic();
  const { encodeReplayValue } = await import("../../src/execution/local-operation-replay.js");
  const catching = source.replace('async({kernel,sessionId})=>(await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5})).result', 'async({kernel,sessionId})=>{try{await kernel.browsers.playwright.execute(sessionId,{code:"return changed();",timeout_sec:5});}catch{} try{await kernel.browsers.playwright.execute(sessionId,{code:"return changedAgain();",timeout_sec:5});}catch{} return "caught";}');
  const changed = { ...bundle, snapshot: encodeReplayValue({ entrypoint, sources: [[entrypoint, catching]], input: {}, target: "browser" }) };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* replayLocalOperation({ bundle: changed, workspace, timeoutMs: 6_000 }); })));
  expect(result).toMatchObject({ kind: "stopped", reason: "transcript_mismatch", divergence: { order: 0, expected: bundle.exchanges[0]?.digest } });
}, 15_000);
it("refuses a malformed reply even when authored code catches browser failures", async () => {
  const { bundle } = await captureSynthetic();
  const { encodeReplayValue } = await import("../../src/execution/local-operation-replay.js");
  const catching = source.replace('async({kernel,sessionId})=>(await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5})).result', 'async({kernel,sessionId})=>{try{return (await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5})).result;}catch{return "caught";}}');
  const changed = { ...bundle, snapshot: encodeReplayValue({ entrypoint, sources: [[entrypoint, catching]], input: {}, target: "browser" }), exchanges: bundle.exchanges.map((exchange) => ({ ...exchange, reply: encodeReplayValue({ kind: "reply", value: { success: "bad" } }) })) };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* replayLocalOperation({ bundle: changed, workspace, timeoutMs: 6_000 }); })));
  expect(result).toMatchObject({ kind: "stopped", reason: "capture_gap" });
}, 15_000);

it("rejects registered credential strings in byte-array encodings", () => {
  const secret = "SYNTHETIC_BINARY_CREDENTIAL";
  const redact = (value: string) => value.replaceAll(secret, "[private]");
  for (const encoding of ["utf8", "utf16le"] as const) expect(() => encodeReplayValue(new Uint8Array(Buffer.from(secret, encoding)), redact)).toThrow("redacted");
});

it("replays a caught pureFiles browser denial exactly", async () => {
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "trace", capture: "replay" } });
  const denied = source.replace('async({kernel,sessionId})=>(await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5})).result', 'async({kernel,sessionId})=>{try{await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5});return "unexpected";}catch(error){return error.message;}}');
  let original;
  try {
    original = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace();
      return yield* runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, denied]], input: {}, target: "pureFiles", timeoutMs: 6_000, diagnostics: trace.operations });
    })));
  } finally { trace.close(); }
  expect(original.output).toBe("Browser access is unavailable for this local operation mode");
  const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".replay.json")) ?? "missing");
  const bundle = readReplayBundle(path);
  expect(bundle.exchanges).toHaveLength(1);
  const replay = (value: ReplayBundle, diagnostics?: LocalOperationOptions["diagnostics"]) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* replayLocalOperation({ bundle: value, workspace, timeoutMs: 6_000, ...(diagnostics === undefined ? {} : { diagnostics }) });
  })));
  expect(await replay(bundle)).toMatchObject({ kind: "completed", output: { output: original.output } });
  const fail = () => { throw new Error("Synthetic diagnostic callback failure"); };
  expect(await replay(bundle, { open: fail })).toMatchObject({ kind: "completed", output: { output: original.output } });
  expect(await replay(bundle, { open: () => ({ id: randomUUID(), selection: { depth: "normal", capture: "none" }, event: fail, reserveProfile: fail, profile: fail, request: fail, reply: fail, gap: fail, finish: fail }) })).toMatchObject({ kind: "completed", output: { output: original.output } });
  const request = { code: "return changed();", timeout_sec: 5 };
  expect(await replay({ ...bundle, exchanges: bundle.exchanges.map((exchange) => ({ ...exchange, request: encodeReplayValue(request), digest: requestDigest(request) })) })).toMatchObject({ kind: "stopped", reason: "transcript_mismatch" });
  expect(await replay({ ...bundle, exchanges: bundle.exchanges.map((exchange) => ({ ...exchange, reply: encodeReplayValue({ kind: "reply", value: { success: true, result: "unexpected" } }) })) })).toMatchObject({ kind: "stopped", reason: "capture_gap" });
}, 25_000);

it.each(["password", "authorization", "auth", "api_key", "access-token", "refresh_token", "credentials", "headers", "requestHeaders", "cookies", "session_cookies"])("refuses unregistered replay credential field %s", (key) => {
  expect(() => encodeReplayValue({ nested: [{ [key]: "SYNTHETIC_UNREGISTERED_CREDENTIAL" }] })).toThrow("credential_field");
});

it.each(["snapshot", "reply"])("marks credential fields in the replay %s as a capture gap", async (location) => {
  const directory = temporary(); const trace = openJobTrace(directory, randomUUID(), { selection: { depth: "trace", capture: "replay" } });
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace();
      const recorder = trace.operations.open({ workspace, entrypoint, sources: [[entrypoint, source]], input: location === "snapshot" ? { password: "SYNTHETIC_UNREGISTERED_CREDENTIAL" } : {} });
      const order = recorder.request({ code: "return synthetic();" });
      recorder.reply(order, { kind: "reply", value: { success: true, result: location === "reply" ? { headers: { arbitrary: "SYNTHETIC_UNREGISTERED_CREDENTIAL" } } : {} } });
      recorder.finish();
    })));
  } finally { trace.close(); }
  const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".replay.json")) ?? "missing");
  const bundle = Schema.decodeUnknownSync(ReplayBundle)(JSON.parse(readFileSync(path, "utf8")));
  expect(bundle.gaps).toContain("credential_field");
  expect(() => readReplayBundle(path)).toThrow("capture_gap");
  const text = Buffer.from(location === "snapshot" ? bundle.snapshot : bundle.exchanges[0]?.reply ?? "", "base64").toString("utf8");
  expect(text).not.toContain("SYNTHETIC_UNREGISTERED_CREDENTIAL");
});

it("stops at unsupported capabilities even when the operation could catch their refusal", async () => {
  const { bundle } = await captureSynthetic();
  const unsupported = source.replace('async({kernel,sessionId})=>(await kernel.browsers.playwright.execute(sessionId,{code:"return synthetic();",timeout_sec:5})).result', 'async()=>{const {randomUUID}=await import("node:crypto"); process.send({kind:"sign_in",id:randomUUID()}); await new Promise(()=>{});}');
  const changed = { ...bundle, snapshot: encodeReplayValue({ entrypoint, sources: [[entrypoint, unsupported]], input: {}, target: "browser" }), exchanges: [] };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const workspace = yield* createLocalWorkspace(); return yield* replayLocalOperation({ bundle: changed, workspace, timeoutMs: 6_000 }); })));
  expect(result).toEqual({ kind: "stopped", reason: "unsupported_capability" });
}, 15_000);
