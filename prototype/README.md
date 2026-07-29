# AI Council

AI Council is a local desktop workspace for coordinating configurable AI members on real project work. It keeps task runs, tool evidence, file changes, checkpoints, and retrievable group history on the local machine.

## 0.2.4

This release packages the current reliability work:

- a durable delivery owner and bounded contributor handoffs;
- resumable TaskRun checkpoints and honest incomplete/failed states;
- persistent group history with searchable context, source invalidation, and context receipts;
- controlled file, command, network, MCP, package, and managed-tool workflows;
- managed interactive PTY sessions on Windows;
- ASAR-protected application source with the native PTY runtime unpacked only where Electron requires it;
- independent private and group drafts, retained streaming output, follow-at-bottom behavior, and file attachments;
- format-aware artifact verification instead of treating a model claim as proof.
- a seeded, capability-acquiring illustrated PDF report family in the real-user acceptance matrix.

The app is designed to make tool use and project execution observable. A successful result still depends on the configured model, provider availability, permissions, and the task itself; failed or incomplete work must remain visible as such.

## Windows Installer

Download the `AI-Council-Setup-0.2.4.exe` asset from the matching GitHub release once it is published. The NSIS installer allows choosing both the application and data directories.

For a locally built release candidate, the installer is written to `dist-installer/AI-Council-Setup-0.2.4.exe`.

## Quick Start

1. Create a council group.
2. Add one or more members and configure each provider, API base URL, key, and model.
3. Send a task in the group composer or import files by dropping them into the chat area.
4. Watch the persisted task run for tool activity, artifacts, checkpoints, and completion evidence.

Provider keys stay local and are redacted from client-visible task evidence. Use a test workspace for important projects until you have verified the providers, permissions, and output requirements you intend to use.

## Development

```bash
npm install
npm test
npm run desktop
```

Build a Windows installer:

```bash
npm run desktop:installer
```

## Verification

The repository contains fast regression tests and a separate product harness. The product harness replays retained real-provider evidence across coding, API collection, external-workspace, archive, capability-acquisition, document generation, collaboration, recovery, and context-retrieval scenarios. It does not treat mocked tests as real-provider acceptance. The broadened gate remains incomplete until a real provider completes the PDF-report family with its own acquired capability and mechanically verified output.
