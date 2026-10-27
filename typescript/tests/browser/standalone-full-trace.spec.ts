import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, copyFileSync, chmodSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { makePomeradoMcp } from "pomerado/mcp";
import {
  call,
  execution,
  executionIdOf,
  html,
  message,
  objects,
  patch,
  quietReviewer,
  recordingGuardian,
  scripted,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";

const record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const privateHeading = "SYNTHETIC_FULL_TRACE_PRIVATE_HEADING";
const privateStdout = "SYNTHETIC_FULL_TRACE_STDOUT";
const privateStderr = "SYNTHETIC_FULL_TRACE_STDERR";
const errorPrefix = "SYNTHETIC_FULL_TRACE_UNKNOWN_ERROR";
const errorText = `${errorPrefix} ${privateHeading}`;
const childCause = "SYNTHETIC_FULL_TRACE_CHILD_CAUSE";
const childDeepCause = "SYNTHETIC_FULL_TRACE_DEEP_CAUSE";
const secretAnswer = "SYNTHETIC_FULL_TRACE_REGISTERED_SECRET";
const entrypoint = "src/full-trace.mjs";
const command = `printf '%s\\n' '${privateStdout}'; printf '%s\\n' '${privateStderr}' >&2; exit 7`;
const authoredSource = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"full_trace_fixture",input:Schema.Struct({}),output:Schema.Unknown},
async ({kernel,sessionId,errors}) => {
  const heading = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if (!heading.success || heading.result !== ${JSON.stringify(privateHeading)}) throw new Error("Fixture heading was not read");
  throw Object.assign(new errors.OperationFailure(${JSON.stringify(errorPrefix)} + " " + heading.result), {code:undefined,_tag:undefined,cause:new Error(${JSON.stringify(childCause)},{cause:new Error(${JSON.stringify(childDeepCause)})})});
});`;

const containsText = (value: unknown, text: string) =>
  objects(value).some((object) =>
    Object.values(object).some((field) => typeof field === "string" && field.includes(text)),
  );

const withTraceFixture = async (
  run: (fixture: { readonly traceDir: string; readonly site: Awaited<ReturnType<typeof startSite>> }) => Promise<void>,
) => {
  const temporaryDir = await mkdtemp(join(tmpdir(), "pomerado-full-trace-"));
  const traceDir = join(temporaryDir, "private-trace");
  const previous = process.env["POMERADO_TRACE_DIR"];
  process.env["POMERADO_TRACE_DIR"] = traceDir;
  try {
    const site = await startSite((_request, response) =>
      html(response, `<title>Full trace fixture</title><h1>${privateHeading}</h1>`),
    );
    try {
      await run({ traceDir, site });
    } finally {
      await site.close();
    }
  } finally {
    if (previous === undefined) delete process.env["POMERADO_TRACE_DIR"];
    else process.env["POMERADO_TRACE_DIR"] = previous;
    await rm(temporaryDir, { recursive: true, force: true });
  }
};

const finishedMint = async (url: string, turns: readonly ModelResponse["output"][], configuration: { readonly traceDirectory?: string; readonly answerSecret?: boolean; readonly diagnostics?: { readonly depth: "normal" | "debug" | "trace" | "profile"; readonly capture: "none" | "payload" | "replay" } } = {}) => {
  const requests: ModelRequest[] = [];
  const guardian = recordingGuardian();
  const guardianRequests: ModelRequest[] = [];
  const guardianProvider = { getModel: async (name?: string) => {
    const model = await guardian.provider.getModel(name);
    return { ...model, getResponse: (request: ModelRequest) => { guardianRequests.push(request); return model.getResponse(request); } };
  } };
  const minter = scripted(
    (_request, index) => turns[index] ?? [message("Stopped after the synthetic failure.")],
    requests,
  );
  const { jobId, response } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makePomeradoMcp({
          pomerado: {
            minterProvider: minter,
            guardianProvider,
            outcomeReviewerProvider: quietReviewer,
            timeoutMs: 60_000,
          },
          ...(configuration.traceDirectory === undefined ? {} : { traceDirectory: configuration.traceDirectory }),
          prepare: () => Effect.succeed(() => Effect.dieMessage("A failing build must not publish")),
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        const client = new Client({ name: "full-trace-fixture", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        const started = yield* Effect.promise(() => client.callTool({
          name: "mint",
          arguments: {
            name: "full_trace_fixture",
            url,
            intent: "Read the synthetic fixture heading",
            effect: "read",
            ...(configuration.diagnostics === undefined ? {} : { diagnostics: configuration.diagnostics }),
          },
        }));
        expect(started.isError).not.toBe(true);
        const { job_id: jobId } = Schema.decodeUnknownSync(Schema.Struct({ job_id: Schema.UUID }))(
          started.structuredContent,
        );
        const directory = configuration.traceDirectory ?? process.env["POMERADO_TRACE_DIR"];
        if (directory !== undefined) {
          const path = join(directory, `${jobId}.jsonl`);
          expect(existsSync(path)).toBe(true);
          expect(readFileSync(path, "utf8")).toContain("job.start");
          expect(readFileSync(path, "utf8")).not.toContain("job.end");
        }
        for (let attempt = 0; attempt < 12; attempt++) {
          const response = yield* Effect.promise(() => client.callTool({
            name: "get_job",
            arguments: { job_id: jobId, wait_seconds: 5 },
          }));
          expect(response.isError).not.toBe(true);
          const view = Schema.decodeUnknownSync(record)(response.structuredContent);
          if (view["status"] === "completed") return { jobId, response };
          if (configuration.answerSecret === true && view["status"] === "input_required") {
            const pending = Schema.decodeUnknownSync(record)(view["pending_input"]);
            yield* Effect.promise(() => client.callTool({ name: "provide_input", arguments: { job_id: jobId, request_id: pending["id"], answers: { code: secretAnswer } } }));
            continue;
          }
          expect(view["status"], JSON.stringify(response)).toBe("running");
        }
        throw new Error("Scripted full-trace fixture did not complete within 60 seconds");
      }),
    ),
  );
  const view = Schema.decodeUnknownSync(record)(response.structuredContent);
  const output = Schema.decodeUnknownSync(record)(view["output"]);
  expect(output).toMatchObject({
    build: "incomplete",
    executionSummary: { total: 1, failed: 1, completed: 0 },
  });
  const publicText = JSON.stringify(response);
  for (const privateText of [privateHeading, privateStdout, privateStderr, errorPrefix, authoredSource, command, childCause, childDeepCause, secretAnswer])
    expect(publicText).not.toContain(privateText);
  return { jobId, output, requests, guardianRequests };
};

const traceEvents = async (traceDir: string, jobId: string) => {
  const path = join(traceDir, `${jobId}.jsonl`);
  expect(existsSync(path), "POMERADO_TRACE_DIR must contain the MCP job's private JSONL after client and session cleanup").toBe(true);
  expect((await stat(traceDir)).mode & 0o777, "The logger must create its private trace directory with mode 0700").toBe(0o700);
  expect((await stat(path)).mode & 0o777, "The logger must create its private trace file with mode 0600").toBe(0o600);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const events = lines.map((line) => Schema.decodeUnknownSync(Schema.parseJson(record))(line));
  expect(events.length, "A full trace must contain chronological execution events").toBeGreaterThan(1);
  expect(events.at(-1)).toMatchObject({ kind: "job.end", job: jobId });
  expect(events.map((event) => event["seq"])).toEqual(events.map((_event, index) => index + 1));
  const roots = events.filter((event) => event["kind"] === "workspace.start").map((event) => Schema.decodeUnknownSync(record)(event["data"])["root"]);
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) {
    expect(typeof root).toBe("string");
    if (typeof root === "string") expect(existsSync(root)).toBe(false);
  }
  return events;
};

test("private full trace retains a failed command and both output streams after MCP cleanup", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const callId = "full_trace_failed_command";
    const { jobId, output, requests } = await finishedMint(site.url, [
      [call("exec_command", { cmd: command }, callId)],
    ]);
    const receipt = toolResult(requests.at(-1), callId);
    const executionId = executionIdOf(requests.at(-1), callId);
    expect(receipt).toMatchObject({ status: "failed" });
    expect(objects(receipt?.["observations"])).toContainEqual(expect.objectContaining({
      exitCode: 7,
      stdout: `${privateStdout}\n`,
      stderr: `${privateStderr}\n`,
    }));
    expect(output["failedExecutions"]).toEqual([{
      executionId, purpose: "command", effect: "not_sent", source: "command", exitCode: 7,
    }]);

    const events = await traceEvents(traceDir, jobId);
    const commandIndex = events.findIndex((event) => containsText(event, command));
    expect(commandIndex, "The private trace must retain the full command").toBeGreaterThanOrEqual(0);
    const resultIndex = events.findIndex((event) =>
      containsText(event, executionId) && objects(event).some((object) =>
        object["exitCode"] === 7 && object["stdout"] === `${privateStdout}\n` && object["stderr"] === `${privateStderr}\n`,
      ),
    );
    expect(resultIndex, "The private trace must retain the actual command receipt with stdout, stderr, exit 7, and execution ID").toBeGreaterThanOrEqual(0);
    expect(commandIndex, "The command must precede its returned output in the trace").toBeLessThan(resultIndex);
  });
});

test("private full trace retains an unknown-code browser failure and authored context while MCP stays finite", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const callId = "full_trace_failed_browser";
    const { jobId, output, requests } = await finishedMint(site.url, [
      patch({ [entrypoint]: authoredSource }),
      [call("execute", execution("example", entrypoint), callId)],
    ]);
    const receipt = toolResult(requests.at(-1), callId);
    const executionId = executionIdOf(requests.at(-1), callId);
    expect(receipt).toMatchObject({ status: "failed" });
    expect(objects(receipt?.["observations"])).toContainEqual(expect.objectContaining({ message: errorText }));
    for (const privateDetail of [childCause, childDeepCause]) expect(JSON.stringify(receipt)).not.toContain(privateDetail);
    expect(objects(receipt).some((object) => "stack" in object || "cause" in object || "privateDetail" in object)).toBe(false);
    expect(site.requests).toContain("GET /");
    expect(output["failedExecutions"]).toEqual([{
      executionId, purpose: "example", effect: "possible", source: "script", code: "unknown",
    }]);

    const events = await traceEvents(traceDir, jobId);
    const sourceIndex = events.findIndex((event) => containsText(event, authoredSource));
    expect(sourceIndex, "The private trace must retain the complete authored source").toBeGreaterThanOrEqual(0);
    const errorIndex = events.findIndex((event) =>
      containsText(event, executionId) && objects(event).some((object) =>
        object["message"] === errorText || object["error"] === errorText,
      ),
    );
    expect(errorIndex, "The private trace must retain the runtime Error message in an actual error or receipt payload with its execution ID").toBeGreaterThanOrEqual(0);
    expect(sourceIndex, "Authored source must precede the failed execution receipt in the trace").toBeLessThan(errorIndex);
    const childError = events.find((event) => event["kind"] === "operation.child.error");
    expect(childError).toBeDefined();
    expect(containsText(childError, childCause)).toBe(true);
    expect(containsText(childError, childDeepCause)).toBe(true);
    expect(objects(childError).some((object) => typeof object["stack"] === "string" && object["stack"].includes(childCause))).toBe(true);
    expect(objects(childError).some((object) => typeof object["frame"] === "string" && object["frame"].startsWith(entrypoint + ":"))).toBe(true);
    expect(events.some((event) => event["kind"] === "tool.result" && containsText(event, "apply_patch"))).toBe(true);
    const saved = `/tmp/pomerado-full-trace-implementation-synthetic-${jobId}.jsonl`;
    copyFileSync(join(traceDir, `${jobId}.jsonl`), saved);
    chmodSync(saved, 0o600);
    console.log("Saved synthetic private trace", saved);
    expect(events.some((event) => containsText(event, executionId) && containsText(event, entrypoint)),
      "The private trace must correlate the execution ID with its authored entrypoint").toBe(true);
  });
});


test("trace preserves model requests and MCP output, with secret answers kept private", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const turns = [
      [call("request_input", { intent: "Ask for the synthetic private code", questions: [{ id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" }] }, "ask_private")],
      [call("exec_command", { cmd: command }, "equality_command")],
    ];
    const traced = await finishedMint(site.url, turns, { traceDirectory: traceDir, answerSecret: true });
    const text = readFileSync(join(traceDir, `${traced.jobId}.jsonl`), "utf8");
    expect(text).not.toContain(secretAnswer);
    expect(text).toContain("input.answered");
    const previous = process.env["POMERADO_TRACE_DIR"];
    delete process.env["POMERADO_TRACE_DIR"];
    let untraced;
    try { untraced = await finishedMint(site.url, turns, { answerSecret: true }); }
    finally { if (previous !== undefined) process.env["POMERADO_TRACE_DIR"] = previous; }
    expect(existsSync(join(traceDir, `${untraced.jobId}.jsonl`))).toBe(false);
    const normalized = (value: unknown) => JSON.stringify(value)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, "<time>")
      .replace(/(wallTimeSeconds\\*":)[0-9.e+-]+/gu, "$1<duration>");
    const hash = (value: unknown) => createHash("sha256").update(normalized(value)).digest("hex");
    expect(hash(traced.requests), "Actual provider requests must match after normalizing generated IDs, timestamps and command wall time").toBe(hash(untraced.requests));
    expect(hash(traced.guardianRequests), "Actual Guardian requests must match under tracing").toBe(hash(untraced.guardianRequests));
    expect(normalized(traced.output)).toBe(normalized(untraced.output));
    const events = await traceEvents(traceDir, traced.jobId);
    expect(events.some((event) => event["kind"] === "guardian.decision.result")).toBe(true);
  });
});


test("per-job diagnostic depth and capture stay independent in the built MCP", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const { jobId } = await finishedMint(site.url, [
      patch({ [entrypoint]: authoredSource }),
      [call("execute", execution("example", entrypoint), "selected_failure")],
    ], { diagnostics: { depth: "profile", capture: "none" } });
    const text = readFileSync(join(traceDir, `${jobId}.jsonl`), "utf8");
    for (const privateText of [privateHeading, authoredSource, childCause, childDeepCause]) expect(text).not.toContain(privateText);
    expect(text).toContain("module.import"); expect(text).toContain("result.send"); expect(text).toContain('"traceCapture":"disabled"');
    expect(text).not.toContain("Debugger listening");
  });
});

test("the operator capture ceiling blocks caller replay escalation", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const before = process.env["POMERADO_TRACE_CAPTURE"]; process.env["POMERADO_TRACE_CAPTURE"] = "none";
    try {
      const { jobId } = await finishedMint(site.url, [[call("exec_command", { cmd: command }, "capture_ceiling")]], { diagnostics: { depth: "trace", capture: "replay" } });
      const text = readFileSync(join(traceDir, `${jobId}.jsonl`), "utf8");
      expect(text).not.toContain(command); expect(text).not.toContain(privateStdout); expect(text).toContain('"traceCapture":"disabled"');
    } finally { if (before === undefined) delete process.env["POMERADO_TRACE_CAPTURE"]; else process.env["POMERADO_TRACE_CAPTURE"] = before; }
  });
});

test("profile diagnostics keep actual stdio stdout limited to JSON-RPC", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const turns = [patch({ [entrypoint]: authoredSource }), [call("execute", execution("example", entrypoint), "stdio_profile")]];
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {registerHooks} from 'node:module'; import {existsSync} from 'node:fs'; import {fileURLToPath} from 'node:url';
      registerHooks({resolve:(specifier,context,next)=>{if(context.parentURL?.endsWith('.ts')&&specifier.endsWith('.js')){const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(fileURLToPath(source)))return next(source.href,context);}return next(specifier,context);}});
      import {startMcpCli} from './dist/typescript/src/standalone/mcp-cli.js';
      const {scripted,recordingGuardian,quietReviewer,message}=await import('./typescript/tests/browser/guardian-context-fixture.ts');
      const turns=${JSON.stringify(turns)};
      startMcpCli(['mint'],{minterProvider:scripted((_request,index)=>turns[index]??[message('Synthetic stopped')]),guardianProvider:recordingGuardian().provider,outcomeReviewerProvider:quietReviewer,timeoutMs:60000});
    `], { env: { PATH: process.env["PATH"] ?? "", POMERADO_TRACE_DIR: traceDir, POMERADO_TRACE_CAPTURE: "none" }, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const lines: string[] = []; const invalid: string[] = [];
    const waiting = new Map<number, (value: unknown) => void>();
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      lines.push(line);
      try {
        const parsed = Schema.decodeUnknownSync(Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.optional(Schema.Number), result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Unknown) }))(JSON.parse(line));
        if (parsed.id !== undefined) { waiting.get(parsed.id)?.(parsed); waiting.delete(parsed.id); }
      } catch { invalid.push(line); }
    });
    let next = 0;
    const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { reject(new Error(stderr)); return; }
      const id = ++next; const exit = () => { clearTimeout(timer); waiting.delete(id); reject(new Error(stderr)); };
      const timer = setTimeout(() => { child.off("exit", exit); waiting.delete(id); reject(new Error(`Synthetic MCP request timed out. ${stderr}`)); }, 65_000);
      child.once("exit", exit);
      waiting.set(id, (value) => { clearTimeout(timer); child.off("exit", exit); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    try {
      await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-profile-stdio", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const started = await request("tools/call", { name: "mint", arguments: { name: "synthetic_stdio", url: site.url, intent: "Read synthetic heading", effect: "read", diagnostics: { depth: "profile", capture: "none" } } });
      const job = objects(started).find((value) => typeof value["job_id"] === "string")?.["job_id"];
      expect(typeof job).toBe("string");
      let complete = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await request("tools/call", { name: "get_job", arguments: { job_id: job, wait_seconds: 5 } });
        const view = objects(response).find((value) => typeof value["status"] === "string");
        if (view?.["status"] === "completed") { complete = true; break; }
      }
      expect(complete, stderr).toBe(true); expect(invalid).toEqual([]); expect(lines.length).toBeGreaterThan(2);
      const stdout = lines.join("\n"); expect(stdout).not.toContain(privateHeading); expect(stdout).not.toContain(childCause); expect(stdout).not.toContain("Debugger");
      expect(stderr).not.toContain("Debugger listening");
      const text = readFileSync(join(traceDir, `${job}.jsonl`), "utf8"); expect(text).toContain("module.import"); expect(text).not.toContain(privateHeading);
    } finally {
      child.stdin.end(); child.kill("SIGTERM"); reader.close();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await closed; clearTimeout(timeout);
    }
  });
});
