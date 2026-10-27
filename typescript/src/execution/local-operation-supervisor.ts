import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { Deadline } from "../runtime/deadline.js";
import type { ChildProcess } from "node:child_process";
import type { LocalOperationOptions } from "./local-operation.js";

export const DiagnosticSelection = Schema.Struct({
  depth: Schema.Literal("normal", "debug", "trace", "profile"),
  capture: Schema.Literal("none", "payload", "replay"),
});
export type DiagnosticSelection = typeof DiagnosticSelection.Type;
export const resolveDiagnosticSelection = (value: unknown, defaults: DiagnosticSelection = { depth: "normal", capture: "payload" }): DiagnosticSelection => {
  const overrides = Schema.decodeUnknownSync(Schema.Struct({
    depth: Schema.optional(DiagnosticSelection.fields.depth),
    capture: Schema.optional(DiagnosticSelection.fields.capture),
  }), { onExcessProperty: "error" })(value);
  return { depth: overrides.depth ?? defaults.depth, capture: overrides.capture ?? defaults.capture };
};
export const selectJobDiagnostics = (value: unknown, ceiling: DiagnosticSelection): DiagnosticSelection => {
  const selected = resolveDiagnosticSelection(value, ceiling);
  const permission = { none: 0, payload: 1, replay: 2 };
  return { depth: selected.depth, capture: permission[selected.capture] > permission[ceiling.capture] ? ceiling.capture : selected.capture };
};
export type OperationSnapshot = Pick<LocalOperationOptions, "entrypoint" | "sources" | "input" | "retainedOutput" | "mode" | "validateInput" | "keepDriftedOutput" | "target" | "dispatchAtFirstCall" | "siteOrigin" | "siteDomain" | "list" | "declaredQuestions">;
export interface OperationRecorder {
  readonly id: string;
  readonly selection: DiagnosticSelection;
  readonly event: (kind: string, data: unknown) => void;
  readonly reserveProfile: () => boolean;
  readonly profile: (bytes: Uint8Array) => void;
  readonly request: (request: { readonly code: string; readonly timeout_sec?: number }) => number;
  readonly reply: (order: number, reply: unknown) => void;
  readonly gap: (reason: string) => void;
  readonly finish: () => void;
}
export interface OperationDiagnostics {
  readonly open: (options: LocalOperationOptions) => OperationRecorder;
}
const ChildSpanId = Schema.String.pipe(Schema.pattern(/^child:[1-9][0-9]{0,5}$/u));
const ChildPhase = Schema.Literal("module.import", "schema.input.export", "schema.output.export", "input.decode", "operation.run", "output.validate", "browser.request", "reply.decode", "result.serialize", "result.send");
export const DiagnosticMessage = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("diagnostic"), event: Schema.Literal("start"), id: ChildSpanId, parent: Schema.Literal("operation"), phase: ChildPhase, rpc: Schema.optional(Schema.UUID) }),
  Schema.Struct({ kind: Schema.Literal("diagnostic"), event: Schema.Literal("end"), id: ChildSpanId, outcome: Schema.Literal("ok", "error", "interrupted") }),
  Schema.Struct({ kind: Schema.Literal("diagnostic"), event: Schema.Literal("heartbeat"), sequence: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("inspector"), url: Schema.NullOr(Schema.String.pipe(Schema.maxLength(300))) }),
);
interface Span {
  readonly id: string;
  readonly parent: string;
  readonly actor: "parent" | "child";
  readonly phase: string;
  readonly receivedMs: number;
  readonly rpc?: string;
}
const inspectorBanner = /^(?:Debugger listening on ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+|For help, see: https:\/\/nodejs\.org\/(?:en\/docs\/inspector|learn\/getting-started\/debugging)|Debugger attached\.|Debugger ending on ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+|Waiting for the debugger to disconnect\.\.\.)\r?$/u;
export const withoutInspectorBanner = (line: string) => inspectorBanner.test(line.replace(/\n$/u, "")) ? "" : line;

