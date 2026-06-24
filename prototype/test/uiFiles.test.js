import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = path.resolve(".");

test("minimal UI files exist", () => {
  for (const file of ["public/index.html", "public/styles.css", "public/app.js", "src/server.js"]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
  }
});

test("UI keeps speaker-prefix rendering visible", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /displayText/);
});

test("UI exposes review and finalize draft actions", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /approveReview/);
  assert.match(appJs, /finalize/);
});

test("UI includes global Chinese and English language switch", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /id="langZh"/);
  assert.match(html, /id="langEn"/);
  assert.match(appJs, /zh:/);
  assert.match(appJs, /en:/);
});

test("UI script parses cleanly", () => {
  const result = spawnSync(process.execPath, ["--check", path.join(root, "public", "app.js")], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("UI precondition errors are handled inside busy wrappers", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.doesNotMatch(appJs, /async function createDraft\(\) \{\s*if \(!state\.groupPath\)/);
  assert.doesNotMatch(appJs, /async function replaceMember\(\) \{\s*if \(!state\.groupPath\)/);
});

test("UI renders per-agent status indicators", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(appJs, /agentStatuses/);
  assert.match(appJs, /statusMarkup/);
  assert.match(css, /checkmark/);
  assert.match(css, /dots/);
});

test("UI surfaces per-member context status without visible protocol copy", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(appJs, /contextStatuses/);
  assert.match(appJs, /rememberContextStatus\(event\.agentId, event\.agentName, event\.contextStatus\)/);
  assert.match(appJs, /rememberContextStatus\(event\.message\.agentId, event\.message\.agentName, event\.message\.contextStatus\)/);
  assert.match(appJs, /contextStatusTitle/);
  assert.match(appJs, /budgetStatus/);
  assert.match(appJs, /budgetStatusLabelKey/);
  assert.match(appJs, /has-core-overflow/);
  assert.match(appJs, /context-\$\{status\}/);
  assert.match(css, /\.seat\.context-warning/);
  assert.match(css, /\.seat\.context-compress/);
  assert.match(css, /\.seat\.has-core-overflow/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "public", "index.html"), "utf8"), /Non-compressible core|providerCacheBreakpoint|effectiveInputLimit/);
});

test("UI shows compact group usage without protocol copy", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="usageSummary"/);
  assert.match(appJs, /refreshUsageSummary/);
  assert.match(appJs, /\/api\/usage\?groupPath=/);
  assert.match(appJs, /usageSnapshot/);
  assert.match(appJs, /formatCompactNumber/);
  assert.match(css, /\.usage-summary/);
  assert.doesNotMatch(html, /estimatedInputTokens|coreOverflowCount|providerCacheBreakpoint/);
});

test("UI uses a council table layout with ordered seats", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /poker-stage/);
  assert.match(html, /council-table/);
  assert.match(html, /strict-horizontal-table/);
  assert.doesNotMatch(html, /AI Council Round table/);
  assert.match(html, /seat-ring/);
  assert.match(html, /owner-seat/);
  assert.match(appJs, /seat-number/);
  assert.match(appJs, /MAX_AGENT_SEATS = 7/);
  assert.match(appJs, /pos-\$\{index \+ 1\}/);
  assert.match(css, /\.seat\.pos-1/);
  assert.match(css, /\.seat\.pos-7/);
  assert.doesNotMatch(css, /\.seat\.pos-8/);
  assert.match(css, /--black: #050505/);
  assert.match(css, /--white: #ffffff/);
  assert.match(css, /--seat-empty: rgba\(168, 174, 184, 0\.46\)/);
  assert.match(css, /--accent: #166a56/);
  assert.match(css, /border: calc\(16px \* var\(--table-scale\)\) solid var\(--black\)/);
});

test("UI exposes a Codex-like project sidebar for groups", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /class="project-sidebar"/);
  assert.match(html, /id="pinnedGroups"/);
  assert.match(html, /id="sidebarGroups"/);
  assert.match(html, /id="groupSearch"/);
  assert.match(html, /id="groupMenu"/);
  assert.match(html, /data-group-action="removeRecord"/);
  assert.match(appJs, /refreshGroupIndex/);
  assert.match(appJs, /renderGroupSidebar/);
  assert.match(appJs, /\/api\/groups-index/);
  assert.match(appJs, /\/api\/groups-index\/remove/);
  assert.match(appJs, /groupRecordRemoved/);
  assert.match(css, /\.app\s*\{[\s\S]*grid-template-columns: 260px minmax\(0, 1fr\)/);
  assert.match(css, /\.project-sidebar/);
  assert.match(css, /\.workspace-shell/);
  assert.deepEqual(css.match(/--black:\s*[^;]+/g), ["--black: #050505"]);
  assert.deepEqual(css.match(/--white:\s*[^;]+/g), ["--white: #ffffff"]);
  assert.deepEqual(css.match(/--seat-empty:\s*[^;]+/g), ["--seat-empty: rgba(168, 174, 184, 0.46)"]);
  assert.deepEqual(css.match(/--accent:\s*[^;]+/g), ["--accent: #166a56"]);
});

