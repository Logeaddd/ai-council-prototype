# AI Council Prototype

Local CLI-first P0 prototype for the AI Council project.

## Run mock smoke test

```bash
node ./src/cli.js run --question "Should we build CLI-first?" --group ./config/group.example.json
```

The example group uses `provider: "mock"`, so it does not need API keys.

## Use a real OpenAI-compatible endpoint

Use `config/group.real.json`, then set:

```bash
AI_COUNCIL_API_BASE_URL=https://api.openai.com/v1
AI_COUNCIL_API_KEY=replace-me
AI_COUNCIL_MODEL=gpt-5
```

Run:

```bash
node ./src/cli.js run --question "Should this real API test proceed?" --group ./config/group.real.json --show-transcript
```

Or:

```bash
npm run smoke:real
```

## Commands

```bash
node ./src/cli.js run --question "..." --group ./config/group.example.json
node ./src/cli.js run --question "..." --group ./config/group.example.json --show-transcript
node ./src/cli.js run --question-file ./question.md --group ./config/group.example.json
node ./src/cli.js show-session ./sessions/session_....json
node ./src/cli.js list-memory-pending
node ./src/cli.js workspace init-group --root "D:\AI小组工作区" --group-folder "产品决策组" --members "gpt-5,claude"
node ./src/cli.js workspace replace-member --group-path "D:\AI小组工作区\产品决策组" --seat-id seat_01 --next-name gpt-6
node ./src/cli.js workspace replace-member --group-path "D:\AI小组工作区\产品决策组" --seat-id seat_01 --next-name gpt-6 --new-private-folder --folder-name gpt-6-fresh
node ./src/cli.js write-flow create-draft --group-path "D:\AI小组工作区\产品决策组" --recorder seat_01 --reviewers seat_02 --content "..."
node ./src/cli.js write-flow add-review --group-path "D:\AI小组工作区\产品决策组" --draft-id draft_... --reviewer seat_02 --verdict approve --comment "..."
node ./src/cli.js write-flow finalize --group-path "D:\AI小组工作区\产品决策组" --draft-id draft_... --approved-by user
```

## Local UI

```bash
npm run ui
```

Open:

```text
http://localhost:4317
```

The UI is intentionally small: workspace, members, conversation, recorder draft, and replacement flow.

## Desktop app

Install dependencies, then start the Electron shell:

```bash
npm install
npm run desktop
```

The desktop shell opens the local UI in an app window, starts the local server automatically, and suppresses the default browser context menu. Right-clicking an occupied agent seat still opens the AI Council seat menu.

On this machine, the desktop shortcut `AI小组启动.bat` calls `start-desktop.ps1` and starts the same desktop shell.

If Electron download fails with a local certificate error, run npm with the system certificate store enabled, then retry:

```bash
set NODE_OPTIONS=--use-system-ca
npm install
```

## P0 behavior implemented

- Reads group config.
- Requires an enabled `mandatoryRedTeam` agent.
- Requires at least one enabled non-Red-Team agent.
- Supports `mock` and `openai-compatible` providers.
- Parses round responses with `speak` / `skip`.
- Uses a dedicated final Judge call.
- Excludes Red Team from the consensus denominator.
- Counts consensus only after explicit non-Red-Team `skip`.
- Uses the engine-computed final `consensus_score`.
- Preserves Red Team dissent in final output.
- Writes session JSON files.
- Writes memory candidates to `memory/pending.jsonl`.
- Stores display-ready dialogue as `{agentName}说：{content}`.

## Tests

```bash
npm test
```

The tests cover config validation, response/convergence semantics, engine-owned final score, and the default mock council smoke path.

## Workspace folders

The workspace CLI implements the group folder model:

- User-defined root folder.
- User-defined group folder name.
- `shared/` team area.
- `members/{memberFolderName}/` private areas.
- Member replacement inherits the previous private folder by default.
- Use `--new-private-folder` to give the replacement a separate private folder.

## Recorder and review flow

The write-flow CLI implements the approval-gated recorder flow:

- User-approved content becomes a recorder draft.
- The recorder is a selected member seat.
- Reviewers are optional and selected by seat id.
- Reviewer comments are stored separately under `approvals/`.
- Final approval moves the draft to `shared/approved/` or `shared/memory_pending/`.
