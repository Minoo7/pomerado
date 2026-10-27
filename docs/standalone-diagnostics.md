# Standalone diagnostics and offline replay

Standalone MCP hosts can write private diagnostics for one job. Configure a directory owned by the host user with mode `0700`.

```sh
install -d -m 700 /private/pomerado-traces
POMERADO_TRACE_DIR=/private/pomerado-traces pomerado-mcp mint
```

A directory alone preserves the existing event payloads at `normal` depth. Trace files use `<job-id>.jsonl` with mode `0600`. No trace directory means diagnostics are off. Configuration errors stop host setup before a job starts.

The mint operator can set defaults with `POMERADO_TRACE_DEPTH` and `POMERADO_TRACE_CAPTURE`. Library hosts accept `traceDirectory` and `diagnostics`. Explicit library settings override environment defaults. Published integration hosts require an explicit `traceDirectory` or `diagnostics` option. Ambient environment variables alone do not enable integration tracing.

Depth and payload permission are independent.

| Setting | Behavior |
| --- | --- |
| `depth: "normal"` | Existing private events, without phase telemetry or inspector attachment. |
| `depth: "debug"` | Operation spans, unfinished reports, RPC correlation, and heartbeat observations. |
| `depth: "trace"` | Includes child and IPC boundaries. Currently debug records the same boundaries. |
| `depth: "profile"` | Trace plus bounded CPU profiles of the actual child. |
| `capture: "none"` | Metadata only. Payload events carry a disabled marker. The writer does not traverse those payloads. |
| `capture: "payload"` | Existing registered-secret redaction and credential exclusions. This is the compatibility default. |
| `capture: "replay"` | Payload events plus a private operation bundle when exact capture is possible. |

When the operator configured a directory, the mint and integration MCP schemas expose an optional `diagnostics` sibling beside business input.

```json
{
  "name": "example_reader",
  "url": "https://example.test",
  "intent": "Read records",
  "effect": "read",
  "diagnostics": { "depth": "profile", "capture": "none" }
}
```

For an enabled published integration, send `{"input":{},"diagnostics":{"depth":"trace","capture":"replay"}}`. Caller capture is limited by the operator's setting in the order `none < payload < replay`. A caller can lower capture but cannot raise that permission. Depth can change independently. The envelope does not enter business input or the idempotency fingerprint. MCP job receipts contain no artifact paths, stacks, captured source, or private diagnostic fields.

Spans carry operation IDs, actor-local span IDs, and RPC IDs. Parent receive times measure observed ages. An unfinished report names the deadline and budget, open phases, pending RPCs, the last five completed spans, and the last heartbeat observation. A missing heartbeat is an observation, not proof of a cause. An inherited mint deadline appears separately from the operation deadline.

Profiles use a private IPC handshake and a loopback inspector on an ephemeral port before authored import. HTTP inspector discovery is disabled. The parent removes exact Node inspector banners from captured stderr and preserves other stderr. Attachment never calls `waitForDebugger`. The inspector URL is a private capability with a random identifier, but another local process that obtains that URL can attach while it remains open. This feature does not provide authentication against other local users.

Profile windows last at most two seconds. A job permits five windows and ten seconds of sampling, with a 16 MiB limit per profile and a 250 ms stop allowance. An open authored run continues into the next available window when it has no pending browser request. A window also starts before browser reply delivery when a previous window has ended. Watchdog logging stops after eight observations, while later profiling remains available. Exhausted windows produce `profile_cap`, so a spin after all five windows cannot be sampled. Unsupported attachment produces `inspector_unavailable`. Diagnostic failures preserve the operation receipt. Profile strings receive registered-secret redaction before storage.

The parent uses Node 24's native WebSocket. It applies the message size limit after the native transport receives a message. This is not a limit on allocation inside the native WebSocket implementation.