test("UI fixes the required horizontal poker-table seat geometry", () => {
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(css, /--table-w: calc\(760px \* var\(--table-scale\)\)/);
  assert.match(css, /--table-h: calc\(460px \* var\(--table-scale\)\)/);
  assert.match(css, /\.owner-seat\s*\{[\s\S]*left: calc\(50% - 316px \* var\(--table-scale\)\);[\s\S]*top: 50%;/);
  assert.match(css, /\.seat\.pos-1\s*\{[^}]*left: calc\(50% - 180px \* var\(--table-scale\)\);[^}]*top: calc\(50% - 171px \* var\(--table-scale\)\);/);
  assert.match(css, /\.seat\.pos-2\s*\{[^}]*left: 50%;[^}]*top: calc\(50% - 171px \* var\(--table-scale\)\);/);
  assert.match(css, /\.seat\.pos-3\s*\{[^}]*left: calc\(50% \+ 180px \* var\(--table-scale\)\);[^}]*top: calc\(50% - 171px \* var\(--table-scale\)\);/);
  assert.match(css, /\.seat\.pos-4\s*\{[^}]*left: calc\(50% \+ 316px \* var\(--table-scale\)\);[^}]*top: 50%;/);
  assert.match(css, /\.seat\.pos-5\s*\{[^}]*left: calc\(50% \+ 180px \* var\(--table-scale\)\);[^}]*top: calc\(50% \+ 171px \* var\(--table-scale\)\);/);
  assert.match(css, /\.seat\.pos-6\s*\{[^}]*left: 50%;[^}]*top: calc\(50% \+ 171px \* var\(--table-scale\)\);/);
  assert.match(css, /\.seat\.pos-7\s*\{[^}]*left: calc\(50% - 180px \* var\(--table-scale\)\);[^}]*top: calc\(50% \+ 171px \* var\(--table-scale\)\);/);
  assert.match(css, /\.seat\.pos-4 \.seat-nameplate\s*\{[\s\S]*left: calc\(100% \+ 8px \* var\(--table-scale\)\);[\s\S]*right: auto;[\s\S]*text-align: left;/);
  assert.doesNotMatch(css, /\.seat\.pos-4 \.seat-nameplate\s*\{[\s\S]*right: calc\(100% \+ 8px \* var\(--table-scale\)\)/);
});

test("UI defaults to Chinese and can configure empty API seats", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /lang: "zh"/);
  assert.match(appJs, /state\.customSeats = loadScopedJson\("custom-seats", \{\}, group\)/);
  assert.match(appJs, /saveScopedJson\("custom-seats", state\.customSeats\)/);
  assert.match(appJs, /state\.customSeats\[seatId\] = \{/);
  assert.match(appJs, /isCustom: true/);
});

test("UI preserves dissent, degraded, and final decision states", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="decisionPanel"/);
  assert.match(appJs, /renderDecisionPanel/);
  assert.match(appJs, /final_state/);
  assert.match(appJs, /finalStateBadge/);
  assert.match(appJs, /blocking_issues/);
  assert.match(appJs, /decisionIssueCard/);
  assert.match(appJs, /minority_report/);
  assert.match(appJs, /degraded/);
  assert.match(appJs, /cancelled/);
  assert.match(css, /final-state-badge/);
  assert.match(css, /blocking-card/);
  assert.match(css, /is-red-team/);
  assert.match(css, /has-dissent/);
  assert.match(css, /xmark/);
});

test("UI exposes changes requested draft filtering", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(html, /data-filter="changes_requested"/);
});

