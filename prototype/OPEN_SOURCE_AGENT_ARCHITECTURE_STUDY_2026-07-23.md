# Open-source agent architecture study — 2026-07-23

## Scope and method

This is a source-level study, not a claim that AI Council has adopted these designs. No production code, provider configuration, installer, or tests were changed while preparing it.

The question driving the study is practical: why can AI Council advertise file, shell, network, package, MCP, skill, memory, and collaboration features yet still fail a straightforward real task by repeatedly searching, failing to write, losing context, or falsely reaching a terminal state? The answer is not simply “add more tools.” Mature projects separate the **capability plane**, **task runtime**, **canonical history**, **context projection**, **delivery proof**, and **UI transport**. AI Council currently has parts of each, but too much responsibility remains coupled inside the discussion loop.

## Reference sources pinned for this study

| Project | Revision inspected | What it contributes | Important caveat |
| --- | --- | --- | --- |
| Cherry Studio | `CherryHQ/cherry-studio` at `e4ca4f8f59f992386f0be340b4eeaf38c38fd9d6` | Local desktop product architecture, data ownership, web-search providers, MCP/skill management, persistent jobs | It is primarily a desktop AI client/platform, not a proof that a single model can autonomously finish arbitrary projects. |
| Cline | `cline/cline` at `c961ae773029534ad5473db0e0939d941b9dca24` | Agent runtime state machine, explicit completion, tool lifecycle, compaction artifacts, session hub, hooks/plugins | It is code-agent oriented. Its runtime patterns are reusable, its exact editor integrations are not. |
| OpenHands | `All-Hands-AI/OpenHands` at `96f902a9ac14bf5edfb2e47d759d75c91e4faf28` | Conversation service, event persistence, sandbox/workspace ownership, skill sources, profile/security separation | Current repository delegates its core runtime to the published `openhands-sdk==1.36.0`; this study treats that boundary honestly rather than pretending all core code was inspected. |

Reference checkouts are isolated from the product worktree:

```text
D:\agent小组\.agent-research\cherry-studio
D:\agent小组\.agent-research\cline
D:\agent小组\.agent-research\openhands
```

The current AI Council baseline is `D:\agent小组\prototype` at committed `ae994a3` plus an uncommitted context-overflow patch documented in `HANDOFF_2026-07-23.md`.

## Executive conclusion

AI Council should **not** clone Cherry Studio, Cline, or OpenHands wholesale. Each carries a large ecosystem and assumptions that do not fit this Electron/Node product. It should, however, adopt five architectural rules that all three independently support:

1. A tool/capability is an owned, verified resource with lifecycle state; it is not a line in a prompt.
2. A task is a durable state machine with evidence-bearing terminal states; it is not a sequence of group chat rounds.
3. The full transcript/event journal is canonical; prompt context is a derived, inspectable projection.
4. A model text response never proves delivery. Successful completion needs an explicit terminal action plus request-specific evidence.
5. Streaming UI, interruption recovery, and background work must consume structured runtime events, not reconstruct meaning from disappearing text fragments.

The immediate strategic correction is therefore to turn the existing “council” into an advisory/review layer around a durable execution runtime. It must not remain the sole owner of execution, progress, recovery, and final truth.

## 1. What Cherry Studio actually does

### 1.1 Product data is split by lifetime and ownership

Cherry Studio documents four distinct data systems in `docs/references/architecture-overview.md`:

| Data class | Cherry storage model | Lesson for AI Council |
| --- | --- | --- |
| Boot configuration | Synchronous JSON before app lifecycle | Startup-only settings should not share storage/semantics with live task state. |
| Cache | Per-process/shared/persistent UI cache | Renderer convenience state is not canonical task history. |
| Preferences | SQLite | User settings need durable, typed, independently versioned storage. |
| Business records | SQLite via DataApi/service/repository layers | Conversations, agents, MCP registrations, and skill associations need explicit models and migrations. |