export const superviseOperation = (sourceRecorder: OperationRecorder, budgetMs: number, deadline: Deadline, inherited?: LocalOperationOptions["inheritedDeadline"]) => {
  const attempt = <A>(work: () => A, fallback: A): A => { try { return work(); } catch { return fallback; } };
  const recorder: OperationRecorder = {
    ...sourceRecorder,
    event: (kind, data) => attempt(() => sourceRecorder.event(kind, data), undefined),
    reserveProfile: () => attempt(sourceRecorder.reserveProfile, false),
    profile: (bytes) => attempt(() => sourceRecorder.profile(bytes), undefined),
    request: (request) => attempt(() => sourceRecorder.request(request), -1),
    reply: (order, reply) => attempt(() => sourceRecorder.reply(order, reply), undefined),
    gap: (reason) => attempt(() => sourceRecorder.gap(reason), undefined),
    finish: () => attempt(sourceRecorder.finish, undefined),
  };
  const started = performance.now();
  const operation = recorder.id;
  const active = new Map<string, Span>();
  const deliveredSpans = new Map<string, Span>();
  const childIds = new Map<string, string>();
  const rpcIds = new Map<string, string>();
  const rpcId = (raw: string) => {
    const key = createHash("sha256").update(raw).digest("hex");
    let id = rpcIds.get(key);
    if (id === undefined) { id = `rpc:${rpcIds.size + 1}`; if (rpcIds.size < 20_000) rpcIds.set(key, id); }
    return id;
  };
  const recent: (Span & { readonly outcome: string })[] = [];
  const pendingRpc = new Set<string>();
  let sequence = 0;
  let heartbeat: { sequence: number; receivedMs: number } | null = null;
  let heartbeatCount = 0;
  let reported = false;
  let ended = false;
  let resultReceived = false;
  let lastProgress = started;
  const sendWaiters = new Set<() => void>();
  let stallCount = 0;
  let spanCount = 0;
  let socket: WebSocket | undefined;
  let sampling = false;
  let profileStopped = false;
  let profileTimer: ReturnType<typeof setTimeout> | undefined;
  let profileStop: Promise<void> | undefined;
  let attached = false;
  let profileStarting = false;
  let shuttingDown = false;
  let inspectorAnnounced = false;
  let childWorkStarted = false;
  const posts = new Map<number, { resolve: (value: unknown) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>();
  let postId = 0;
  const event = recorder.event;
  const gapReasons = new Set<string>();
  const gap = (reason: string) => {
    if (gapReasons.has(reason)) return;
    gapReasons.add(reason); event("diagnostic.gap", { operation, reason });
  };
  const end = (id: string, outcome = "ok") => {
    const span = active.get(id) ?? deliveredSpans.get(id); if (span === undefined) return;
    active.delete(id); deliveredSpans.delete(id);
    if (span.phase === "result.send") for (const resolve of sendWaiters) resolve();
    recent.push({ ...span, outcome }); if (recent.length > 5) recent.shift(); lastProgress = performance.now();
    event("span.end", { operation, id, outcome, elapsedMs: performance.now() - span.receivedMs });
  };
  const begin = (phase: string, rpc?: string) => {
    const id = `parent:${++sequence}`;
    if (recorder.selection.depth === "normal") return id;
    if (active.size >= 256 || ++spanCount > 20_000) { gap("span_cap"); return id; }
    const span: Span = { id, parent: operation, actor: "parent", phase, receivedMs: performance.now(), ...(rpc === undefined ? {} : { rpc: rpcId(rpc) }) };
    active.set(id, span); event("span.start", { ...span, operation }); return id;
  };
  const post = (method: string, params: object = {}, timeoutMs = 1_000) => new Promise<unknown>((resolve, reject) => {
    if (socket === undefined) { reject(new Error("inspector_unavailable")); return; }
    const id = ++postId;
    const timer = setTimeout(() => { posts.delete(id); reject(new Error("inspector_unavailable")); }, timeoutMs);
    posts.set(id, { resolve, reject: () => reject(new Error("inspector_unavailable")), timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const startProfile = async () => {
    if (shuttingDown || sampling || profileStarting || !attached) return;
    if (!recorder.reserveProfile()) return;
    profileStarting = true;
    try {
      await post("Profiler.start"); sampling = true; profileStopped = false;
      profileTimer = setTimeout(() => { void stopProfile(); }, 2_000);
    } catch { attached = false; socket?.close(); gap("inspector_unavailable"); }
    finally { profileStarting = false; }
  };
  const stopProfile = (): Promise<void> => {
    if (profileStop !== undefined) return profileStop;
    profileStop = (async () => {
      clearTimeout(profileTimer);
      if (sampling && !profileStopped) {
        profileStopped = true;
        try {
          const result = await post("Profiler.stop", {}, 250);
          const parsed = Schema.decodeUnknownSync(Schema.Struct({ profile: Schema.Unknown }))(result);
          const bytes = Buffer.from(JSON.stringify(parsed.profile));
          if (bytes.length > 16 * 1024 * 1024) gap("profile_bytes");
          else recorder.profile(bytes);
        } catch { attached = false; socket?.close(); gap("inspector_unavailable"); }
        finally { sampling = false; lastProgress = performance.now(); }
      }
    })().finally(() => {
      profileStop = undefined;
      if (!shuttingDown && pendingRpc.size === 0 && [...active.values()].some((span) => span.phase === "operation.run")) void startProfile();
    });
    return profileStop;
  };
  const closeInspector = async () => {
    shuttingDown = true;
    await stopProfile(); socket?.close();
    for (const pending of posts.values()) { clearTimeout(pending.timer); pending.reject(); } posts.clear();
  };
  const attach = async (url: string | null, child: ChildProcess) => {
    try {
      if (url === null) throw new Error("inspector_unavailable");
      const endpoint = new URL(url);
      if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !/^\/[0-9a-f-]+$/u.test(endpoint.pathname)) throw new Error("inspector_unavailable");
      socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket?.close(); reject(new Error("inspector_unavailable")); }, 750);
        socket?.addEventListener("open", () => { clearTimeout(timer); if (shuttingDown) { socket?.close(); reject(new Error("inspector_unavailable")); } else resolve(); }, { once: true });
        socket?.addEventListener("error", () => { clearTimeout(timer); socket?.close(); reject(new Error("inspector_unavailable")); }, { once: true });
      });
      socket.addEventListener("message", (message) => {
        try {
          if (typeof message.data !== "string" || Buffer.byteLength(message.data) > 16 * 1024 * 1024) { gap("profile_bytes"); socket?.close(); return; }
          const response = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.optional(Schema.Int), result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Unknown) }))(JSON.parse(message.data));
          if (response.id === undefined) return;
          const pending = posts.get(response.id); if (pending === undefined) return;
          posts.delete(response.id); clearTimeout(pending.timer);
          if (response.error !== undefined) pending.reject(); else pending.resolve(response.result);
        } catch { socket?.close(); }
      });
      await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 1_000 });
      attached = true; await startProfile();
    } catch { gap("inspector_unavailable"); socket?.close(); }
    finally {
      if (child.connected) { try { child.send({ kind: "diagnostic.ready" }, () => {}); } catch {} }
    }
  };
  const watchdog = recorder.selection.depth === "normal" ? undefined : setInterval(() => {
    if (ended || performance.now() - lastProgress < 1_000) return;
    lastProgress = performance.now();
    if (pendingRpc.size === 0 && recorder.selection.depth === "profile") void startProfile();
    if (stallCount++ < 8) event("operation.stall", { operation, pendingRpc: [...pendingRpc], active: [...active.values()], heartbeat });
  }, 250);
  const beforeKill = (reason: "deadline" | "interrupted" | "error" | "child_exit", firedDeadline?: "operation" | "child.operation") => Effect.promise(async () => {
    if (!reported && (!resultReceived || active.size > 0) && recorder.selection.depth !== "normal") {
      reported = true; const now = performance.now();
      event("span.unfinished", { operation, reason, deadline: reason === "deadline" ? firedDeadline ?? "operation" : reason === "interrupted" && inherited !== undefined && inherited.remainingMs() <= 0 ? inherited.name : null, budgetMs, operationRemainingMs: deadline.remainingMs(), inheritedDeadline: inherited === undefined ? null : { name: inherited.name, budgetMs: inherited.budgetMs, remainingMs: inherited.remainingMs() }, elapsedMs: now - started,
        activeCount: active.size, active: [...active.values()].slice(0, 50).map((span) => ({ ...span, ageMs: now - span.receivedMs, remainingBudgetMs: deadline.remainingMs() })), pendingRpc: [...pendingRpc].slice(0, 50), recent,
        heartbeat, heartbeatAgeMs: heartbeat === null ? null : now - heartbeat.receivedMs,
        delivery: resultReceived ? "parent_received" : recent.some((span) => span.phase === "result.send" && span.outcome === "ok") ? "child_send_completed_parent_not_received" : [...active.values()].some((span) => span.phase === "result.send") ? "child_send_pending" : "child_not_sent" });
    }
    await closeInspector();
  });
  return {
    recorder, begin, end,
    processStarted: (pid: number | undefined) => { if (recorder.selection.depth !== "normal") event("operation.child", { operation, pid }); },
    awaitSendCompletion: () => Effect.promise(() => new Promise<void>((resolve) => {
      if (![...active.values(), ...deliveredSpans.values()].some((span) => span.phase === "result.send")) { resolve(); return; }
      const finish = () => { clearTimeout(timer); sendWaiters.delete(finish); resolve(); };
      const timer = setTimeout(() => { gap("result_send_completion_unobserved"); finish(); }, Math.min(100, deadline.remainingMs()));
      sendWaiters.add(finish);
    })),
    effect: <A, E, R>(phase: string, work: Effect.Effect<A, E, R>) => Effect.suspend(() => { const id = begin(phase); return work.pipe(Effect.onExit((exit) => Effect.sync(() => end(id, exit._tag === "Success" ? "ok" : "error")))); }),
    accept: (raw: unknown, child: ChildProcess) => {
      const parsed = Schema.decodeUnknownOption(DiagnosticMessage)(raw); if (parsed._tag === "None") {
        if (typeof raw === "object" && raw !== null && ["diagnostic", "inspector"].includes(String(Reflect.get(raw, "kind")))) { gap("malformed_diagnostic"); return true; }
        return false;
      }
      const message = parsed.value;
      if (message.kind === "inspector") { if (!inspectorAnnounced && !shuttingDown && !childWorkStarted && recorder.selection.depth === "profile") { inspectorAnnounced = true; void attach(message.url, child); } return true; }
      if (recorder.selection.depth === "normal") return true;
      if (message.event === "heartbeat") { heartbeat = { sequence: ++heartbeatCount, receivedMs: performance.now() }; return true; }
      lastProgress = performance.now();
      if (message.event === "end") { const id = childIds.get(message.id); if (id !== undefined) end(id, message.outcome); return true; }
      childWorkStarted = true;
      if (active.size >= 256 || ++spanCount > 20_000) { gap("span_cap"); return true; }
      const id = childIds.get(message.id) ?? `child:${childIds.size + 1}`;
      childIds.set(message.id, id);
      const span: Span = { id, parent: operation, actor: "child", phase: message.phase, receivedMs: performance.now(), ...(message.rpc === undefined ? {} : { rpc: rpcId(message.rpc) }) };
      active.set(id, span); event("span.start", { ...span, operation }); return true;
    },
    beforeReply: () => recorder.selection.depth === "profile" ? Effect.promise(startProfile) : Effect.void,
    request: (id: string) => { pendingRpc.add(rpcId(id)); },
    reply: (id: string) => { pendingRpc.delete(rpcId(id)); },
    received: () => {
      resultReceived = true;
      for (const span of [...active.values()]) if (span.phase === "result.send") {
        active.delete(span.id);
        deliveredSpans.set(span.id, span);
      }
      for (const resolve of sendWaiters) resolve();
      const id = begin("parent.receipt"); end(id);
    },
    beforeKill,
    stopInspector: () => Effect.promise(closeInspector),
    close: () => Effect.promise(async () => { ended = true; clearInterval(watchdog); await closeInspector(); recorder.finish(); }),
  };
};
export type OperationSupervisor = ReturnType<typeof superviseOperation>;