test("UI exposes poker-table controls for avatars, muting, and decisions", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="ownerDialogAvatar"/);
  assert.match(html, /id="tableZoom"/);
  assert.match(html, /id="seatMenu"/);
  assert.match(html, /id="ownerDialog"/);
  assert.match(html, /id="bossInterjection"/);
  assert.match(html, /class="conversation-composer"/);
  assert.match(html, /data-seat-action="kick"/);
  assert.match(html, /data-seat-action="stopOne"/);
  assert.match(html, /data-seat-action="muteRound"/);
  assert.match(html, /data-seat-action="muteForever"/);
  assert.match(html, /data-seat-action="configure"/);
  assert.match(html, /data-seat-action="permission"/);
  assert.match(html, /id="confirmDecision"/);
  assert.match(appJs, /saveOwnerConfig/);
  assert.match(appJs, /togglePause/);
  assert.match(appJs, /sendBossInterjection/);
  assert.match(appJs, /handleContextMenu/);
  assert.match(appJs, /handleSeatRightPress/);
  assert.match(appJs, /document\.addEventListener\("pointerdown", handleSeatRightPress, true\)/);
  assert.match(appJs, /document\.addEventListener\("mousedown", handleSeatRightPress, true\)/);
  assert.match(appJs, /event\.button !== 2/);
  assert.match(appJs, /document\.addEventListener\("contextmenu", handleContextMenu, true\)/);
  assert.match(appJs, /node\.dataset\.emptyIndex = String\(index\)/);
  assert.match(appJs, /event\.target\.closest\("\.seat\[data-seat-id\]"\)/);
  assert.match(appJs, /stopSelectedAgent/);
  assert.match(appJs, /confirmDecision/);
  assert.match(css, /owner-seat/);
  assert.match(css, /\.agent-status/);
  assert.match(css, /permission-badge/);
  assert.match(css, /\.seat-menu\s*\{[\s\S]*z-index: 1000/);
  assert.match(css, /\.seat-menu\s*\{[\s\S]*min-width: 132px/);
});