It also keeps main process, renderer, preload/IPC, and shared schemas separate. This matters because a renderer can be closed while a task or capability operation remains meaningful. The renderer observes state; it should not be the owner of task truth.

AI Council currently has a Node server plus SSE and JSON-backed group/session storage. That is sufficient for an incremental design, but the same discipline is missing: a session event, UI message, delivery claim, runtime attempt, and tool result are currently too intertwined in `src/discussionEngine.js`.

### 1.2 Cherry web search is a real provider subsystem, not magic free internet

Inspected files:

- `src/main/services/webSearch/WebSearchService.ts`
- `src/main/services/webSearch/providers/registry.ts`
- `src/shared/data/presets/webSearchProviders.ts`
- `src/main/ipc/handlers/webSearch.ts`

The service:

- resolves a provider and runtime configuration for the requested capability;
- creates a provider-specific driver;
- fans out multiple inputs with `Promise.allSettled`;
- permits partial success, but fails honestly if all inputs fail;
- applies domain blacklist and post-processing after merge;
- distinguishes caller cancellation from provider-side partial failure;
- keeps API-key rotation state in the service lifetime rather than every UI call.

Its registry includes Zhipu, Tavily, SearxNG, Exa API, Exa MCP, Bocha, Querit, direct fetch, Jina, and Firecrawl. Most routes require a configured endpoint/key or a running SearxNG service. `fetch` is URL fetching, not a general web-search engine. Therefore Cherry Studio’s “web search” experience comes from integrating a configured search backend or MCP; it is not evidence that a desktop agent can always search the public internet without any provider/service.

**AI Council implication:** retain built-in `web_search`, `fetch_url`, and `api_request`, but introduce a `NetworkProviderRegistry` with explicit readiness: `configured`, `probing`, `ready`, `degraded`, `unavailable`, and `lastError`. An agent should receive a concrete capability error (“no search backend is ready; direct URL fetch remains available”), not silently issue repeated searches. A no-key option can be shipped only where its provider, terms, rate limits, and health checks are real and visible; it must not be a fake “always online” switch.

MCP search must remain a distinct route: an installed, healthy Exa/Searx/etc. MCP server is not the same thing as a built-in HTTP search provider.

### 1.3 Cherry skills have canonical storage, verification, and per-agent enablement

Inspected files:

- `src/main/ai/skills/SkillService.ts`
- `src/main/ai/skills/SkillInstaller.ts`
- `src/main/data/services/AgentGlobalSkillService.ts`

Notable behavior:

- installed skills live in an app-owned canonical directory;
- metadata is stored separately from files;
- enablement is a per-agent join relationship, not a prompt convention;
- install/update uses copy with backup/restore behavior;
- the `SKILL.md` content hash is calculated for change detection;
- ZIP import checks extracted-size and file-count limits;
- path traversal is checked for skill file reads;
- system/project skills are discovered separately from managed skills;
- session construction uses a whitelist of enabled skill names instead of mutating global skill state during a run;
- startup reconciliation repairs mirror/registry drift.

This directly answers the previous `openai-pdf` confusion. A catalog entry or a downloaded `SKILL.md` is not enough. A robust skill record needs at least:

```text
source -> downloaded files -> integrity/version -> install outcome -> enabled scope
-> instructions loaded -> declared dependencies -> dependency probe -> usable/failed state
```

**AI Council implication:** replace the current “static pack plus text installation” mental model with a single capability record that tracks source, version/hash, file location, agent/group scope, declared dependencies, health probe, last successful use, last failure, and remediation. A model cannot count a skill as progress until it has been installed/enabled and a real task has used it successfully.

Downloaded instructions must not cause arbitrary scripts to execute automatically. “Install a skill” and “run a tool/runtime dependency” are separate user-authorized capability classes.

### 1.4 Cherry treats MCP as durable product data and refreshes discovered tools

Inspected files:

- `src/main/data/services/McpServerService.ts`
- `src/main/ipc/handlers/mcp.ts`
- `src/renderer/hooks/agent/useAgentTools.ts`

Cherry stores MCP servers with type, activation, source, order, and agent associations. Removing a server removes associations transactionally and then refreshes affected agents. The renderer obtains a server’s discovered tool list and asks the main process to refresh when an active selected server has no cached tools. Each discovered tool carries origin/source metadata and an approval policy.

**AI Council implication:** npm package installation is not MCP readiness. The lifecycle must be:

```text
candidate -> installed/configured -> process/transport started -> protocol handshake
-> tools/resources/prompts discovered -> enabled for task/agent -> healthy -> callable
```

The capability record must retain the handshake result and exact discovered tool schema. The prompt must be built from this live snapshot, not from a hardcoded list that claims a server exists. A call failure must update health and be available to recovery logic.

### 1.5 Cherry’s job manager is a useful pattern, not a dependency to copy

Cherry’s `src/main/core/job/JobManager.ts` and its documentation implement:

- DB-backed source of truth;
- six states: pending, delayed, running, completed, failed, cancelled;
- atomic claim before handler execution;
- per-queue/global concurrency controls;
- retry backoff and explicit retryable errors;
- startup recovery strategies (`abandon`, `retry`, `singleton`);
- cancellation/drain/pause semantics;
- progress and state observation from the renderer.

This is substantially stronger than “keep a JavaScript promise alive and hope a stream finishes.” It is relevant for downloads, skill/MCP provisioning, long builds, indexing, real-provider campaigns, and detached processes.

Do **not** import Cherry’s whole IoC/database/job framework now. AI Council is smaller and has existing session JSON/event infrastructure. First introduce an application-level task-run manifest and append-only events using the existing storage paths. Move the small state/lease layer to SQLite only if crash recovery/concurrent processes require it. The invariant to copy is persistent, atomic state transitions and recovery—not Cherry’s framework size.

## 2. What Cline’s runtime teaches us

### 2.1 It separates agent loop, durable core/session, and host capabilities

Cline’s current monorepo splits responsibilities among packages. `sdk/ARCHITECTURE.md` describes the useful boundary:

| Layer | Owns | Must not own |
| --- | --- | --- |
| Agent runtime (`@cline/agents`) | Stateless loop, provider stream, tool orchestration, hook calls | Session persistence, UI, provider configuration storage, host-specific approvals |
| Core (`@cline/core`) | Session artifacts, compaction policy, runtime host/hub, settings, plugins, MCP, telemetry | Low-level loop mechanics |
| Host/UI | Workspace execution adapters, display, user interaction | Hidden authoritative runtime state |

This is the cleanest answer to AI Council’s present architecture problem. The council discussion loop should not own every concern. A future shape should be:

```text
UI / HTTP-SSE host
       |
TaskRun service (state, attempts, checkpoints, recovery, evidence)
       |
Agent runtime (provider turn -> validated tool calls -> typed results)
       |
Capability host (files, shell, browser, package/tool provision, MCP, skills)
       |
Canonical event journal + session/task artifacts

Council policy layer (design/review/escalation) feeds TaskRun; it does not replace it.
```

This does **not** mean a rewrite before fixes. It is a strangler migration: leave public HTTP/SSE routes stable, extract the event/state contracts, then move one delivery workflow at a time behind the runtime boundary.

### 2.2 Completion must be an explicit successful terminal action

In `sdk/packages/agents/src/agent-runtime.ts`, Cline:

- emits a `turn-started` event before each provider turn;
- errors on empty model output and incomplete max-token turns rather than treating them as normal completion;
- stores a structured assistant message before tool execution;
- emits `tool-started` and `tool-finished` events with a snapshot;
- accepts only a tool declared with `lifecycle.completesRun === true` and a non-error result as terminal tool completion;
- otherwise uses a completion reminder instead of accepting ordinary prose as done.

