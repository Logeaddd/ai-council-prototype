import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell } from "electron";

const DEFAULT_PORT = Number(process.env.AI_COUNCIL_UI_PORT || 4317);
const HOST = "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composerDropProbePath = String(process.env.AI_COUNCIL_E2E_COMPOSER_DROP_FILE || "").trim();
const privateDraftProbeEnabled = process.env.AI_COUNCIL_E2E_PRIVATE_DRAFT_PROBE === "1";
const transcriptFollowProbeEnabled = process.env.AI_COUNCIL_E2E_TRANSCRIPT_FOLLOW_PROBE === "1";
const historySeedProbeEnabled = process.env.AI_COUNCIL_E2E_HISTORY_SEED_PROBE === "1";
const historyReopenProbeEnabled = process.env.AI_COUNCIL_E2E_HISTORY_REOPEN_PROBE === "1";
const historyProbeMarker = String(process.env.AI_COUNCIL_E2E_HISTORY_MARKER || "").trim();
const packagedPtyProbeEnabled = process.env.AI_COUNCIL_E2E_PTY_PROBE === "1";
const packagedPtyProbeResultPath = String(process.env.AI_COUNCIL_E2E_PTY_RESULT_PATH || "").trim();

let mainWindow;

app.setName("AI Council");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktop).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    startDesktop().catch((error) => console.error(error));
  }
});

