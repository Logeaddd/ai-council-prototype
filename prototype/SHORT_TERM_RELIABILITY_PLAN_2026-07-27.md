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
* Unknown runtime acquisition now retains a sanitized discovery trail in
  `c9c065f`. When a provision request has no source, the execution follow-up
  requires a real web search for a publisher or platform package listing and
  a materially different request carrying the source URL and query. The URL
  is safe-validated and persisted without credentials or query data; it is
  explicitly discovery evidence, not a trust claim. Package-manager handling,
  publisher hashes, and executable verification remain the separate evidence
  needed to use a tool. Unsafe discovery URLs are rejected before any install
  command runs.
* Regression evidence after `e3b68f6`: the focused real-user HTTP/SSE suite
  passed 17/17; after `c9c065f` the full suite passed 720 tests with 0 failures and 1
  platform skip. `node ./src/cli.js harness-check` remains honestly
  `incomplete`: T106 is 7/7 complete, while T105 and T117 await the configured
  real-provider multi-task evidence window. The report is
  `harness/reports/product-harness-2026-07-27T00-43-37-963Z.json`, bound to
  commit `ab5209b`.
* Local release-surface checks after the tool-acquisition change also passed:
  `npm run renderer:build` completed the optimized Next.js production build,
  and `npm run probe:electron-drop` exercised the actual Electron composer
  drop event, confirmed default prevention, and retained `dropped-note.txt`
  as an attachment. This is evidence for the build and drag/drop path only;
  it is not a substitute for the real-provider release gate or broader UI
  acceptance.
* The focused private-chat UI gap now has an isolated real-Electron probe:
  `npm run probe:electron-private-draft` creates its own temporary group via
  the same local API as the renderer, types into the visible focused group and
  private textareas through Electron, verifies independent local-storage keys,
  then closes and reopens the private sheet to confirm draft restoration. The
  probe exposed and drove a repair for a real bootstrap flaw: a token kept only
  in an injected `<meta>` tag could disappear during static-head hydration.
  The server now also initializes the same local-only token in page memory,
  while the renderer continues to send it only to the same-origin local API.
  This validates group/private draft isolation and authenticated UI API access,
  not provider reasoning, collaboration, or delivery completion.
  After the production renderer build, the probe passed three consecutive
  isolated Electron runs; the existing drag/drop Electron probe also passed.
* Product harness rerun at `3dbc510` produced
  `harness/reports/product-harness-2026-07-27T01-26-09-820Z.json`.
  Its embedded full suite passed 724 of 725 tests with 0 failures and 1
  platform skip. T106 remains complete at 7/7 gates; T105 is 6/7 and T117 is
  2/3 because the real-provider campaign window remains 5/9 (55.6 percent),
  below the 75 percent gate. The latest report for each of five required task
  families is passing, but that does not erase four historical failed reports.
  No `AI_COUNCIL_API_BASE_URL`, `AI_COUNCIL_API_KEY`, or
  `AI_COUNCIL_MODEL` was configured for a new paid-window run, so this report
  is a local re-evaluation of retained evidence, not new Provider evidence.
* `harness-check` now keeps its synchronous library API for existing callers,
  while the CLI uses an asynchronous child-process path that streams the real
  Node test output as it arrives. While the test child remains alive it emits a
  factual heartbeat containing the elapsed silence time; this is observability,
  not a timeout, progress estimate, or success claim. The completion line is
  emitted only after the child exits and includes its real exit code and parsed
  test totals. A temporary child test verifies both a real output chunk and an
  alive-but-silent heartbeat. The full CLI check produced 726 tests, 725 pass,
  0 fail, and 1 platform skip in 190,125 ms, with 12 observed heartbeats. Its
  report at `tmp/harness-check-progress-20260727/report.json` remained
  `incomplete` (T105 6/7, T106 7/7, T117 2/3), as the paid real-provider
  evidence window remains unmet.
* Native provider-tool schemas now have regression coverage in `3760bd5` for
  retaining `discoverySourceUrl` and `discoveryQuery` through the closed
  schema and request-normalization path. The follow-up full suite passed
  721 tests with 0 failures and 1 platform skip. This is local protocol
  evidence only; it does not increase the real-provider campaign pass rate.