This is stricter than AI Council’s finalizer/consensus architecture. AI Council has improved `deriveSessionStatus`, execution state, artifact checks, and guard-stop truthfulness, but the executing model can still spend its work in discussion and a finalizer can still become the practical arbiter of progress.

**Adopt the principle, adapted to general tasks:** introduce an internal terminal action such as `submit_task_result`, available only after the task runtime has collected evidence. Its schema should include:

```json
{
  "taskRunId": "...",
  "claimedArtifacts": ["..."],
  "verificationEvidenceIds": ["..."],
  "remainingRisks": ["..."],
  "summary": "..."
}
```

`submit_task_result` succeeds only when request-specific machine checks pass. For an open-ended request without a machine oracle, it can produce `needs_human_review`, never fake `completed`. The finalizer can summarize evidence; it must not manufacture a successful terminal state.

### 2.3 Tool calls are first-class events with policy and lifecycle

Cline validates a tool call, applies pre-tool hooks and policy, handles approval explicitly, executes it sequentially or in parallel, and converts the outcome to a structured tool-result message. It differentiates parsed-input failure, policy denial, provider-executed tool restrictions, missing tool, approval failure, execution error, and normal output.

This matters because AI Council’s current tool dispatcher is broad but monolithic. `src/toolRequests.js` contains many actual facilities—shell, background-process control, provisioning, skills, MCP, archives, Git, browser—but a model’s malformed tool JSON or an unavailable skill can be surfaced as a vague `invalid_json_response`/unavailable message and then re-requested in later rounds.

**Adopt:** one normalized `ToolAttempt` record per request:

```text
toolAttemptId, taskRunId, agentId, requestedAt, capabilityId, toolName,
inputHash/redactedInput, validationState, policyState, start/end time,
outcome (success/error/denied/cancelled/timeout), resultEvidenceId,
progressEffects, retryClassification, remediation
```

The runtime, UI, history search, context compiler, and no-progress detector should consume this same record. Do not derive tool status from rendered chat text.

### 2.4 Canonical transcript and compacted context are separate artifacts

Cline stores full session messages and compaction state separately. `SessionArtifacts` has separate message and compaction paths. `session-compaction.ts` hashes the canonical prefix covered by a compaction artifact. On resume, a compaction projection is used only if the covered canonical prefix still matches; newer canonical messages are appended after the compaction boundary.

This is a direct fit for AI Council’s history requirements:

- any member can retrieve any non-deleted public event;
- short-term memory is a derived cache, not a destructive rewrite of history;
- compression must be inspectable and invalidated when source history changes;
- context can be compacted without the UI losing the original discussion;
- an interrupted/restarted run can rebuild its working view deterministically.

AI Council already has public event journaling, structured `search_context` filters, `load_context`, hot-cache/retrieval work, and context receipts. It should extend those in place. The current local patch that bounds immediate tool results is aligned with this principle: raw tool evidence stays persisted; only the provider-bound projection is shortened.

Missing work:

1. persist a dedicated working-context artifact/cache rather than recomputing all selections every turn;
2. record the source event range/hash covered by it;
3. invalidate it after deletion, edits, role/config changes, or conflicting newer instructions;
4. make every context receipt queryable from the UI and test reports;
5. ensure a private-chat context has a separate audience/scope and cannot contaminate group messages.

### 2.5 Checkpoints include workspace reality, not only chat history

Cline’s `FileContextTracker` tracks files read/edited, watches for external user modifications, marks old file context stale, and warns after checkpoint restore when files changed after the restored message. Its checkpoint restore is not treated as a time machine that magically overwrites external edits.

AI Council needs the general form:

- checkpoint task state and current requirements;
- checkpoint relevant workspace fingerprints (path, hash/mtime, origin, current artifact verification);
- treat external change as a real event;
- on resume, compare expected fingerprints with current workspace before continuing;
- if changed, re-read/re-verify rather than blindly applying old planned edits.