async function startDesktop() {
  if (mainWindow) return;
  Menu.setApplicationMenu(null);
  configureDataDirectory();
  if (packagedPtyProbeEnabled) {
    try {
      const result = await runPackagedPtyProbe();
      console.log(`AI_COUNCIL_E2E_PTY=${JSON.stringify(result)}`);
      writeE2eProbeResult(packagedPtyProbeResultPath, result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_PTY_FAILED", error);
      writeE2eProbeResult(packagedPtyProbeResultPath, { ok: false, error: String(error?.message || error) });
    } finally {
      setTimeout(() => app.quit(), 50);
    }
    return;
  }
  const port = await findOpenPort(DEFAULT_PORT);
  process.env.AI_COUNCIL_UI_HOST = HOST;
  process.env.AI_COUNCIL_UI_PORT = String(port);
  await import("../src/server.js");
  await waitForServer(port);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "AI Council",
    icon: resolveAppIconPath(),
    backgroundColor: "#f3f4f5",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.on("context-menu", (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    const wantsDevTools = (input.control && input.shift && key === "i") || key === "f12";
    if (!wantsDevTools) return;
    event.preventDefault();
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
      return;
    }
    mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    if (!composerDropProbePath && !privateDraftProbeEnabled && !transcriptFollowProbeEnabled && !historySeedProbeEnabled && !historyReopenProbeEnabled) mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`http://${HOST}:${port}`);
  if (composerDropProbePath) {
    try {
      const result = await runComposerDropProbe(mainWindow, composerDropProbePath);
      console.log(`AI_COUNCIL_E2E_COMPOSER_DROP=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_COMPOSER_DROP_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  } else if (privateDraftProbeEnabled) {
    try {
      mainWindow.show();
      mainWindow.focus();
      const result = await runPrivateDraftProbe(mainWindow);
      console.log(`AI_COUNCIL_E2E_PRIVATE_DRAFT=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_PRIVATE_DRAFT_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  } else if (transcriptFollowProbeEnabled) {
    try {
      mainWindow.show();
      mainWindow.focus();
      const result = await runTranscriptFollowProbe(mainWindow);
      console.log(`AI_COUNCIL_E2E_TRANSCRIPT_FOLLOW=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_TRANSCRIPT_FOLLOW_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  } else if (historySeedProbeEnabled) {
    try {
      mainWindow.show();
      mainWindow.focus();
      const result = await runHistorySeedProbe(mainWindow);
      console.log(`AI_COUNCIL_E2E_HISTORY_SEED=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_HISTORY_SEED_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  } else if (historyReopenProbeEnabled) {
    try {
      mainWindow.show();
      mainWindow.focus();
      const result = await runHistoryReopenProbe(mainWindow, historyProbeMarker);
      console.log(`AI_COUNCIL_E2E_HISTORY_REOPEN=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_HISTORY_REOPEN_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  }
}

async function runPackagedPtyProbe() {
  const { startManagedInteractiveProcess, processControlTool } = await import("../src/processTools.js");
  const probeRoot = path.resolve(process.env.AI_COUNCIL_DATA_DIR || app.getPath("userData"));
  fs.mkdirSync(probeRoot, { recursive: true });
  const groupRoot = fs.mkdtempSync(path.join(probeRoot, "e2e-pty-"));
  const value = "ai-council-pty-probe";
  try {
    const started = await startManagedInteractiveProcess({
      groupRoot,
      workspaceRoot: groupRoot,
      workspaceLabel: "e2e-pty",
      cwd: groupRoot,
      command: "echo READY & set /p value=INPUT: & echo ECHO:%value%",
      shell: "cmd",
      invocation: {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", "echo READY & set /p value=INPUT: & echo ECHO:%value%"]
      },
      env: { ...process.env },
      columns: 80,
      rows: 24,
      maxOutputBytes: 32768
    });
    if (!started.ok) throw new Error(`pty_start_failed:${started.code || started.error || "unknown"}`);
    const ready = await waitForPtyOutput(processControlTool, groupRoot, started.processId, "READY");
    const resized = await processControlTool({ action: "resize", processId: started.processId, columns: 120, rows: 40 }, { groupPath: groupRoot });
    const input = await processControlTool({ action: "input", processId: started.processId, inputText: `${value}\r` }, { groupPath: groupRoot });
    if (!resized.acknowledged || !input.acknowledged) throw new Error("pty_controls_not_acknowledged");
    const completed = await waitForPtyOutput(processControlTool, groupRoot, started.processId, "ECHO:");
    if (!String(completed.output || "").includes("[terminal-input-redacted]") || String(completed.output || "").includes(value)) {
      throw new Error("pty_input_echo_was_not_redacted");
    }
    const final = await waitForPtyExit(processControlTool, groupRoot, started.processId);
    if (final.process?.status !== "exited" || final.process?.exitCode !== 0) {
      throw new Error(`pty_exit_not_clean:${final.process?.status || "unknown"}:${final.process?.exitCode ?? "unknown"}`);
    }
    return {
      ok: true,
      probe: "packaged_electron_pty",
      processId: started.processId,
      supervisorPid: started.supervisorPid,
      readyBytes: ready.totalBytes,
      outputBytes: completed.totalBytes,
      resizedTo: resized.terminal,
      finalStatus: final.process.status,
      exitCode: final.process.exitCode
    };
  } finally {
    try { fs.rmSync(groupRoot, { recursive: true, force: true }); } catch {}
  }
}

async function waitForPtyOutput(processControlTool, groupRoot, processId, expected) {
  const deadline = Date.now() + 10000;
  let latest;
  while (Date.now() < deadline) {
    latest = await processControlTool({ action: "output", processId, stream: "terminal", offset: 0, maxBytes: 32768 }, { groupPath: groupRoot });
    if (String(latest.output || "").includes(expected)) return latest;
    const status = await processControlTool({ action: "status", processId }, { groupPath: groupRoot });
    if (["failed", "stopped", "unknown"].includes(status.process?.status)) {
      throw new Error(`pty_exited_before_output:${status.process.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pty_output_timeout:${expected}`);
}

async function waitForPtyExit(processControlTool, groupRoot, processId) {
  const deadline = Date.now() + 10000;
  let latest;
  while (Date.now() < deadline) {
    latest = await processControlTool({ action: "status", processId }, { groupPath: groupRoot });
    if (["exited", "failed", "stopped", "unknown"].includes(latest.process?.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("pty_exit_timeout");
}

async function runComposerDropProbe(window, filePath) {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, "utf8");
  const payload = JSON.stringify({ name: path.basename(resolved), text });
  return window.webContents.executeJavaScript(`
    (async () => {
      const payload = ${payload};
      const deadline = Date.now() + 8000;
      let textarea = null;
      while (Date.now() < deadline) {
        textarea = document.querySelector("textarea");
        if (textarea) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!textarea) return { ok: false, reason: "composer_textarea_missing" };
      const target = textarea.parentElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([payload.text], payload.name, { type: "text/plain" }));
      const dispatchResult = target.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      const attachmentDeadline = Date.now() + 8000;
      while (Date.now() < attachmentDeadline) {
        if (document.body.textContent?.includes(payload.name)) {
          return {
            ok: true,
            defaultPrevented: !dispatchResult,
            attachment: payload.name
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        ok: false,
        reason: "attachment_not_rendered",
        defaultPrevented: !dispatchResult
      };
    })()
  `, true);
}

async function runPrivateDraftProbe(window) {
  const created = await createGroupThroughUi(window, "private_probe_group_not_ready");
  const unconfiguredSeatCount = await assertNewProbeGroupIsUnconfigured(window, created.groupPath);
  const groupDraft = "group draft stays in the group composer";
  const privateDraft = "private draft stays with the selected member";
  await window.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const composer = document.querySelector("[data-testid='group-chat-draft']");
        const privateButton = document.querySelector("[data-testid='open-private-chat']");
        if (composer?.dataset.draftReady === "true" && privateButton && !privateButton.disabled) {
          composer.focus();
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("group_composer_not_ready_after_group_creation");
    })()
  `, true);
  await typeProbeText(window, "[data-testid='group-chat-draft']", groupDraft, "group_composer_text_input_failed");
  await window.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      async function waitFor(getValue, reason, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = getValue();
          if (value) return value;
          await sleep(50);
        }
        throw new Error(reason);
      }
      const privateButton = await waitFor(
        () => {
          const candidate = document.querySelector("[data-testid='open-private-chat']");
          return candidate && !candidate.disabled ? candidate : null;
        },
        "private_chat_button_disabled"
      );
      await waitFor(
        () => Object.keys(localStorage).some((key) => key.startsWith("ai-council:draft:") && localStorage.getItem(key) === ${JSON.stringify(groupDraft)}),
        "group_draft_not_persisted"
      );
      privateButton.click();
      return;
    })()
  `, true);

  await focusProbeElement(window, "[data-testid='private-chat-draft']", "private_composer_missing");
  await typeProbeText(window, "[data-testid='private-chat-draft']", privateDraft, "private_composer_text_input_failed");
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      async function waitFor(getValue, reason, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = getValue();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(reason);
      }
      await waitFor(
        () => Object.keys(localStorage).some((key) => key.startsWith("ai-council:private-draft:") && localStorage.getItem(key) === ${JSON.stringify(privateDraft)}),
        "private_draft_not_persisted"
      );
      const groupComposer = document.querySelector("[data-testid='group-chat-draft']");
      const privateComposer = document.querySelector("[data-testid='private-chat-draft']");
      const beforeClose = {
        groupValue: groupComposer.value,
        privateValue: privateComposer.value,
        groupKeys: Object.keys(localStorage).filter((key) => key.startsWith("ai-council:draft:")),
        privateKeys: Object.keys(localStorage).filter((key) => key.startsWith("ai-council:private-draft:")),
      };
      if (beforeClose.groupValue !== ${JSON.stringify(groupDraft)} || beforeClose.privateValue !== ${JSON.stringify(privateDraft)}) {
        throw new Error("draft_values_not_independent_before_close");
      }
      if (beforeClose.groupKeys.length !== 1 || beforeClose.privateKeys.length !== 1) {
        throw new Error("draft_storage_keys_not_isolated");
      }
      const closeButton = await waitFor(
        () => document.querySelector("[role='dialog'] button[aria-label]"),
        "private_chat_close_button_missing"
      );
      closeButton.click();
      await waitFor(
        () => !document.querySelector("[data-testid='private-chat-draft']"),
        "private_chat_did_not_close"
      );
      document.querySelector("[data-testid='open-private-chat']").click();
      const reopenedPrivateComposer = await waitFor(
        () => document.querySelector("[data-testid='private-chat-draft']"),
        "private_composer_missing_after_reopen"
      );
      if (reopenedPrivateComposer.value !== ${JSON.stringify(privateDraft)}) throw new Error("private_draft_not_restored_after_reopen");
      if (document.querySelector("[data-testid='group-chat-draft']").value !== ${JSON.stringify(groupDraft)}) {
        throw new Error("group_draft_changed_after_private_chat");
      }
      return {
        ok: true,
        probe: "electron_private_draft",
        groupDraft: ${JSON.stringify(groupDraft)},
        privateDraft: ${JSON.stringify(privateDraft)},
        groupKey: beforeClose.groupKeys[0],
        privateKey: beforeClose.privateKeys[0],
      };
    })()
  `, true);
  return { ...result, unconfiguredSeatCount };
}

async function runTranscriptFollowProbe(window) {
  await createGroupThroughUi(window, "transcript_probe_group_not_ready");
  await configureExplicitMockForDesktopProbe(window, "transcript_probe_mock_configuration_failed");
  await focusProbeElement(window, "[data-testid='group-chat-draft']", "transcript_probe_composer_missing");
  const question = `Transcript follow probe. ${"This deliberately creates visible transcript height. ".repeat(420)}`;
  await typeProbeText(window, "[data-testid='group-chat-draft']", question, "transcript_probe_text_input_failed");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });

  const atBottomDuringLiveUpdates = await window.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const container = document.querySelector("[data-testid='transcript-scroll-region']");
        if (container
          && container.scrollHeight > container.clientHeight + 100
          && container.textContent?.includes("CLI-first prototype")
          && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
          return { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const container = document.querySelector("[data-testid='transcript-scroll-region']");
      throw new Error("transcript_did_not_follow_live_output_at_bottom:" + JSON.stringify({
        scrollTop: container?.scrollTop,
        scrollHeight: container?.scrollHeight,
        clientHeight: container?.clientHeight,
        viewportHeight: window.innerHeight,
        stylesheetLinks: await Promise.all([...document.querySelectorAll("link[rel='stylesheet']")].map(async (link) => {
          try {
            const response = await fetch(link.href, { cache: "no-store" });
            return { href: link.href, responseUrl: response.url, status: response.status, contentType: response.headers.get("content-type"), bytes: (await response.text()).length };
          } catch (error) {
            return { href: link.href, error: String(error?.message || error) };
          }
        })),
        stylesheets: [...document.styleSheets].map((sheet) => {
          let selectorCount = 0;
          let flexRule = false;
          try {
            selectorCount = sheet.cssRules.length;
            flexRule = [...sheet.cssRules].some((rule) => rule.cssText?.includes(".flex{display:flex}"));
          } catch (error) {
            return { href: sheet.href, unreadable: String(error?.message || error) };
          }
          return { href: sheet.href, selectorCount, flexRule };
        }),
        parents: [container, container?.parentElement, container?.parentElement?.parentElement, document.body].filter(Boolean).map((element) => {
          const style = getComputedStyle(element);
          return { tag: element.tagName, className: element.className, height: style.height, minHeight: style.minHeight, overflowY: style.overflowY, display: style.display, flex: style.flex };
        }),
        text: container?.textContent?.slice(0, 300),
        composerDisabled: document.querySelector("[data-testid='group-chat-draft']")?.disabled,
      }));
    })()
  `, true);

  const afterManualScroll = await window.webContents.executeJavaScript(`
    (async () => {
      const container = document.querySelector("[data-testid='transcript-scroll-region']");
      if (!container) throw new Error("transcript_scroll_region_missing");
      const heightBeforeManualScroll = container.scrollHeight;
      container.scrollTop = 0;
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const composer = document.querySelector("[data-testid='group-chat-draft']");
        if (composer && !composer.disabled && container.scrollHeight > heightBeforeManualScroll) {
          const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
          return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            remaining,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("transcript_did_not_receive_later_live_updates");
    })()
  `, true);

  if (afterManualScroll.scrollTop > 2 || afterManualScroll.remaining <= 48) {
    throw new Error("transcript_forced_reader_back_to_bottom_after_manual_scroll");
  }
  return {
    ok: true,
    probe: "electron_transcript_follow",
    atBottomDuringLiveUpdates,
    afterManualScroll,
  };
}

async function runHistorySeedProbe(window) {
  await createGroupThroughUi(window, "history_seed_group_not_ready");
  await configureExplicitMockForDesktopProbe(window, "history_seed_mock_configuration_failed");
  const marker = historyProbeMarker || `history-recovery-${Date.now()}`;
  const question = `Persist this history recovery marker exactly: ${marker}`;
  await typeProbeText(window, "[data-testid='group-chat-draft']", question, "history_seed_composer_text_input_failed");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });

  const saved = await window.webContents.executeJavaScript(`
    (async () => {
      const marker = ${JSON.stringify(marker)};
      const question = ${JSON.stringify(question)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const indexResponse = await fetch("/api/groups-index");
        const index = await indexResponse.json();
        const group = (index.groups || []).find((item) => item.id === index.lastGroupId) || index.groups?.[0];
        if (group?.path) {
          const sessionsResponse = await fetch("/api/sessions?groupPath=" + encodeURIComponent(group.path));
          const sessions = await sessionsResponse.json();
          const session = (sessions.sessions || []).find((item) => item.question === question);
          if (session?.id && session.status !== "running" && Number(session.messageCount || 0) >= 2) return {
            ok: true,
            marker,
            groupPath: group.path,
            sessionId: session.id,
            messageCount: session.messageCount,
            status: session.status,
          };
        }
        await sleep(50);
      }
      throw new Error("history_seed_session_not_persisted:" + JSON.stringify({
        marker,
        visibleText: document.body.innerText.slice(0, 1200),
      }));
    })()
  `, true);
  if (!saved?.ok || !saved.groupPath || !saved.sessionId || saved.status === "running" || Number(saved.messageCount || 0) < 2) {
    throw new Error("history_seed_missing_completed_message_evidence");
  }
  return saved;
}

async function runHistoryReopenProbe(window, marker) {
  if (!marker) throw new Error("history_reopen_marker_missing");
  return window.webContents.executeJavaScript(`
    (async () => {
      const marker = ${JSON.stringify(marker)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const composer = document.querySelector("[data-testid='group-chat-draft']");
        const privateButton = document.querySelector("[data-testid='open-private-chat']");
        if (composer?.dataset.draftReady === "true" && privateButton && !privateButton.disabled) break;
        await sleep(50);
      }
      const historyButton = document.querySelector("[data-testid='open-chat-history']");
      if (!historyButton) throw new Error("history_reopen_button_missing");
      historyButton.click();

      while (Date.now() < deadline) {
        const dialog = document.querySelector("[role='dialog']");
        const content = dialog?.textContent || "";
        if (content.includes(marker) && content.includes("CLI-first prototype")) {
          return { ok: true, marker, visibleHistory: true };
        }
        await sleep(50);
      }
      const dialog = document.querySelector("[role='dialog']");
      throw new Error("history_reopen_session_not_visible:" + JSON.stringify({
        marker,
        dialogText: dialog?.textContent?.slice(0, 1600),
        visibleText: document.body.innerText.slice(0, 1600),
      }));
    })()
  `, true);
}

async function createGroupThroughUi(window, reason) {
  return window.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 10000;
      let createButton = null;
      while (Date.now() < deadline) {
        createButton = document.querySelector("[data-testid='create-group']");
        if (createButton && !createButton.disabled) break;
        await sleep(50);
      }
      if (!createButton) throw new Error("create_group_button_missing");
      createButton.click();

      while (Date.now() < deadline) {
        const composer = document.querySelector("[data-testid='group-chat-draft']");
        const privateButton = document.querySelector("[data-testid='open-private-chat']");
        if (composer?.dataset.draftReady === "true" && privateButton && !privateButton.disabled) {
          const indexResponse = await fetch("/api/groups-index");
          const index = await indexResponse.json();
          const group = (index.groups || []).find((item) => item.id === index.lastGroupId) || index.groups?.[0];
          if (group?.path) return { ok: true, groupPath: group.path };
        }
        await sleep(50);
      }
      const composer = document.querySelector("[data-testid='group-chat-draft']");
      const privateButton = document.querySelector("[data-testid='open-private-chat']");
      const groupLabels = [...document.querySelectorAll("nav button")]
        .map((button) => button.textContent?.trim())
        .filter(Boolean)
        .slice(0, 12);
      throw new Error(${JSON.stringify(reason)} + ":" + JSON.stringify({
        composerDraftReady: composer?.dataset.draftReady,
        privateButtonDisabled: privateButton?.disabled,
        groupLabels,
        visibleText: document.body.innerText.slice(0, 1200),
      }));
    })()
  `, true);
}

async function assertNewProbeGroupIsUnconfigured(window, groupPath) {
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const groupPath = ${JSON.stringify(groupPath || "")};
      if (!groupPath) throw new Error("probe_group_path_missing");
      const response = await fetch("/api/group?groupPath=" + encodeURIComponent(groupPath));
      const group = await response.json();
      const seats = group.seats || group.agents || [];
      const badSeats = seats.filter((seat) => (
        String(seat.apiBaseUrl || seat.apiUrl || "") === "mock://local"
        || String(seat.providerPreset || "").toLowerCase() === "mock"
        || /^mock-/i.test(String(seat.model || seat.currentModel || ""))
      ));
      if (!seats.length || badSeats.length) {
        throw new Error("new_group_has_fabricated_mock_provider:" + JSON.stringify({
          seatCount: seats.length,
          badSeats: badSeats.map((seat) => seat.seatId || seat.id),
        }));
      }
      return { ok: true, unconfiguredSeatCount: seats.length };
    })()
  `, true);
  return Number(result?.unconfiguredSeatCount || 0);
}

// Desktop probes need deterministic local output to exercise persistence and
// streaming. They opt into the mock provider here; normal group creation never
// receives this configuration.
async function configureExplicitMockForDesktopProbe(window, reason) {
  const configured = await window.webContents.executeJavaScript(`
    (async () => {
      const indexResponse = await fetch("/api/groups-index");
      const index = await indexResponse.json();
      const groupRecord = (index.groups || []).find((item) => item.id === index.lastGroupId) || index.groups?.[0];
      if (!groupRecord?.path) throw new Error("probe_group_path_missing");
      const groupResponse = await fetch("/api/group?groupPath=" + encodeURIComponent(groupRecord.path));
      const group = await groupResponse.json();
      const seats = group.seats || group.agents || [];
      if (!seats.length) throw new Error("probe_group_has_no_seats");
      for (let index = 0; index < seats.length; index += 1) {
        const seat = seats[index];
        const response = await fetch("/api/group/seat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupPath: groupRecord.path,
            seatId: seat.seatId || seat.id,
            providerPreset: "mock",
            apiBaseUrl: "mock://local",
            model: "probe-mock-" + (index + 1),
          }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error("probe_mock_configuration_request_failed:" + String(error.error || response.status));
        }
      }
      return { ok: true, groupPath: groupRecord.path, seatCount: seats.length };
    })()
  `, true);
  if (!configured?.ok) throw new Error(reason);
  await reloadProbeWindow(window, reason);
  return configured;
}

async function reloadProbeWindow(window, reason) {
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${reason}:reload_timeout`)), 10000);
    window.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  window.webContents.reloadIgnoringCache();
  await loaded;
}