* Windows command recovery now handles the complete redundant
  `powershell -Command "..."` form in `439113a`. When the request already
  selected `shell=powershell`, the tool runs the inner script directly so
  PowerShell variables cannot be expanded away by an outer wrapper. The result
  retains both the requested and executed commands plus an explicit correction
  record. An actual Windows variable-preservation test and the full suite
  passed 722 tests with 0 failures and 1 platform skip.
* The current deterministic context-pressure baseline passed at
  `eval/context-pressure/baseline-20260727-1785113141866/report.json`. It
  retained 146,276 characters across 160 historical messages, rebuilt the
  public index, recalled and injected the buried exact source, removed an
  explicitly invalidated persisted source, deduplicated 95 of 96 repeated
  execution records, and injected all three public checkpoints for every
  resumed member. A merely lower-priority old instruction remains visible
  until it has an explicit source invalidation; this is deliberate because
  keyword or single-model guesses must not silently delete retained history.
  Semantic supersession remains a real-provider acceptance concern.
* Semantic task intake is now implemented in the current worktree. Every
  non-empty request in a group with an execution-capable member begins with one
  durable intake owner, which must declare a structured `task_contract` before
  normal delegation: `mode`, objective,
  workspace and verification requirements, deliverables, completion criteria,
  and next action. The execution state, no-progress guard, and stagnation
  recovery consume that durable contract rather than request-language keyword
  matching. A read-only action no longer implies that the task must mutate the
  workspace. The old `isDeliveryTask` helper remains deprecated only for
  external compatibility; production orchestration no longer imports it.
* A local HTTP/SSE regression now exercises the real `server.js` API path with
  a non-English request, a model-declared delivery contract, one `builder`
  owner, a real `workspace_edit`, and a real local verification command. It
  asserts that no second member writes the artifact and that TaskRun records
  the evidence. The provider used by this test is a deterministic local
  protocol fixture, so this is local protocol evidence, not real-provider or
  real-user acceptance.
* Intake ownership is hardened against malformed Provider replies. A normal
  speech response without a complete semantic `task_contract` and without
  recorded tool/file evidence now remains with the same intake owner; it does
  not silently turn into a discussion or release other members to restart the
  task. A contract must explicitly carry both workspace and verification
  requirements, an objective, completion criteria, and a concrete next action
  (plus deliverables for delivery work). `TaskRun` checkpoints now preserve
  the task question, normalized contract, and intake-attempt count, so an
  interrupted `continue` resumes the same interpretation rather than falling
  back to legacy delivery guessing. The local HTTP/SSE regression confirms
  two malformed intake turns produce one owner only and an honest
  `incomplete` result. This remains local protocol evidence, not a paid
  Provider campaign pass.
* The public `task_state` recovery checkpoint now retains the same normalized
  task contract, intake-attempt count, owner-transfer history, and bounded
  checkpoint-review delegations as the durable TaskRun. This is the explicit
  fallback used for a plain `continue` when no resumable TaskRun is available;
  it no longer discards the owner or task interpretation and reverts to legacy
  guessing. Focused persistence/resume tests validate the checkpoint survives
  a write/read cycle and recreates the same delivery state. This is local
  recovery evidence, not a real Provider campaign pass.
* Delivery-owner follow-up instructions now repeat the persisted objective,
  requested deliverables, mechanical completion criteria, and workspace/
  verification requirements alongside the current phase and next action. This
  makes the durable contract operational during long tool loops instead of
  leaving the owner with an isolated next-action reminder.
* Bounded delivery delegation is now implemented in the current worktree.
  Only the durable delivery owner can issue a `research`, `implementation`,
  or `unblocker` subtask, and every delegation records its assignee, narrow
  task, expected handoff evidence, allowed tools, optional mutable paths,
  checkpoint version, and lifecycle status. The scheduler calls only the
  named contributor while that handoff is pending; it returns to the owner
  after the contributor completes or fails. Contributors cannot independently
  declare the overall task complete, and the runtime rejects file/tool writes
  outside their explicit delegation scope. Their structured handoff plus
  observed tool/file evidence becomes durable TaskRun and fallback
  `task_state` data. The owner receives and acknowledges those handoffs in
  its next context and remains the only member permitted to advance the final
  delivery.
* Local protocol regression now covers the complete `server.js` HTTP/SSE path
  for owner -> bounded research contributor -> owner write/verification. It
  proves one contributor handoff is persisted, only the owner writes the
  final document, task recovery retains a pending delegation, and out-of-scope
  contributor writes are rejected. The model endpoint in this regression is a
  deterministic loopback fixture, so it is regression evidence only, not a
  real Provider or real-user campaign pass.