The writer caps total job output at 128 MiB and reserves 64 KiB for final evidence. Span limits are 256 active and 20,000 total. Watchdog reports stop after eight observations. Replay capture permits 4,096 exchanges, 16 MiB per encoded value, and 32 MiB of encoded values per job. Capture traversal stops at 20,000 nodes or depth 64. Missing, redacted, unsafe, or capped values produce explicit gaps. Artifact events include a safe basename and operation ID.

## Replay a private bundle

Keep the original package distribution, installed dependencies, and Node executable available. Replay does not install dependencies or fetch a runtime.

```sh
pomerado-replay \
  --bundle /private/pomerado-traces/JOB.OPERATION.replay.json \
  --runtime /opt/pomerado \
  --out /private/pomerado-replay \
  --timeout-ms 15000 \
  --depth trace
```

Without a binary link, run `node /opt/pomerado/dist/typescript/src/standalone/replay-cli.js` with the same arguments. Output directories must be owned `0700` directories. Bundles and artifacts must be owned regular `0600` files. Private paths reject symlinks. Artifacts use exclusive creation.

The CLI runs the existing `runLocalOperation`, substitutes browser replies in recorded request and delivery order, and never falls back to a live website. Request divergence reports `{order,expected,actual}` with SHA-256 digests. The runtime must match Node version and executable hash, package version, distribution hash, and dependency-lock hash. Distribution source mode and a built distribution have different identities. The installed dependency directory is trusted operator provisioned code. The lock fingerprint is not an attestation that its installed bytes have remained unchanged.

Version one supports browser and pure operations. Requests for sign-in, files, dialogs, questions, card fill, or HTTP mark a bundle unsupported. Incomplete or redacted captures cannot be exact replay and are rejected. The first request mismatch stops replay even if authored code catches browser errors. Invalid replies are rejected before execution. Replay preserves the transcript, not wall-clock timing, randomness, or live-site correctness. JSON-safe plain values, undefined, and byte arrays use Node's version-specific V8 codec. Credential-named keys excluded from payload traces also make replay capture incomplete, even when their values are not registered secrets. A `type: "secret"` or `type: "credential"` tag alone does not trigger replay screening. Registered secrets are checked during capture and again before the bundle is written. Byte arrays are checked as UTF-8, UTF-16LE, Latin-1, and base64 text. Transformed, encrypted, or other binary encodings are not credential classification. Unknown private content remains private evidence.

Replay requires Linux x86-64 or arm64, Landlock with the required filesystem rights, seccomp, and `/usr/bin/cc`. The CLI compiles the bundled helper in its private scratch directory without installing anything. Unsupported hosts fail closed. Preflight checks real socket, outside-write, outside-chmod, outside-signal, account-read, and scratch-execution denials, plus a cleared environment, before loading captured source.

Landlock grants reads to the selected runtime distribution, package manifest, the installed dependency directory, the bundle, the Node executable, system libraries, the dynamic linker cache, the OpenSSL configuration, and selected device files. Other account and home files are excluded. Only the new scratch directory is writable. The original bundle is read-only. Outside path metadata, including existence and symlink targets, remains observable. Seccomp denies socket creation and the listed filesystem mutation, process-control, privilege, and tracing syscalls. It does not create user, process, or network namespaces. The outer process alone can kill replay children after checking their process group. This is an offline diagnostic boundary, not a general multi-tenant compute service or a CPU, process-count, or aggregate disk quota.

The outer launcher allows five seconds for each isolated startup and preflight. A private ready message arms the requested operation budget, with a maximum of 60 seconds, plus one second for cleanup. Startup does not shorten the operation budget. Timeout or interruption kills the outer process group and leaves a private report. The replay CLI has a 512 MiB Node old-space limit. The child that runs captured code uses Node's default heap limit. Individual files are limited to 32 MiB. An isolated replay cannot open inspector sockets. Profile depth therefore records `inspector_unavailable` without weakening network isolation.

CLI stdout contains a finite summary and a private report path. Payloads and child streams stay in private artifacts. Scratch evidence is retained for inspection. The operator owns retention and manual expiration of traces, profiles, replay bundles, and replay output. There is no automatic deletion or upload.
