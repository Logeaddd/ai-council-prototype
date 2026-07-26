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
