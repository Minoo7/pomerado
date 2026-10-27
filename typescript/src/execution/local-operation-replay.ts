import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { isDeepStrictEqual, types } from "node:util";
import { Deferred, Effect, Schema } from "effect";
import { ListDraft } from "../runtime/list-page.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { BrowserExecuteResponse } from "../runtime/browser-execution.js";
import { traceValue } from "../privacy/trace-value.js";
import { assertNoSymlinkComponents } from "./local-path.js";
import { runLocalOperation, type LocalOperationOptions } from "./local-operation.js";
import type { LocalWorkspace } from "./local-workspace.js";
import type { OperationRecorder, OperationSnapshot } from "./local-operation-supervisor.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const Hash = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const Blob = Schema.String.pipe(Schema.maxLength(24 * 1024 * 1024), Schema.pattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u));
export const RuntimeIdentity = Schema.Struct({ nodeVersion: Schema.String, nodeSha256: Hash, packageVersion: Schema.String, distributionSha256: Hash, dependencyLockSha256: Hash });
export const ReplayBundle = Schema.Struct({
  version: Schema.Literal(1), operation: Schema.UUID, runtime: RuntimeIdentity, snapshot: Blob,
  exchanges: Schema.Array(Schema.Struct({ order: Schema.Int.pipe(Schema.nonNegative()), digest: Hash, request: Blob, reply: Blob, delivery: Schema.Int.pipe(Schema.nonNegative()) })).pipe(Schema.maxItems(4096)),
  gaps: Schema.Array(Schema.String.pipe(Schema.maxLength(100))).pipe(Schema.maxItems(100)),
});
export type ReplayBundle = typeof ReplayBundle.Type;
export const runtimeRoot = () => {
  let root = dirname(fileURLToPath(import.meta.url));
  for (let count = 0; count < 8; count++) {
    try { if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "pomerado") return root; } catch {}
    root = dirname(root);
  }
  throw new Error("runtime_mismatch");
};
let identity: typeof RuntimeIdentity.Type | undefined;
export const runtimeIdentity = () => {
  if (identity !== undefined) return identity;
  const root = runtimeRoot();
  const source = join(root, import.meta.url.endsWith(".ts") ? "typescript/src" : "dist/typescript/src");
  const hash = createHash("sha256");
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) { hash.update(relative(source, target)); hash.update(readFileSync(target)); }
      else throw new Error("runtime_mismatch");
    }
  };
  walk(source);
  let lock: string;
  try { lock = readFileSync(join(root, "dist/dependency-lock.sha256"), "utf8").trim(); }
  catch { lock = digest(readFileSync(join(root, "pnpm-lock.yaml"))); }
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  identity = Schema.decodeUnknownSync(RuntimeIdentity)({ nodeVersion: process.version, nodeSha256: digest(readFileSync(process.execPath)), packageVersion: manifest.version, distributionSha256: hash.digest("hex"), dependencyLockSha256: lock });
  return identity;
};
export const encodeReplayValue = (value: unknown, redact: (text: string) => string = (text) => text) => {
  let nodes = 0; let bytes = 0; const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 64) throw new Error("value_cap");
    if (typeof item === "string") { bytes += Buffer.byteLength(item); if (redact(item) !== item) throw new Error("redacted"); }
    else if (item === null || item === undefined || typeof item === "boolean") return;
    else if (typeof item === "number" && Number.isFinite(item)) return;
    else if (typeof item === "object") {
      if (types.isProxy(item) || seen.has(item)) throw new Error("unsafe");
      seen.add(item);
      if (item instanceof Uint8Array) {
        bytes += item.byteLength;
        const buffer = Buffer.from(item);
        for (const encoding of ["utf8", "utf16le", "latin1", "base64"] as const) {
          const text = buffer.toString(encoding); if (redact(text) !== text) throw new Error("redacted");
        }
      }
      else {
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("unsafe");
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
          if (!("value" in descriptor)) throw new Error("unsafe");
          if (redact(key) !== key) throw new Error("redacted");
          const screened = traceValue({ [key]: null }, (text) => text);
          if (typeof screened === "object" && screened !== null && !Object.hasOwn(screened, key)) throw new Error("credential_field");
          visit(descriptor.value, depth + 1);
        }
      }
      seen.delete(item);
    } else throw new Error("unsafe");
    if (bytes > 16 * 1024 * 1024) throw new Error("item_cap");
  };
  visit(value, 0); const buffer = serialize(value); if (buffer.length > 16 * 1024 * 1024) throw new Error("item_cap");
  const text = buffer.toString("utf8");
  if (redact(text) !== text || redact(buffer.toString("base64")) !== buffer.toString("base64")) throw new Error("redacted");
  return buffer.toString("base64");
};
export const requestDigest = (request: { readonly code: string; readonly timeout_sec?: number }) => digest(JSON.stringify([request.code, request.timeout_sec ?? null]));
export const operationSnapshot = (options: LocalOperationOptions): OperationSnapshot => ({
  entrypoint: options.entrypoint, sources: options.sources,
  ...(options.input === undefined ? {} : { input: options.input }),
  ...(options.retainedOutput === undefined ? {} : { retainedOutput: options.retainedOutput }),
  ...(options.mode === undefined ? {} : { mode: options.mode }),
  ...(options.validateInput === undefined ? {} : { validateInput: options.validateInput }),
  ...(options.keepDriftedOutput === undefined ? {} : { keepDriftedOutput: options.keepDriftedOutput }),
  target: options.target ?? (options.browser === undefined ? "pureFiles" : "browser"),
  ...(options.dispatchAtFirstCall === undefined ? {} : { dispatchAtFirstCall: options.dispatchAtFirstCall }),
  ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
  ...(options.siteDomain === undefined ? {} : { siteDomain: options.siteDomain }),
  ...(options.list === undefined ? {} : { list: options.list }),
  ...(options.declaredQuestions === undefined ? {} : { declaredQuestions: options.declaredQuestions }),
});
const Snapshot = Schema.Struct({
  entrypoint: Schema.String, sources: Schema.Array(Schema.Tuple(Schema.String, Schema.String)).pipe(Schema.maxItems(4096)),
  list: Schema.optionalWith(Schema.Struct({ position: Schema.optionalWith(ListDraft, { exact: true }) }), { exact: true }),
  declaredQuestions: Schema.optionalWith(ScriptQuestionDeclarations, { exact: true }),
  input: Schema.optionalWith(Schema.Unknown, { exact: true }), retainedOutput: Schema.optionalWith(Schema.Struct({ value: Schema.Unknown }), { exact: true }),
  mode: Schema.optionalWith(Schema.Literal("run", "contract"), { exact: true }), validateInput: Schema.optionalWith(Schema.Boolean, { exact: true }), keepDriftedOutput: Schema.optionalWith(Schema.Boolean, { exact: true }), target: Schema.optionalWith(Schema.Literal("browser", "pureFiles"), { exact: true }), dispatchAtFirstCall: Schema.optionalWith(Schema.Boolean, { exact: true }), siteOrigin: Schema.optionalWith(Schema.String, { exact: true }), siteDomain: Schema.optionalWith(Schema.String, { exact: true }),
});
export const readReplayBundle = (path: string): ReplayBundle => {
  const fd = openSync(assertNoSymlinkComponents(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32 * 1024 * 1024) throw new Error("unsafe_bundle");
    const bundle = Schema.decodeUnknownSync(ReplayBundle, { onExcessProperty: "error" })(JSON.parse(readFileSync(fd, "utf8")));
    if (bundle.gaps.length > 0) throw new Error(bundle.gaps.includes("unsupported_capability") ? "unsupported_capability" : "capture_gap");
    for (const [order, exchange] of bundle.exchanges.entries()) {
      if (exchange.order !== order || !bundle.exchanges.some((entry) => entry.delivery === order)) throw new Error("capture_gap");
    }
    return bundle;
  } finally { closeSync(fd); }
};
export type ReplayReport = { readonly kind: "completed"; readonly output: Awaited<Effect.Effect.Success<ReturnType<typeof runLocalOperation>>> } | { readonly kind: "stopped"; readonly reason: "runtime_mismatch" | "transcript_mismatch" | "capture_gap" | "operation_failed" | "unsupported_capability"; readonly divergence?: { readonly order: number; readonly expected: string; readonly actual: string } };
export const replayLocalOperation = (args: { readonly bundle: ReplayBundle; readonly workspace: LocalWorkspace; readonly timeoutMs: number; readonly ready?: Effect.Effect<void>; readonly processLifecycle?: LocalOperationOptions["processLifecycle"]; readonly diagnostics?: LocalOperationOptions["diagnostics"] }): Effect.Effect<ReplayReport, Error> => Effect.gen(function* () {
  if (JSON.stringify(args.bundle.runtime) !== JSON.stringify(runtimeIdentity())) return { kind: "stopped", reason: "runtime_mismatch" };
  if (args.bundle.gaps.length > 0) return { kind: "stopped", reason: args.bundle.gaps.includes("unsupported_capability") ? "unsupported_capability" : "capture_gap" };
  const requestsValid = Schema.decodeUnknownEither(Schema.Array(Schema.Struct({ code: Schema.String, timeout_sec: Schema.optionalWith(Schema.Number, { exact: true }) })))(args.bundle.exchanges.map((exchange) => {
    try { return deserialize(Buffer.from(exchange.request, "base64")); } catch { return null; }
  }));
  if (requestsValid._tag === "Left" || requestsValid.right.some((request, order) => requestDigest(request) !== args.bundle.exchanges[order]?.digest)) return { kind: "stopped", reason: "capture_gap" };
  const decoded = yield* Effect.try({ try: () => Schema.decodeUnknownSync(Snapshot, { onExcessProperty: "error" })(deserialize(Buffer.from(args.bundle.snapshot, "base64"))), catch: () => new Error("capture_gap") });
  const Reply = Schema.Union(Schema.Struct({ kind: Schema.Literal("reply"), value: BrowserExecuteResponse }), Schema.Struct({ kind: Schema.Literal("failure"), error: Schema.String, code: Schema.optionalWith(Schema.String, { exact: true }) }));
  const replies = Schema.decodeUnknownEither(Schema.Array(Reply))(args.bundle.exchanges.map((exchange) => {
    try { return deserialize(Buffer.from(exchange.reply, "base64")); } catch { return null; }
  }));
  if (replies._tag === "Left") return { kind: "stopped", reason: "capture_gap" };
  const stopped = yield* Deferred.make<ReplayReport>();
  let next = 0; let delivery = 0;
  let divergence: Extract<ReplayReport, { kind: "stopped" }>["divergence"];
  const waiting = new Map<number, () => void>();
  const deliver = () => { const ready = waiting.get(delivery); if (ready !== undefined) { waiting.delete(delivery++); ready(); queueMicrotask(deliver); } };
  const browserDenied = decoded.target === "pureFiles" || decoded.mode === "contract";
  const matchRequest = (request: { readonly code: string; readonly timeout_sec?: number }) => {
    const order = next++; const expected = args.bundle.exchanges[order]; const actual = requestDigest(request);
    if (expected === undefined || expected.digest !== actual) { divergence ??= { order, expected: expected?.digest ?? "end", actual }; Effect.runSync(Deferred.succeed(stopped, { kind: "stopped", reason: "transcript_mismatch", divergence })); }
    return order;
  };
  yield* args.ready ?? Effect.void;
  const result = yield* runLocalOperation({
    ...decoded, workspace: args.workspace, timeoutMs: args.timeoutMs,
    diagnostics: { open: (options) => {
      let recorder: OperationRecorder = {
        id: args.bundle.operation, selection: { depth: "normal", capture: "none" }, event: () => {}, reserveProfile: () => false, profile: () => {}, request: () => -1, reply: () => {}, gap: () => {}, finish: () => {},
      };
      try { recorder = args.diagnostics?.open(options) ?? recorder; } catch {}
      const captureOrders = new Map<number, number>();
      return { ...recorder, ...(browserDenied ? {
        request: (request: { readonly code: string; readonly timeout_sec?: number }) => {
          const order = matchRequest(request);
          try { captureOrders.set(order, recorder.request(request)); } catch {}
          return order;
        },
        reply: (order: number, reply: unknown) => {
          if (args.bundle.exchanges[order]?.delivery !== delivery++ || !isDeepStrictEqual(reply, replies.right[order])) Effect.runSync(Deferred.succeed(stopped, { kind: "stopped", reason: "capture_gap" }));
          recorder.reply(captureOrders.get(order) ?? -1, reply); captureOrders.delete(order);
        },
      } : {}), gap: (reason) => {
        if (reason === "unsupported_capability") Effect.runSync(Deferred.succeed(stopped, { kind: "stopped", reason: "unsupported_capability" }));
        recorder.gap(reason);
      } };
    } },
    ...(args.processLifecycle === undefined ? {} : { processLifecycle: args.processLifecycle }),
    ...(browserDenied ? {} : { browser: { sessionId: "offline-replay", executeResponse: (code: string, timeout_sec?: number) => Effect.async((resume) => {
      const order = matchRequest({ code, ...(timeout_sec === undefined ? {} : { timeout_sec }) }); const expected = args.bundle.exchanges[order];
      if (divergence !== undefined || expected === undefined) { resume(Effect.fail(new Error("transcript_mismatch"))); return; }
      waiting.set(expected.delivery, () => {
        try {
          const reply = replies.right[order];
          if (reply === undefined) throw new Error("capture_gap");
          if (reply.kind === "failure") resume(Effect.fail(Object.assign(new Error(reply.error), { code: reply.code })));
          else {
            const value = Schema.decodeUnknownSync(BrowserExecuteResponse)(reply.value);
            resume(Effect.succeed(value));
          }
        } catch { Effect.runSync(Deferred.succeed(stopped, { kind: "stopped", reason: "capture_gap" })); resume(Effect.fail(new Error("capture_gap"))); }
      }); deliver();
      return Effect.sync(() => { waiting.delete(expected.delivery); });
    }) } }),
  }).pipe(Effect.either, Effect.map((result) => ({ kind: "operation" as const, result })), Effect.raceFirst(Deferred.await(stopped)));
  if (result.kind !== "operation") return result;
  if (divergence !== undefined) return { kind: "stopped", reason: "transcript_mismatch", divergence };
  if (next !== args.bundle.exchanges.length) return { kind: "stopped", reason: "transcript_mismatch", divergence: { order: next, expected: args.bundle.exchanges[next]?.digest ?? "end", actual: "end" } };
  return result.result._tag === "Right" ? { kind: "completed", output: result.result.right } : { kind: "stopped", reason: "operation_failed" };
});