* Current-worktree verification after bounded delegation: `npm test` and the
  product harness test child both reached 739 passed, 0 failed, and 1 Windows
  platform skip out of 740 tests. The harness report is
  `harness/reports/product-harness-2026-07-27T04-30-18-422Z.json`; it remains
  honestly `incomplete` because T105 and T117 still require a paid
  real-provider evidence window. Its retained evidence is 5/9 passing reports
  (55.6 percent) against the required 75 percent, even though the latest
  report for each current task family is passing.
* A new paid real-provider campaign ran after this P0 change with
  `deepseek-v4-flash`, seed `8`, and the full `$80 / 320` explicit budget:
  `eval/real-user-campaign/p0-delegation-v4flash/campaign-node-cli-8-1785126841724/report.json`.
  It used 43 actual calls and 21 stages (7 follow-ups, 4 required artifact
  edits, member mutations, and two interruption/reopen cycles). The
  physiology gate passed: real artifact creation/execution, durable task and
  member state, 40 timestamped visible messages, two resumed sessions, and no
  duplicate verified command replay. Its outcome-conformance diagnostic was
  deliberately **not** conflated with that result: the final program printed
  `Thanks, Ada!` while that scenario's exact expected text was `Thanks, Ada.`.
  This is a real content mismatch, retained in the report as
  `outcomeConformance=false`; it is not represented as a full task-quality
  pass. The run adds genuine physiology evidence only and does not itself
  prove that a real provider chooses or integrates a bounded delegation.
* Unknown-tool provisioning now requires traceable discovery in `c5ba798`.
  An unrecognised CLI or runtime must cite a publisher/platform URL that
  matches a completed `web_search` result or exact `fetch_url` result before
  installation. The persisted provenance records the bounded source tool ID
  and exact/origin match, while already available PATH/managed tools may be
  reused without repeated research. This is enforced at the real tool
  boundary, fed back to the same delivery owner after failure, and covered by
  local tool execution tests. The complete suite passed 752 of 753 tests with
  0 failures and 1 Windows platform skip; the optimized renderer build passed.
* Campaign pass accounting now applies the same capability-use receipt rule to
  the overall passed-report count and pass rate in `821f779`. A historical
  report that merely declares acquisition success cannot inflate the matrix
  while failing its required capability family. The formal report at
  `harness/reports/product-harness-2026-07-27T10-14-19-216Z.json` therefore
  reports 7/10 (70 percent), not 8/10, and capability acquisition 0/3.
  T105 and T117 remain incomplete; T106 is complete. This machine
  currently has no `AI_COUNCIL_API_BASE_URL`, `AI_COUNCIL_API_KEY`, or
  `AI_COUNCIL_MODEL` configured, so no new real-provider campaign was started
  and no local evidence is represented as a replacement.
* Campaign capability evidence is now bound to its original execution files in
  `51de9ed`. Every retained acquisition-use link includes the later work tool
  result ID; the campaign records hashes for the session JSON files containing
  those IDs. Product gating reads those files again, rejects absent/absolute
  paths, hash drift, duplicate IDs, failed tool results, or a missing matching
  `capabilityUsage` link. This makes the report summary auditable against the
  durable execution record, although it is not a cryptographic attestation
  against an actor able to alter both local files. Full regression remained
  752/753 with 0 failures and 1 Windows platform skip. The resulting formal
  report is `harness/reports/product-harness-2026-07-27T10-31-26-387Z.json`;
  it remains incomplete for the same unconfigured real-provider campaign.
* Delegated-collaboration evidence now follows the same durable rule in
  `e6d45b3`: campaign reports must contain hashes for their complete persisted
  session snapshot, and product gating reloads those exact files to verify
  native delegation provenance, delegation timestamps, current contributor
  evidence, and the owner's later target write. Cached `collaboration.passed`
  fields no longer count. The retained older collaboration reports lack the
  new native/timestamped evidence and receipt, so T119 is deliberately
  incomplete until a fresh real-provider campaign supplies it.
