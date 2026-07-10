import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listGroupSessions, listSessionHistoryCatalogue, loadLiveSessionContext, loadSessionContextArchiveItem, readGroupSession, readSessionContextArchive, searchLiveSessionContext, searchSessionContextArchive, writeContextArchive, writeGroupSession } from "../src/storage.js";

test("group session history lists real saved sessions and reads details", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-history-"));
  const session = {
    id: "session_history_1",
    question: "历史记录测试",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:30.000Z",
    durationMs: 90_000,
    messages: [
      {
        round: 1,
        agentId: "a",
        agentName: "成员 A",
        response: { status: "speak", argument: "真实保存的回答" },
        createdAt: "2026-07-08T10:00:20.000Z",
        durationMs: 20_000
      }
    ],
    finalDecision: {
      final_state: "usable_with_risks",
      answer: "真实保存的结论",
      durationMs: 10_000
    }
  };

  writeGroupSession(session, tmp);

  const history = listGroupSessions(tmp);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "session_history_1");
  assert.equal(history[0].question, "历史记录测试");
  assert.equal(history[0].durationMs, 90_000);
  assert.equal(history[0].messageCount, 1);
  assert.equal(history[0].rounds, 1);
  assert.equal(history[0].finalState, "usable_with_risks");

  const detail = readGroupSession(tmp, "session_history_1");
  assert.equal(detail.finalDecision.answer, "真实保存的结论");
});

test("group session reader rejects unsafe session ids", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-history-guard-"));
  assert.throws(() => readGroupSession(tmp, "../group"), /Invalid session id/);
});

test("context archive stores index, policy, full rounds, summaries, and attachment originals", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-archive-"));
  const session = {
    id: "session_context_1",
    question: "Context archive test",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:02:00.000Z",
    status: "completed",
    messages: [
      {
        round: 1,
        agentId: "reader",
        agentName: "Reader",
        response: { status: "speak", argument: "Read ATTACHED_FACT and used it." },
        createdAt: "2026-07-08T10:00:30.000Z"
      },
      {
        round: 2,
        agentId: "reader",
        agentName: "Reader",
        response: { status: "skip", reason: "No new change." },
        createdAt: "2026-07-08T10:01:30.000Z"
      }
    ],
    toolExecutionResults: [
      { id: "tool_1", tool: "read_file", round: 1, status: "completed", result: { path: "brief.md" } }
    ],
    finalDecision: {
      final_state: "ready_to_execute",
      answer: "Done"
    }
  };

  writeGroupSession(session, tmp);
  const archive = writeContextArchive(session, tmp, {
    attachments: [
      {
        name: "brief.md",
        type: "text/markdown",
        sizeBytes: 32,
        content: "ATTACHED_FACT: original saved text"
      }
    ]
  });

  const indexPath = path.join(tmp, "sessions", "session_index.jsonl");
  const index = fs.readFileSync(indexPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const roundFull = JSON.parse(fs.readFileSync(path.join(tmp, "sessions", "session_context_1", "round_1_full.json"), "utf8"));
  const roundSummary = JSON.parse(fs.readFileSync(path.join(tmp, "sessions", "session_context_1", "round_1_summary.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "sessions", "session_context_1", "files", "file_manifest.json"), "utf8"));
  const original = fs.readFileSync(path.join(tmp, "sessions", "session_context_1", manifest.files[0].storedPath), "utf8");
  const readable = readSessionContextArchive(tmp, "session_context_1");

  assert.equal(index.length, 1);
  assert.equal(index[0].sessionId, "session_context_1");
  assert.equal(index[0].roundCount, 2);
  assert.equal(index[0].contextPolicyPath, "sessions/session_context_1/context_policy.json");
  assert.equal(roundFull.messages[0].response.argument.includes("ATTACHED_FACT"), true);
  assert.equal(roundFull.toolExecutionResults.length, 1);
  assert.equal(roundSummary.source, "deterministic_summary");
  assert.equal(manifest.files[0].originalName, "brief.md");
  assert.equal(original, "ATTACHED_FACT: original saved text");
  assert.equal(readable.contextPolicy.hiddenChainOfThought, "not_stored_or_shared");
  assert.equal(readable.rounds.length, 2);
  assert.equal(archive.indexRecord.fullSessionPath, "sessions/session_context_1.json");
});

test("context archive reader rejects unsafe ids", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-archive-guard-"));
  assert.throws(() => readSessionContextArchive(tmp, "../session"), /Invalid session id/);
});

test("context archive keyword search returns public snippets without private inbox data", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-search-"));
  const session = {
    id: "session_search_1",
    question: "Plan the retrieval feature.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:02:00.000Z",
    status: "completed",
    messages: [
      {
        round: 1,
        agentId: "builder",
        agentName: "Builder",
        response: { status: "speak", argument: "ARCHIVE_PUBLIC_FACT belongs in public search." },
        createdAt: "2026-07-08T10:00:30.000Z"
      }
    ],
    finalDecision: {
      final_state: "ready_to_execute",
      answer: "Use public archive retrieval."
    }
  };

  writeGroupSession(session, tmp);
  writeContextArchive(session, tmp, {
    attachments: [
      {
        name: "notes.md",
        type: "text/markdown",
        sizeBytes: 32,
        content: "ARCHIVE_ATTACHMENT_FACT saved as an attachment summary."
      }
    ]
  });
  fs.mkdirSync(path.join(tmp, "members", "Builder", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "members", "Builder", "inbox", "private-chat.jsonl"), "PRIVATE_ONLY_FACT", "utf8");

  const publicHits = searchSessionContextArchive(tmp, "archive public", { limit: 5 });
  const attachmentHits = searchSessionContextArchive(tmp, "attachment", { limit: 5 });
  const privateHits = searchSessionContextArchive(tmp, "PRIVATE_ONLY_FACT", { limit: 5 });
  const combined = JSON.stringify([...publicHits, ...attachmentHits]);

  assert.ok(publicHits.length >= 1);
  assert.ok(attachmentHits.some((hit) => hit.sourceType === "attachment_summary"));
  assert.match(combined, /ARCHIVE_PUBLIC_FACT|ARCHIVE_ATTACHMENT_FACT/);
  assert.doesNotMatch(combined, /PRIVATE_ONLY_FACT/);
  assert.equal(privateHits.length, 0);
});

test("context archive item loader reads public round by session and round only", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-load-"));
  const session = {
    id: "session_load_1",
    question: "Load archived round.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:02:00.000Z",
    status: "completed",
    messages: [
      {
        round: 1,
        agentId: "builder",
        agentName: "Builder",
        response: { status: "speak", argument: "LOAD_CONTEXT_PUBLIC_FACT is in the public archived round." },
        createdAt: "2026-07-08T10:00:30.000Z"
      }
    ],
    finalDecision: {
      final_state: "ready_to_execute",
      answer: "Round can be loaded."
    }
  };

  writeContextArchive(session, tmp);
  fs.mkdirSync(path.join(tmp, "members", "Builder", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "members", "Builder", "inbox", "private-chat.jsonl"), "LOAD_CONTEXT_PRIVATE_FACT", "utf8");

  const round = loadSessionContextArchiveItem(tmp, { sessionId: "session_load_1", round: 1 });
  const summary = loadSessionContextArchiveItem(tmp, { sessionId: "session_load_1" });
  const roundText = JSON.stringify(round);
  const summaryText = JSON.stringify(summary);

  assert.equal(round.ok, true);
  assert.equal(round.sourceType, "round_full");
  assert.match(roundText, /LOAD_CONTEXT_PUBLIC_FACT/);
  assert.doesNotMatch(roundText, /LOAD_CONTEXT_PRIVATE_FACT/);
  assert.equal(summary.sourceType, "session_archive");
  assert.match(summaryText, /round_1_summary\.json/);
  assert.throws(() => loadSessionContextArchiveItem(tmp, { sessionId: "../bad", round: 1 }), /Invalid session id/);
  assert.throws(() => loadSessionContextArchiveItem(tmp, { sessionId: "session_load_1", round: "../1" }), /Invalid archive round/);
});