async function focusProbeElement(window, selector, reason) {
  return window.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element?.dataset.draftReady === "true") {
          element.focus();
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(${JSON.stringify(reason)});
    })()
  `, true);
}

async function typeProbeText(window, selector, value, reason) {
  await focusProbeElement(window, selector, reason);
  window.show();
  window.focus();
  window.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.select()`, true);
  await window.webContents.insertText(value);
  const accepted = await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
    true
  );
  if (!accepted) throw new Error(reason);
}

function resolveAppIconPath() {
  const appRoot = path.resolve(__dirname, "..");
  const iconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const packagedIcon = path.join(appRoot, "build", iconName);
  if (fs.existsSync(packagedIcon)) return packagedIcon;
  return path.join(appRoot, "renderer", "public", "logo.png");
}

function configureDataDirectory() {
  if (process.env.AI_COUNCIL_DATA_DIR) return;
  const configuredPath = readConfiguredDataPath();
  const dataDir = configuredPath || app.getPath("userData");
  process.env.AI_COUNCIL_DATA_DIR = path.resolve(dataDir);
  if (!process.env.AI_COUNCIL_WORKSPACE_ROOT) {
    process.env.AI_COUNCIL_WORKSPACE_ROOT = process.env.AI_COUNCIL_DATA_DIR;
  }
}

function writeE2eProbeResult(filePath, result) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf8");
  } catch (error) {
    console.error("AI_COUNCIL_E2E_PTY_RESULT_WRITE_FAILED", error);
  }
}

function readConfiguredDataPath() {
  if (!app.isPackaged) return "";
  const installDir = path.dirname(process.execPath);
  for (const candidate of [
    path.join(installDir, "data-path.txt"),
    path.join(process.resourcesPath, "data-path.txt")
  ]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      continue;
    }
  }
  return "";
}

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, HOST);
    };
    tryPort(startPort);
  });
}

async function waitForServer(port) {
  const url = `http://${HOST}:${port}/api/health`;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await canReach(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`AI Council server did not start on ${url}`);
}

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}