This directly fixes “user closed/reopened/edited something, then sent 继续.” The runtime must resume from evidence and current filesystem state, not simply replay the last model plan.

### 2.6 Cline has honest limitations too

Its general loop still supports a `maxIterations` configuration, and its architecture documents fallback completion emission for sessions that ended without explicit completion-tool observation. These are reminders not to copy labels blindly. AI Council should retain explicit cost and safety budgets, but they must be reported as budget stops, not interpreted as a task result. Any fallback completion needs separately verified evidence.

## 3. What OpenHands reinforces

OpenHands is useful as a “general task platform” reference rather than a source to import. The current server code separates:

- conversation records and task start services;
- event service/persistence (`FilesystemEventService` is one implementation);
- sandbox specification/service/workspace archive;
- user/settings/secrets and agent profiles;
- MCP routes and skills routes;
- remote workspace execution;
- live conversation status.

`app_conversation_service_base.py` creates an `LLMSummarizingCondenser` with a dedicated model usage identity, while the event service separately persists structured SDK events. It does not equate a summary with the canonical event stream.

`app_conversation/skill_loader.py` demonstrates another crucial boundary: it loads skill definitions from configured public/user/project/org/marketplace sources, validates source handling, and returns actual loaded skill records. It does not infer “skill exists” merely because the model mentioned a name. It is also careful not to log credential-bearing authenticated repository URLs.

The sandbox layer offers local process, Docker, remote, and preset sandbox services. AI Council need not use Docker immediately, but it should stop treating the host shell as a nameless extension of prompt text. Every task should know its workspace root, allowed external roots, process handles, acquired tools, and artifact locations.

**Adopt:** a `WorkspaceBinding` on every task run. It defines:

```text
primary workspace, allowed external destinations, source-control root,
environment/tool paths, process registry, requested artifact destinations,
workspace fingerprint, and isolation mode.
```

The desktop can still operate with full user-approved filesystem permission, but the execution record must retain where it worked and what it changed. This is how external Desktop output can be verified rather than guessed from an AI answer.

## 4. Direct comparison with AI Council

| Concern | AI Council now | Reference pattern | Gap / required change |
| --- | --- | --- | --- |
| Task owner | `discussionEngine` rotates enabled members and has `executionState` selection | Dedicated runtime/task run owns work; reviewers are policy participants | Make execution owner, artifact requirements, attempt/checkpoint, and terminal state durable independent of chat rounds. |
| Completion | Better status derivation and deliverable verification; still finalizer/round coupled | Explicit successful terminal tool/action plus evidence | Add terminal task submission under runtime control; finalizer only summarizes. |
| Tools | Real dispatcher implements many tools in one module | Validated tool attempt lifecycle, policy, start/finish events, host adapters | Split schemas/attempt state/dispatch/results; persist typed error/remediation. |
| Skills | Static curated packs plus installation/enabling logic | Canonical registry, integrity, atomic install, per-agent relationship, reconcile | Build capability lifecycle and health probe; catalog is not readiness. |
| MCP | Install/list/call support | Server record -> handshake -> live tool snapshot -> agent association | Track availability/probe/tool schema and prevent stale advertised tools. |
| Search | Built-in web tools exist | First-class provider registry with partial failures/config errors | Separate configured readiness from tool use; do not assert free network access when no backend exists. |
| History | Event journal/search/load and memory candidates | Canonical messages/events separate from compacted projection | Add cache artifact with prefix/hash invalidation and queryable receipts. |
| Context | `contextBuilder` sections, receipts, compression; active large-tool patch | Core-owned prepare-turn projection, separate compaction artifact, telemetry | Finish overflow patch, add artifact/invalidation, pressure tests with real builder. |
| Interruption | Session interruption/resume plumbing exists | Persistent task states plus workspace fingerprints/checkpoints | Continue must reconcile task, active processes, artifacts, and external changes. |
| Long/background work | `execute_command` background + `process_control` | Persisted job queue/state/retry/recovery | Add durable process/job records before claiming background execution is reliable. |
| Multi-agent | All members can speak in rounds; review roles are prompt/selection based | Runtime may spawn subagents but stores independent session/task artifacts | Schedule design/review at defined checkpoints; do not have all agents duplicate exploration. |
| UI stream | SSE events and renderer state | Typed stream boundaries: text delta/final, tool start/finish, run state | Make UI render the event journal idempotently; test close/reopen/partial stream. |
| Product tests | Unit suite, pressure/retrieval harness, real-provider campaigns | Unit + protocol/fixture + end-to-end host + live/provider evidence | Keep fast tests, but make randomized real-user physiology a release/periodic gate with strong oracles. |