test("UI supports non-persistent batch seat health checks (D058)", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="checkAllSeats"/);
  assert.match(html, /data-i18n="checkAllSeats"/);
  assert.match(appJs, /seatHealthStatuses: \{\}/);
  assert.match(appJs, /seatHealthChecking: false/);
  assert.match(appJs, /checkAllSeats"\)\.addEventListener\("click"/);
  assert.match(appJs, /async function checkSeatHealth\(seat, options = \{\}\)/);
  assert.match(appJs, /async function checkAllSeatsHealth\(options = \{\}\)/);
  assert.match(appJs, /state\.seatHealthStatuses\[seat\.seatId\] = health/);
  assert.match(appJs, /checkAllSeatsHealth\(\{ silent: true \}\)\.catch/);
  assert.match(appJs, /checkSeatHealth\(findSeat\(seatId\), \{ silent: true \}\)/);
  assert.match(appJs, /setStatusText/);
  assert.match(appJs, /checkAllSeats: "\\u68c0\\u67e5\\u6240\\u6709\\u5e2d\\u4f4d"/);
  assert.match(appJs, /checkingSeats: "\\u6b63\\u5728\\u68c0\\u67e5\\u5e2d\\u4f4d/);
  assert.match(appJs, /seatHealthFailed/);
  assert.match(appJs, /seatHealthSummary/);
  assert.match(appJs, /checkAllSeats: "Check All Seats"/);
  assert.match(css, /\.health-warning\s*\{[\s\S]*background: var\(--warn\)/);
  assert.match(css, /\.agent-status/);
  assert.doesNotMatch(appJs, /saveScopedJson\("seat-health/);
  assert.doesNotMatch(appJs, /loadScopedJson\("seat-health/);
  assert.doesNotMatch(appJs, /saveJson\("ai-council-seat-health/);
});

test("UI shows health warnings in the existing status slot with speaking priority", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /const healthStatus = getSeatHealthStatus\(seat\.seatId\)/);
  assert.match(appJs, /seatStatusTitle\(status, healthStatus\)/);
  assert.match(appJs, /statusMarkup\(status, healthStatus\)/);
  assert.match(appJs, /function seatStatusTitle\(status, healthStatus\)/);
  assert.match(appJs, /if \(status === "idle" && healthStatus && healthStatus\.ok === false\)/);
  assert.match(appJs, /function statusMarkup\(status, healthStatus = null\) \{\s*if \(status === "working"\)/);
  assert.match(appJs, /if \(status === "done"\) return '<span class="checkmark">&#10003;<\/span>'/);
  assert.match(appJs, /if \(status === "spoke"\) return '<span class="checkmark">&#10003;<\/span>'/);
  assert.match(appJs, /if \(healthStatus && healthStatus\.ok === false\) return '<span class="health-warning">&#9888;<\/span>'/);
  assert.match(appJs, /return '<span class="idle-dot"><\/span>'/);
});

test("UI skips unhealthy seats for the current round without mutating persistent mutes", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /async function confirmUnhealthySeatSkip\(\)/);
  assert.match(appJs, /getSeatHealthStatus\(seat\.seatId\)\?\.ok === false/);
  assert.match(appJs, /\.join\("、"\)/);
  assert.match(appJs, /appendSystemMessage\(t\("unhealthySeatsSkipped"/);
  assert.match(appJs, /return unhealthySeats\.map\(\(seat\) => seat\.seatId\)/);
  assert.match(appJs, /const skipSeatsThisRound = await confirmUnhealthySeatSkip\(\)/);
  assert.match(appJs, /if \(skipSeatsThisRound === null\) return/);
  assert.match(appJs, /if \(skipSeatsThisRound\.length >= activeSeats\(\)\.length\)/);
  assert.match(appJs, /noAvailableSeatsAfterHealthCheck/);
  assert.match(appJs, /runtimeGroup: buildRuntimeGroup\(\{ skipSeatsThisRound \}\)/);
  assert.match(appJs, /function buildRuntimeGroup\(options = \{\}\)/);
  assert.match(appJs, /const skipSeatsThisRound = new Set\(options\.skipSeatsThisRound \|\| \[\]\)/);
  assert.match(appJs, /enabled: !state\.mutedSeats\[seat\.seatId\] && !skipSeatsThisRound\.has\(seat\.seatId\)/);
  assert.doesNotMatch(appJs, /state\.mutedSeats\[[^\]]+\]\s*=\s*["']health/);
});

test("UI exposes private chat controls for individual agents", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="privateDialog"/);
  assert.match(html, /id="privateInstruction"/);
  assert.match(appJs, /state\.privateChats = loadScopedJson\("private-chats"/);
  assert.match(appJs, /seat\.seatId \|\| seat\.id \|\| seatIdForIndex\(index\)/);
  assert.match(appJs, /data-private-seat/);
  assert.match(appJs, /sendPrivateInstruction/);
  assert.match(appJs, /appendSystemMessage\(t\("privateSent", \{ name: seat\.displayName \|\| seatId \}\)\)/);
  assert.match(appJs, /setStatusText\(t\("privateSent", \{ name: seat\.displayName \|\| seatId \}\)\)/);
  assert.doesNotMatch(appJs, /setStatus\("privateSent", seat\.displayName \|\| seatId\)/);
  assert.match(css, /private-chat-button/);
  assert.match(css, /private-chat-log/);
});

test("UI has a boss-driven round state machine with abortable requests", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /id="stopCouncil"/);
  assert.match(html, /data-i18n-placeholder="bossInput"/);
  assert.match(appJs, /roundState: "idle"/);
  assert.match(appJs, /setRoundState\("waiting_boss"\)/);
  assert.match(appJs, /setRoundState\("running"\)/);
  assert.match(appJs, /setRoundState\("paused"\)/);
  assert.match(appJs, /pausedAgentId/);
  assert.match(appJs, /startAtAgentId: agentId/);
  assert.match(appJs, /resumeInstruction: t\("resumeDiscussion"\)/);
  assert.match(appJs, /setRoundState\("round_done"\)/);
  assert.match(appJs, /new AbortController\(\)/);
  assert.match(appJs, /requestOptions\.signal = options\.signal/);
  assert.match(appJs, /streamCouncilEvents/);
  assert.match(appJs, /\/api\/council\/events/);
  assert.match(appJs, /handleCouncilEvent/);
  assert.match(appJs, /currentAgentId/);
  assert.match(appJs, /globalRequirement: state\.globalRequirement/);
});

test("UI exposes configurable autonomous round count", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="autonomousRounds"/);
  assert.match(html, /id="autonomousRounds"[^>]*value="10"/);
  assert.match(html, /review-intensity-1/);
  assert.match(appJs, /autonomousRounds: Number\(loadScopedValue\("autonomous-rounds", 10/);
  assert.match(appJs, /saveScopedValue\("autonomous-rounds", String\(state\.autonomousRounds\)\)/);
  assert.match(appJs, /maxRounds: state\.autonomousRounds/);
  assert.match(appJs, /updateAutonomousRounds/);
  assert.match(appJs, /normalizeRoundCount/);
  assert.match(css, /rounds-control/);
});

test("UI exposes confirmed global requirement control", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="globalRequirement"/);
  assert.match(html, /id="saveGlobalRequirement"/);
  assert.match(appJs, /saveGlobalRequirement/);
  assert.match(appJs, /\/api\/group\/global-requirement/);
  assert.match(appJs, /group\.settings\?\.globalRequirement/);
  assert.match(css, /requirement-section/);
});

test("UI exposes permission tiers with git gate", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /id="globalPermissionTier"/);
  assert.match(html, /id="applyGlobalPermission"/);
  assert.match(html, /id="dialogPermissionTier"/);
  assert.match(appJs, /applyGlobalPermission/);
  assert.match(appJs, /saveSeatPermission/);
  assert.match(appJs, /\/api\/git\/status/);
  assert.match(appJs, /\/api\/group\/permissions/);
  assert.match(appJs, /highRiskPermissionConfirm/);
  assert.match(appJs, /permissionTierNumber/);
});