* T112 source-specific context supersession is now implemented in the current
  worktree. A member may semantically declare that the current user instruction
  replaces one exact retained source, in any language; the app accepts the
  declaration only when the source reference was actually injected into that
  member's current context. It stores the replacement against the current
  session question, persists it through the session, TaskRun event stream, and
  public task state, then recompiles later member/tool contexts. Equivalent
  archive-retrieval and public-event-cache views are suppressed together only
  when their durable session/round provenance proves they represent the same
  retained record. Raw session/archive history is never deleted. This is not a
  keyword detector and it is not a second memory store.
* The deterministic context-pressure baseline at
  `eval/context-pressure/baseline-20260714-1785165258139/report.json` now
  requires the stale source to be initially visible, source-addressable, and
  absent after a valid replacement. A local HTTP/SSE protocol regression
  additionally verifies the first member's source-specific declaration,
  recompilation of the next member's real prompt, durable state/receipt
  persistence, and retained raw history. Full local regression was 765 passed,
  0 failed, and 1 Windows platform skip out of 766 tests; the production
  renderer build passed. These are local implementation evidence, not a
  real-provider semantic-reasoning acceptance pass.
* T113 was implemented only after the live-session measurement exposed a
  concrete gap: before this change, a long active task automatically injected
  only its last six raw member records, while deterministic summaries were not
  written until the task ended. The new bounded active working set is rebuilt
  from the current session on every context build, so it is a replaceable view
  rather than an append-only second history. It prioritizes attributable task
  contracts/delegation handoffs and the latest substantive record from each
  participant and recent round; every entry carries its exact raw message
  reference, remains subject to source-specific invalidation, and is charged
  to the same prompt budget and receipt as every other section. The pressure
  run at `eval/context-pressure/baseline-20260727-1785165879342/report.json`
  covers a 24-record active session where both an early architecture decision
  and early structured handoff remain visible outside the six-record raw
  window. This is local context-pipeline evidence, not a claim that a real
  Provider will reason correctly from the working set.
* T114 was audited in the existing retrieval path rather than rebuilt. The
  current public journal is a structured JSON index with lexical matching,
  filters, pagination, and exact-event loading; it is not FTS5. The real-path
  audit at `eval/retrieval-audit/audit-20260727-1785165463642/report.json`
  recalled the exact target and applied combined filters, pagination, and
  tombstones correctly at 2,400 indexed fixture messages; the measured query
  was 14.921 ms against a deliberately generous 1,500 ms ceiling. No measured
  latency or exact-lexical-recall gap currently justifies an FTS5 or vector
  parallel retrieval system. The audit does not establish paraphrase/semantic
  recall, which remains a conditional T116 question for real-provider tests.

Still open before the real-provider release gate:

* Interactive command work now has a durable real PTY path: terminal input,
  resize, offset-based output, explicit stop, workspace-change evidence, SSE
  disconnect survival, and redaction of typed terminal input are covered by a
  real server/PTY/filesystem regression. This is local tool-path evidence; it
  does not prove a Provider can decide when an interactive terminal is needed.
* Capability acquisition evidence is now an explicit receipt, not a cached
  boolean. A later successful command, code run, test, MCP call, or skill read
  must reference the exact earlier acquisition; the receipt stores the two
  tool IDs, kind, and bounded non-secret references. Product-gate evaluation
  rejects legacy reports that only say `capabilityAcquisition.passed=true`.
  The retained image-acquisition campaign reports predate this receipt and no
  longer satisfy that family. This deliberately reopens T105/T117 until a
  fresh real-Provider capability-acquisition campaign completes with the new
  evidence. A local test pass must not restore those gates.
* Exercise delegated research, implementation, review, and unblocker work
  with real Providers across several project families. The local orchestration
  test proves the path exists; it does not prove a provider will choose good
  delegation boundaries or integrate evidence correctly under pressure.
* T113's local active-working-set proof now needs real-provider observation:
  use the context receipts to distinguish a missing source from a model that
  saw it but ignored it. Do not turn the derived working set into a persistent
  second history or loosen source-specific invalidation. T114 remains an audit
  discipline: add FTS5 or semantic retrieval only after a measured real query
  latency, exact-recall, or paraphrase-recall gap, not because an index is
  fashionable.
* Add PTY only where a real task proves interactive stdin is the blocker;
  absence alone is not evidence for a parallel terminal system.
* Run the paid real-provider campaign with its mechanical oracles, distinct
  task families, and evidence window. Local tests and deterministic context
  pressure reports do not satisfy this release gate.