## 5. Target architecture for AI Council

### 5.1 Keep “council” but put it in the right place

The council is useful for decomposition, alternatives, critique, and escalation. It is poor as the machine that independently decides whether every agent should keep searching, writing, or declaring completion each round.

For a delivery task, use a task owner/executor by default:

```text
User request
  -> TaskRun created with requirements and workspace binding
  -> Executor acquires/uses capabilities and produces checkpoint evidence
  -> Reviewer runs only when a checkpoint is ready or a risk needs review
  -> Executor repairs from reviewer evidence
  -> Verifier runs real checks
  -> Terminal submission succeeds or task becomes blocked/failed/interrupted
  -> Summarizer explains the evidence; it cannot alter terminal truth
```

Design members may contribute a plan, but planning cannot block physical execution when the task is already actionable. Reviewers must be given actual diffs/files/tool evidence, not asked to repeat an initial directory search.

### 5.2 TaskRun state model

Create a durable task-run record separate from raw session chat. Proposed states:

```text
created
  -> ready
  -> executing
  -> waiting_for_tool
  -> waiting_for_process
  -> checkpointed
  -> verifying
  -> review_required
  -> completed
  -> blocked
  -> failed
  -> interrupted
  -> cancelled
```

Rules:

- only `completed`, `failed`, `blocked`, and `cancelled` are terminal;
- `completed` requires verified terminal evidence, not consensus score or normal model prose;
- `interrupted` is recoverable and must retain the last atomic checkpoint;
- retries create a new `attemptId` with a reason, rather than overwriting prior failure;
- no-progress detection transitions to `blocked` or produces a recovery checkpoint; it does not consume hidden loops;
- explicit budget exhaustion is `blocked` with budget evidence, not `completed` or an unexplained unavailable message;
- agent role/name changes create configuration events and invalidate any role-dependent working context.

The first implementation can keep this manifest under each group’s existing storage with atomic writes and event append. It need not immediately migrate every session to a global SQLite database.

### 5.3 Capability lifecycle

Unify built-ins, packages, downloaded runtimes, skills, MCP servers, search providers, browser engines, and background processes under a record that can be queried by both UI and agent runtime:

```text
discovered -> candidate -> installing -> installed -> probing -> ready
                         -> failed
ready -> enabled(scope) -> in_use -> ready/degraded/failed/disabled/removed
```

Minimum fields:

```text
capabilityId, kind, source URL/package/ref, source hash/version,
install location, owner scope, declared permissions, dependencies,
probe command/handshake, discovered operations, health, last error,
last successful use, logs/evidence IDs, rollback/removal data.
```

This replaces “the prompt says `openai-pdf` exists” with a result the UI can show truthfully. It also allows the runtime to choose `provision_tool` only when the needed capability is absent/degraded, then verify it before retrying the original action.

### 5.4 Canonical events and context projections

Keep the current event journal, but impose a schema where every durable item has stable identity and audience:

```text
UserMessage, AgentMessage, ToolAttempt, ToolResult, ArtifactClaim,
ArtifactVerification, CapabilityChange, TaskStateChange, WorkspaceChange,
MemberConfigurationChange, ContextReceipt, Interruption, Resume, Review.
```

Each context projection must say:

```text
projectionId, taskRunId, agentId, source event IDs/ranges, visibility scope,
source-prefix hash, budget, injected IDs, shortened IDs, omitted IDs/reasons,
instruction conflicts/supersessions, cache generation, token estimate.
```

Raw events remain available unless a user explicitly cleans them. Short-term memory becomes a replaceable projection keyed by source prefix/version. It is never a substitute for full history.

### 5.5 Evidence and delivery

Every output request needs a lightweight machine oracle whenever one is possible:

| Deliverable | Minimum physiological evidence |
| --- | --- |
| Script/CLI | File exists, parser/syntax check, command runs, expected exit/output property |
| Code project | Source diff, build/test result, produced artifact if requested |
| PDF | Exists at requested path, parses, pages non-empty, requested text/image references exist; visual review is a separate quality layer |
| DOCX/XLSX/PPTX | Container parses, expected sheets/slides/text/media exist |
| Archive | File exists, can extract, expected member manifest/checksums match |
| External destination | Authorized path exists and is fingerprinted after task start |
| MCP/skill/runtime acquisition | Install + health probe + actual successful use in the same task |
| Network report | Query/source records exist, fetched content/evidence is stored, generated artifact verified |

The agent need not be judged on subjective design quality for a physiology pass. It must demonstrate that it can select/acquire/use a tool, perform work, and verify the result. Quality rubrics can be added later as a human review layer.

## 6. Implementation roadmap derived from the study

This is intentionally ordered to reduce false-completion and no-progress failures before adding more surfaces.

### Phase A — Establish the execution truth boundary

1. Finish and commit the active context-overflow fix only after all targeted/full tests pass.
2. Define `TaskRun`, `TaskAttempt`, `TaskStateChange`, `ToolAttempt`, and `ArtifactVerification` schemas and persist them beside existing sessions.
3. Make `deriveSessionStatus` consume TaskRun terminal state for delivery tasks; retain a truthful non-delivery discussion state for pure Q&A.
4. Add an explicit terminal submission path validated by evidence. A finalizer cannot set `completed` by text alone.
5. Make interruption/resume load the latest checkpoint and compare workspace/artifact/process evidence before new model calls.

Exit test: a deliberately interrupted external-workspace task resumes through the real HTTP/SSE path, observes the previous tool/artifact evidence, applies a later edit, and reaches a verified terminal action. No mock provider can count as the release result.

### Phase B — Build capability truth, then wire autonomous acquisition

1. Inventory existing skill, MCP, package, provision, search, browser, and process records.
2. Add the unified capability record with readiness/health/provenance fields.
3. Make skill install, MCP install, and runtime provisioning produce capability events and health probes.
4. Build prompts/tool menus from ready capability snapshots, not static marketing lists.
5. Make missing-tool recovery create a capability acquisition attempt and retry the original work only after success.
6. Add cleanup/rollback records for managed installs; never silently execute downloaded skill scripts.

Exit test: on a clean workspace, a real provider detects a missing safe third-party CLI, provisions it, proves the probe, uses it to create a nontrivial artifact, and records the full provenance. A second task reuses it without reinstalling.

### Phase C — Make context robust and observable

1. Complete T111-style context receipts in the existing `contextBuilder` path.
2. Store a separate working-context artifact/cache with canonical-prefix hash and invalidation rules.
3. Add explicit instruction priority/supersession and configuration-change events.
4. Run real `buildMemberContext` pressure baselines over long retained histories; do not use an LLM judge or fake context builder.
5. Audit existing structured JSON/event retrieval. Add FTS5 or embeddings only if measured recall/latency gaps require them.

Exit test: a long multi-member conversation with renamed/role-changed members, old superseded requirements, tool output, interruption, and a later “continue + edit” retrieves the right evidence. The receipt explains exactly why.

### Phase D — Rework collaboration scheduling