test("UI wires explicit reviewer toggle and review-intensity slider (D055)", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /id="dialogReviewer"[^>]*type="checkbox"/);
  assert.match(html, /id="dialogReviewIntensity"[^>]*type="range"/);
  assert.match(html, /min="1"[^>]*max="3"/);
  assert.match(html, /id="dialogReviewIntensityValue"/);
  assert.match(html, /id="reviewIntensityNote"/);
  assert.match(html, /data-i18n="setReviewer"/);
  assert.match(html, /data-i18n="reviewIntensity"/);
  assert.match(appJs, /setReviewer: "\\u8bbe\\u4e3a\\u5ba1\\u67e5\\u8005"/);
  assert.match(appJs, /setReviewer: "Set as reviewer"/);
  assert.match(appJs, /reviewIntensity: "\\u5ba1\\u67e5\\u529b\\u5ea6"/);
  assert.match(appJs, /reviewIntensity: "Review intensity"/);
  assert.match(appJs, /dialogReviewer"\)\.checked = Boolean/);
  assert.match(appJs, /dialogReviewer"\)\.addEventListener\("change"/);
  assert.match(appJs, /dialogReviewIntensity"\)\.value = /);
  assert.match(appJs, /updateReviewIntensityDisplay/);
  assert.match(appJs, /slider\.disabled = !enabled/);
  assert.match(appJs, /saveScopedJson\("seat-overrides", state\.seatOverrides\)/);
  assert.match(appJs, /mandatoryRedTeam: reviewer/);
  assert.match(appJs, /reviewer && reviewIntensity \? \{ reviewIntensity \} : \{\}/);
  assert.doesNotMatch(appJs, /function isDissentRole/);
  assert.doesNotMatch(appJs, /function isJudgeRole/);
  assert.doesNotMatch(appJs, /function ensureRuntimeRoles/);
  assert.match(appJs, /dialogReviewIntensity"\)\.addEventListener\("input"/);
});

test("UI supports windowed table and transcript controls", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const requirementHeader = html.match(/<section class="panel-section requirement-section">[\s\S]*?<div class="panel-head"[^>]*>/)?.[0] ?? "";
  const transcriptHeader = html.match(/<section class="panel-section transcript-section">[\s\S]*?<div class="panel-head"[^>]*>/)?.[0] ?? "";
  assert.match(html, /data-window-target="table"/);
  assert.match(html, /data-window-target="transcript"/);
  assert.match(html, /data-window-action="popout"/);
  assert.match(html, /data-window-action="fullscreen"/);
  assert.match(html, /data-window-action="restore"/);
  assert.match(html, /data-window-drag="table"/);
  assert.match(html, /data-window-drag="transcript"/);
  assert.doesNotMatch(requirementHeader, /data-window-drag="transcript"/);
  assert.match(transcriptHeader, /data-window-drag="transcript"/);
  assert.match(html, /id="tableResizeHandle"/);
  assert.match(html, /data-resize-edge="right"/);
  assert.match(html, /data-resize-edge="bottom"/);
  assert.doesNotMatch(html, />\s*&#20840;&#23631;&#26174;&#31034;\s*</);
  assert.match(appJs, /windowLayout: loadScopedJson\("window-layout", defaultWindowLayout\(\)/);
  assert.match(appJs, /stageWidth/);
  assert.match(appJs, /handleWindowAction/);
  assert.match(appJs, /startWindowDrag/);
  assert.match(appJs, /positions/);
  assert.match(appJs, /applyWindowLayout/);
  assert.match(appJs, /startTableResize/);
  assert.match(appJs, /setPointerCapture/);
  assert.match(appJs, /data-resize-edge/);
  assert.match(css, /\.table-zone\.is-popout/);
  assert.match(css, /\.table-zone\.is-fullscreen/);
  assert.match(css, /\.transcript-section\.is-popout/);
  assert.match(css, /\.transcript-section\.is-fullscreen/);
  assert.match(css, /cursor: move/);
  assert.match(css, /resize-handle/);
  assert.match(css, /resize-edge-right/);
  assert.match(css, /resize-edge-bottom/);
});

test("UI keeps table and transcript messages inside scroll containers", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(css, /\.table-conversation\s*\{[\s\S]*overflow: auto/);
  assert.match(css, /\.conversation\s*\{[\s\S]*overflow: auto/);
  assert.match(css, /\.right-panel\s*\{[\s\S]*overflow: hidden/);
  assert.match(css, /\.main-grid\s*\{[\s\S]*height: calc\(100vh - var\(--command-bar-h\)\)/);
  assert.match(css, /\.panel-section\s*\{[\s\S]*overflow: hidden/);
  assert.match(css, /\.right-panel\s*\{[\s\S]*grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(css, /--right-panel-w: 420px/);
  assert.match(css, /\.panel-tray/);
  assert.match(css, /\.tool-panel/);
  assert.match(appJs, /uiLayout: normalizeUiLayout\(loadJson\("ai-council-ui-layout", defaultUiLayout\(\)\)\)/);
  assert.match(appJs, /startRightPanelResize/);
  assert.match(appJs, /startToolPanelDrag/);
  assert.match(appJs, /startToolPanelResize/);
  assert.match(appJs, /isNearBottom/);
  assert.match(appJs, /scrollToLatest/);
  assert.match(appJs, /scrollTop = node\.scrollHeight/);
});


test("UI keeps the right side transcript-only and moves tools into panels", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const rightPanel = html.match(/<aside class="right-panel transcript-only"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.match(html, /class="workspace-tools"/);
  assert.match(html, /id="toolPanels"/);
  assert.match(html, /id="panelTray"/);
  assert.match(rightPanel, /id="conversation"/);
  assert.match(rightPanel, /id="bossInterjection"/);
  assert.doesNotMatch(rightPanel, /id="globalRequirement"/);
  assert.doesNotMatch(rightPanel, /id="decisionPanel"/);
  assert.doesNotMatch(rightPanel, /id="replaceMember"/);
  const workspaceTools = html.match(/<nav class="workspace-tools"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.doesNotMatch(workspaceTools, /data-open-panel="members"/);
  assert.match(html, /data-i18n="memberManagement"/);
  assert.match(html, /data-open-panel="requirement"/);
  assert.match(html, /data-open-panel="decisions"/);
  assert.match(html, /data-open-panel="settings"/);
  assert.match(appJs, /handleOpenToolPanel/);
  assert.match(appJs, /document\.querySelectorAll\("\[data-open-panel\]"\)/);
  assert.match(appJs, /document\.querySelectorAll\("\[data-panel-drag\]"\)/);
  assert.match(appJs, /document\.querySelectorAll\("\[data-panel-resize\]"\)/);
  assert.match(appJs, /window\.addEventListener\("resize", handleUiViewportChange\)/);
  assert.match(appJs, /updateCommandBarHeight/);
  assert.match(appJs, /saveUiLayoutDebounced/);
  assert.match(appJs, /normalizeUiLayout/);
  assert.match(appJs, /window\.addEventListener\("beforeunload", saveUiLayout\)/);
  assert.match(css, /--command-bar-h: 89px/);
  assert.match(css, /\.mode-controls\s*\{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(css, /height: calc\(100vh - var\(--command-bar-h\)\)/);
  assert.match(css, /\.workspace-tools/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.right-panel-resize/);
});

test("UI uses clear decision action labels", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /data-i18n="prepareStandards"/);
  assert.match(html, /data-i18n-title="prepareStandardsTitle"/);
  assert.match(html, /data-i18n="approveStandards"/);
  assert.match(html, /data-i18n-title="approveStandardsTitle"/);
  assert.match(html, /data-i18n="confirmDecision"/);
  assert.match(html, /data-i18n-title="confirmDecisionTitle"/);
  assert.match(appJs, /prepareStandards: "\\u751f\\u6210\\u6267\\u884c\\u6807\\u51c6"/);
  assert.match(appJs, /approveStandards: "\\u786e\\u8ba4\\u6807\\u51c6"/);
  assert.match(appJs, /confirmDecision: "\\u4fdd\\u5b58\\u672c\\u6b21\\u7ed3\\u8bba"/);
});
test("UI records a visible interrupted message for single-agent stop", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /appendInterruptedMessage/);
  assert.match(appJs, /partialMessages/);
  assert.match(appJs, /agent_delta/);
  assert.match(appJs, /handleAgentDelta/);
  assert.match(appJs, /upsertStreamMessage/);
  assert.match(appJs, /removePartialMessage/);
  assert.match(appJs, /stoppedByBoss/);
  assert.match(appJs, /stopOnlyCurrentAgent/);
  assert.match(appJs, /state\.currentRoundController\?\.abort\(\)/);
  assert.match(appJs, /startAfterAgentId: seatId/);
  assert.match(appJs, /continuation: true/);
  assert.match(appJs, /silentBusy: true/);
  assert.match(appJs, /hasNextActiveSeat/);
});

test("UI prevents empty boss starts and empty councils", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /emptyBossInput/);
  assert.match(appJs, /emptyCouncil/);
  assert.match(appJs, /if \(!bossText\) throw new Error\(t\("emptyBossInput"\)\)/);
  assert.match(appJs, /if \(!activeSeats\(\)\.length\) throw new Error\(t\("emptyCouncil"\)\)/);
  assert.doesNotMatch(html, /id="runMock"/);
  assert.match(appJs, /\$\("sendBossInterjection"\)\.disabled = !hasGroup \|\| !hasAgents/);
});

test("UI carries previous final answer into cycle continuation requests", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /cycleContinuation: null/);
  assert.match(appJs, /buildCycleContinuationContext/);
  assert.match(appJs, /previousSessionId: session\.id/);
  assert.match(appJs, /finalAnswer: final\.answer/);
  assert.match(appJs, /continuationContext: state\.cycleContinuation/);
  assert.match(appJs, /continuationContext,/);
  assert.match(appJs, /appendSystemMessage\(t\("continuationNotice"/);
  assert.match(appJs, /state\.cycleContinuation \? t\("continuationPlaceholder"\) : t\("bossInput"\)/);
  assert.match(appJs, /state\.cycleContinuation = buildCycleContinuationContext\(state\.lastSession, result\)/);
});

test("UI removes duplicate group fields and stores API key in seat config", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const commandBar = html.match(/<header class="command-bar">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(html, /id="groupDialog"/);
  assert.match(html, /class="seat-dialog group-dialog"/);
  assert.match(html, /id="groupPath"/);
  assert.match(html, /id="chooseGroupFolder"/);
  assert.doesNotMatch(commandBar, /id="groupPath"/);
  assert.doesNotMatch(commandBar, /id="chooseGroupFolder"/);
  assert.doesNotMatch(html, /id="members"/);
  assert.doesNotMatch(html, /id="root"/);
  assert.doesNotMatch(html, /id="groupFolder"/);
  assert.match(html, /class="seat-dialog seat-config-dialog"/);
  assert.match(html, /id="dialogApiKey"/);
  assert.match(html, /id="dialogProviderPreset"/);
  assert.match(html, /id="detectProviderModels"/);
  assert.match(html, /id="checkProviderHealth"/);
  assert.match(html, /id="useOfficialProviderUrl"/);
  assert.match(html, /id="clearGroupApiKeys"/);
  assert.match(html, /id="dialogModelName"/);
  assert.match(html, /id="dialogModelCandidates"/);
  assert.match(html, /data-i18n="detectedModels"/);
  assert.match(html, /review-intensity-1/);
  assert.match(appJs, /apiKey/);
  assert.match(appJs, /clearCurrentGroupApiKeys/);
  assert.match(appJs, /buildRuntimeGroup/);
  assert.match(appJs, /runtimeGroup: buildRuntimeGroup\(\)/);
  assert.match(appJs, /configuredApiBaseUrl/);
  assert.match(appJs, /provider: configuredApiBaseUrl && apiKey \? "openai-compatible" : "mock"/);
  assert.match(appJs, /dialogModelName/);
  assert.match(appJs, /\/api\/providers/);
  assert.match(appJs, /\/api\/models\/discover/);
  assert.match(appJs, /\/api\/models\/health/);
  assert.match(appJs, /providerDetected/);
  assert.match(appJs, /providerHealthOk/);
  assert.match(appJs, /loadProviderPresets\(\)\.catch/);
  assert.match(appJs, /dialogProviderPreset"\)\.addEventListener\("change", handleProviderPresetChange\)/);
  assert.match(appJs, /checkProviderHealth"\)\.addEventListener\("click"/);
  assert.match(appJs, /detectProviderModels"\)\.addEventListener\("click"/);
  assert.match(appJs, /dialogModelCandidates"\)\.addEventListener\("change", handleDetectedModelChoice\)/);
  assert.match(appJs, /renderDetectedModelOptions\(result\.models \|\| \[\]/);
  assert.match(appJs, /function handleDetectedModelChoice\(\)/);
  assert.doesNotMatch(appJs, /result\.models\?\.length\) \$\("dialogModelName"\)\.value = result\.models\[0\]\.id/);
  assert.match(appJs, /providerPreset: configuredProviderPreset/);
  assert.match(appJs, /providerPreset,\s*\n\s*apiUrl,/);
  assert.match(appJs, /splitGroupPath/);
  assert.match(appJs, /\/api\/app-settings/);
  assert.match(appJs, /function loadAppSettings\(\)/);
  assert.match(appJs, /function updateGroupPathPreview\(\)/);
  assert.match(appJs, /function sanitizeGroupFolderName\(value\)/);
  assert.match(appJs, /root: settings\.groupsRoot/);
  assert.match(appJs, /result\.containsGroup/);
  assert.match(appJs, /applyPathToGroupForm\(result\.path\)/);
  assert.match(appJs, /newGroupFromSidebar"\)\.addEventListener\("click", openGroupDialog\)/);
  assert.match(appJs, /function openGroupDialog\(\)/);
  assert.match(appJs, /showModal\(\)/);
  assert.match(appJs, /function closeGroupDialog\(\)/);
});

test("seat model configuration dialog fits provider discovery controls", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /class="provider-actions dialog-wide"/);
  assert.match(html, /id="providerDetectionStatus" class="permission-note provider-detection-status dialog-wide"/);
  assert.match(html, /class="model-candidates-row"/);
  assert.match(css, /\.seat-config-dialog\s*\{[\s\S]*width: min\(720px/);
  assert.match(css, /\.seat-config-dialog\s*\{[\s\S]*max-height: calc\(100vh - 28px\)/);
  assert.match(css, /\.seat-config-dialog\s*\{[\s\S]*overflow: auto/);
  assert.match(css, /\.seat-config-dialog form\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.seat-config-dialog \.dialog-wide\s*\{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.seat-config-dialog form\s*\{[\s\S]*grid-template-columns: 1fr/);
});

test("UI namespaces per-group browser state", () => {
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(appJs, /loadGroupScopedState/);
  assert.match(appJs, /groupStorageKey/);
  assert.match(appJs, /ai-council:\$\{groupIdentity\(group\)\}:\$\{name\}/);
  assert.match(appJs, /return group \? fallback : loadJson\(legacyStorageKey\(name\), fallback\)/);
  assert.match(appJs, /\?\? \(group \? null : localStorage\.getItem\(legacyStorageKey\(name\)\)\)/);
  assert.match(appJs, /saveScopedJson\("seat-overrides"/);
  assert.match(appJs, /saveScopedJson\("custom-seats"/);
  assert.match(appJs, /saveScopedValue\("conversation-mode"/);
  assert.doesNotMatch(appJs, /localStorage\.setItem\("ai-council-conversation-mode"/);
  assert.doesNotMatch(appJs, /localStorage\.setItem\("ai-council-autonomous-rounds"/);
  assert.doesNotMatch(appJs, /saveJson\("ai-council-seat-overrides"/);
  assert.doesNotMatch(appJs, /saveJson\("ai-council-custom-seats"/);
});

test("UI and server expose actual file permission boundaries", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const modelClientJs = fs.readFileSync(path.join(root, "src", "modelClient.js"), "utf8");
  assert.match(html, /apiPermissionNote/);
  assert.match(appJs, /checkPermissions/);
  assert.match(serverJs, /\/api\/permissions/);
  assert.match(serverJs, /canReadLocalFiles: false/);
  assert.match(serverJs, /resolveInside\(allowedWorkspaceRoot/);
  assert.match(modelClientJs, /chat\/completions/);
  assert.match(modelClientJs, /stream: true/);
  assert.match(modelClientJs, /readOpenAiStream/);
  assert.match(modelClientJs, /delta\?\.content/);
  assert.doesNotMatch(modelClientJs, /tools\s*:/);
});

test("UI exposes execution standards and guarded file operation approvals", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  assert.match(html, /id="prepareStandards"/);
  assert.match(html, /id="approveStandards"/);
  assert.match(html, /id="standardsPanel"/);
  assert.match(html, /id="fileOperationsPanel"/);
  assert.match(styles, /file-op-preview/);
  assert.match(appJs, /prepareExecutionStandards/);
  assert.match(appJs, /approveExecutionStandards/);
  assert.match(appJs, /\/api\/execution-standards\/prepare/);
  assert.match(appJs, /\/api\/execution-standards\/approve/);
  assert.match(appJs, /\/api\/file-operations\?groupPath=/);
  assert.match(appJs, /\/api\/file-operations\/approve/);
  assert.match(appJs, /\/api\/file-operations\/auto-approve/);
  assert.match(appJs, /\/api\/file-operations\/execute/);
  assert.match(serverJs, /\/api\/execution-standards/);
  assert.match(serverJs, /prepareExecutionStandards/);
  assert.match(serverJs, /approveExecutionStandards/);
  assert.match(serverJs, /approvePendingFileOperation/);
  assert.match(serverJs, /autoApprovePendingFileOperation/);
  assert.match(serverJs, /executeApprovedFileOperation/);
  assert.doesNotMatch(appJs, /["']\/api\/execute["']/);
  assert.doesNotMatch(serverJs, /["']\/api\/execute["']/);
});