test("history catalogue and archive search expose public execution records", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-history-catalogue-"));
  const session = {
    id: "session_history_catalogue_1",
    question: "Build the prior artifact.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:02:00.000Z",
    status: "completed",
    messages: [{ round: 1, agentId: "builder", agentName: "Builder", response: { status: "speak", argument: "The task is complete." } }],
    fileOperationExecutionResults: [{ round: 1, source_agent_id: "builder", action: "write", path: "build/prior-artifact.jar", result: { status: "written" } }],
    finalDecision: { final_state: "ready_to_execute", answer: "Stored." }
  };
  writeGroupSession(session, tmp);
  writeContextArchive(session, tmp);

  const catalogue = listSessionHistoryCatalogue(tmp);
  const hits = searchSessionContextArchive(tmp, "prior artifact", { limit: 5 });
  const loaded = loadSessionContextArchiveItem(tmp, { sessionId: session.id, round: 1 });

  assert.equal(catalogue[0].sessionId, session.id);
  assert.equal(catalogue[0].question, "Build the prior artifact.");
  assert.ok(hits.some((hit) => hit.sourceType === "round_full" && /prior-artifact\.jar/.test(hit.snippet)));
  assert.match(JSON.stringify(loaded), /prior-artifact\.jar/);
});

test("live session history searches and loads only visible public discussion", () => {
  const session = {
    id: "session_live_history_1",
    question: "Current long-running task.",
    createdAt: "2026-07-08T10:00:00.000Z",
    status: "running",
    messages: [
      { round: 1, agentId: "builder", agentName: "Builder", response: { status: "speak", argument: "LIVE_PUBLIC_FACT from the first round." } },
      { round: 2, agentId: "reviewer", agentName: "Reviewer", response: { status: "speak", argument: "REVIEWER_ONLY_FACT." } }
    ],
    toolExecutionResults: [{ round: 1, source_agent_id: "builder", tool: "run_tests", result: { stdout: "LIVE_TEST_FACT" } }]
  };

  const allHits = searchLiveSessionContext(session, "live public", { agent: { id: "reviewer" }, transcriptVisibility: "full" });
  const ownHits = searchLiveSessionContext(session, "live public", { agent: { id: "reviewer" }, transcriptVisibility: "own" });
  const fullRound = loadLiveSessionContext(session, { sessionId: session.id, round: 1 }, { agent: { id: "reviewer" }, transcriptVisibility: "full" });
  const ownSession = loadLiveSessionContext(session, { sessionId: session.id }, { agent: { id: "reviewer" }, transcriptVisibility: "own" });

  assert.ok(allHits.some((hit) => /LIVE_PUBLIC_FACT/.test(hit.snippet)));
  assert.equal(ownHits.length, 0);
  assert.match(JSON.stringify(fullRound), /LIVE_PUBLIC_FACT/);
  assert.doesNotMatch(JSON.stringify(ownSession), /LIVE_PUBLIC_FACT/);
  assert.match(JSON.stringify(ownSession), /REVIEWER_ONLY_FACT/);
});
