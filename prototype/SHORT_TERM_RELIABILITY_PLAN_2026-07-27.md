# Short-term reliability plan - 2026-07-27

## Purpose

This is the binding short-term implementation order following the code audit.
It addresses product failures and security defects before the larger provider
tool-protocol redesign. It applies to all task types; no item may be solved by
special-casing a PDF, Forge mod, or campaign fixture.

## Scope and order

1. Local API security: startup-scoped random bearer token, trusted renderer
   origin validation, JSON content-type enforcement for state-changing API
   calls, and rejection of untrusted runtime/permission overrides.
2. Durable run lifecycle: a TaskRun owns execution; SSE is an observer. Runs
   survive observer disconnects, events have persistent sequence IDs, clients
   reconnect with a cursor, and explicit stop remains possible. A full app
   exit resumes from the TaskRun checkpoint rather than pretending the old
   process survives.
3. Command reliability: replace the generic 12-second tool budget with
   tool-family defaults, preserve background process observation, and allow a
   retry when a failed command was transiently blocked or its environment
   changed. Continue rejecting demonstrably identical no-progress loops.
4. Search health: distinguish transport success from useful search results.
   Detect empty, challenge, consent, and off-target fallback search responses;
   record degraded evidence and force a different source or an honest blocker.
5. Verification strength: replace header/non-empty-only success claims with
   format-aware parsers and request-aware mechanical requirements. Existing
   campaign pass rates must be recalculated after this change.
6. Focused UI correctness: repair private draft switching, make the renderer a
   projection of the durable event stream, then verify drag/drop in the actual
   Electron window rather than rewriting an already-present composer handler.
7. Provider protocol redesign: provider-native continuous tool conversations,
   small dynamic strict tool schemas, streaming/idle timeouts, calibrated
   token budgets, and a slim stable system contract.
8. Ownership and broader physiology: one durable delivery owner with delegated
   contributors, PTY only when evidence requires it, trusted unknown-tool
   acquisition, long-history pressure measurement, and the paid real-user
   campaign window.

## Evidence rules

* Unit and mocked-provider tests are regression tests, never product proof.
* Every changed subsystem requires a local real-tool/API test and a persisted
  evidence record.
* The real-provider campaign remains incomplete until its strengthened
  oracles, distinct task families, latest-pass requirement, and 75 percent
  evidence window all pass.
* Never convert a timeout, missing capability, invalid provider response, or
  disconnect into a completed task.

## Immediate acceptance gates

* A cross-origin or tokenless state-changing local API request is rejected.
* Disconnecting the event observer does not abort its run; reconnecting from a
  cursor yields the exact missing events once and in order.
* A representative dependency install/build lasts beyond 12 seconds and is
  observed to success, failure, or explicit cancellation.
* A Bing fallback response containing no useful target result is degraded, not
  successful search evidence.
* A tiny file beginning `%PDF-` cannot verify an illustrated report request.

## Progress record

Completed on 2026-07-27:

* Steps 1-6 are implemented in `712613f`, including the local API boundary,
  durable run/SSE separation, real Electron drag/drop evidence, stronger
  search and artifact verification, and focused UI repairs.
* Step 7 now has provider-native continuous tool result turns and closed,
  per-tool schemas in `2b91f01`. OpenAI-compatible and Anthropic payload
  order is tested, as is the complete controller-to-tool-to-follow-up path.
* Stream silence is treated as retryable, auditable provider failure in
  `188532e`; this is an inactivity detector, not a tool, speech, or round
  quota. It can be explicitly disabled with `streamIdleTimeoutMs: 0`.
* Provider token calibration is implemented in `299e459`: provider
  usage is kept as a redacted count-only ledger per provider/model, and later
  prompt estimates use the most conservative observed input multiplier. The
  old unverified 16K fallback is removed. An unknown context window remains
  explicitly unknown: it cannot create a core-overflow stop, while fresh tool
  evidence still gets a bounded result view. Usage counts do not prove a
  provider context-window size, so explicit provider/configured limits remain
  the only enforceable input limits.
* Durable delivery ownership and checkpoint-review delegation are implemented
  in `aacb5a6`. A replacement owner gets a recorded transfer rather than
  silently inheriting work; every assigned reviewer must finish the current
  checkpoint before that checkpoint can close. TaskRun emits a
  `delivery_owner_transferred` event for recovery/audit.
* Trusted managed-tool acquisition is implemented in `9f8ddd7`. Downloaded
  artifacts use validated HTTPS or loopback-only test transport, each
  redirect is revalidated, bytes are bounded while streamed to disk, optional
  publisher SHA-256 values are verified, and a missing checksum remains a
  durable `unverified` fact rather than a false trust claim. Safe archive
  extraction and command verification remain mandatory before reuse.
* Long-history pressure measurement is expanded in `061895e`. It builds a
  140K-plus-character retained history through the real journal, index,
  archive, hot-cache and context-builder paths, then records exact-anchor,
  invalidation, duplicate-evidence, multi-member visibility and resumed
  `continue` receipt metrics. A persisted local run is at
  `eval/context-pressure/baseline-20260727-1785105953710/report.json`.
* Explicit verification and execution requests now route to the durable
  delivery owner in `a1c3f4e`, including Chinese and English verb forms. This
  prevents a request to run, validate, or verify work from being stranded in
  a discussion-only role.
* Live tool-start events are persisted before command completion in
  `e3b68f6`. A real HTTP/SSE observer can therefore disconnect while a tool is
  actually running, explicitly stop the durable run, restart the server, and
  continue from its checkpoint. The later generator pass skips the already
  published start event, so reconnecting clients receive it exactly once.
* Regression evidence after `e3b68f6`: the focused real-user HTTP/SSE suite
  passed 17/17; the full suite passed 718 tests with 0 failures and 1
  platform skip. `node ./src/cli.js harness-check` remains honestly
  `incomplete`: T106 is 7/7 complete, while T105 and T117 await the configured
  real-provider multi-task evidence window. The report is
  `harness/reports/product-harness-2026-07-26T23-50-09-314Z.json`.

Still open before the real-provider release gate:

* Add PTY only where a real task proves interactive stdin is the blocker;
  absence alone is not evidence for a parallel terminal system.
* Run the paid real-provider campaign with its mechanical oracles, distinct
  task families, and evidence window. Local tests and deterministic context
  pressure reports do not satisfy this release gate.