1. Model planning, execution, review, and verification as event-triggered task phases, not every-member/every-round chat.
2. Assign exactly one executor per delivery checkpoint unless parallel work has non-overlapping outputs.
3. Trigger reviewer only after actual evidence/diff/build checkpoint.
4. Keep a shared task board/state visible to all agents and user, but give each model a bounded working projection.
5. Add a no-progress detector based on repeated `(task state, action category, target, output fingerprint)` signatures and lack of new evidence—not a small tool-call count.

Exit test: a rabbit-report-like research-and-artifact task shows one worker collecting sources/creating the artifact, reviewer checks real evidence, verifier parses the result, and no second member duplicates the same searches without a distinct purpose.

### Phase E — Product UI and real-user evaluation

1. Render UI from idempotent typed events so deltas cannot disappear when a later event arrives.
2. Separate private/group composer state and send actions at data-model level.
3. Restore event history, task run, capabilities, active processes, and context receipt after close/reopen.
4. Run seeded real-user physiology campaigns through API/SSE with random 10–30 stages, 5–10 follow-ups, at least four edits, member disturbances, interruption/restart, and no-progress observation.
5. Make these campaigns periodic/release gates with declared real-provider cost limits. Fast unit tests stay in normal CI.

Exit test: the user can inspect a complete report directory containing scenario seed, exact event journal, task state transitions, tool/capability evidence, artifacts, verification results, interruption/recovery evidence, and costs. A pass never relies on hidden model judgment.

## 7. Explicit non-goals and traps

- Do not replace the codebase with LangGraph, AutoGen, Cherry Studio, Cline, or OpenHands merely because they are popular.
- Do not turn every suggestion into a hard global limit. Budgets are accounting/safety controls, not the cure for a stalled agent.
- Do not gate completion on consensus score, the number of agents who spoke, or a green UI label.
- Do not use a fake PDF header, fake image, mock provider, or manually written expected file as real-provider product proof.
- Do not assume a skill marketplace, npm package, or MCP catalog entry is an installed working capability.
- Do not conflate direct HTTP web search, provider-native search, browser navigation, and MCP search.
- Do not destroy full history to reduce context. Compress a projection and retain source pointers.
- Do not make reviewer/designer roles inferable from Chinese/English role names. Persist explicit role/capability configuration.
- Do not introduce a new “parallel memory” database that conflicts with the public event journal and Git evidence. Extend one canonical model.
- Do not copy Cherry’s large job framework before the product has a clear TaskRun contract and acceptance tests that exercise recovery.

## 8. Questions that must be answered by evidence before implementation claims

1. Which existing session/event files can safely become the TaskRun source of truth, and which need migration/versioning?
2. Does current `executionState` have enough data to seed a TaskRun manifest, or should active tasks be created only after the migration boundary?
3. What exact persistent process record is needed to recover/observe a background command after an app restart?
4. Which browser/search backend can be shipped as genuinely available without a user key, and what are its limits/terms/health behavior?
5. How will skill dependencies be declared and probed without executing untrusted downloaded code implicitly?
6. What external paths may a task use by default, and how are path authorization and fingerprints shown to the user?
7. Which PDF/DOCX/XLSX validators are local dependencies versus provisioned tools, and how will visual/content evidence be stored?
8. What is the smallest migration that makes one real report task reliable before broadening to arbitrary projects?

## Final assessment

The current codebase is not empty. It already contains real tools, provider paths, event journaling, artifact verification, interruption hooks, context receipts, static/real harness machinery, capability provisioning, MCP/skill support, and a partially corrected honest-status path. The failure mode is architectural integration: the agent has hands, but lacks one durable body that owns task state, capability readiness, evidence, and recovery.

Cherry Studio shows how a desktop product can make providers/MCP/skills/jobs/storage concrete. Cline shows how an execution loop can remain honest through typed events, explicit completion, context artifacts, and host/runtime separation. OpenHands shows why conversation, events, workspace, sandbox, skills, and profiles are separate services. AI Council should adopt these principles incrementally and prove every step through the real HTTP/SSE product path.
