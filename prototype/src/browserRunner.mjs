import fs from "node:fs";
import { app, BrowserWindow } from "electron";
import { runBrowserAutomation } from "./browserAutomation.js";

app.commandLine.appendSwitch("disable-gpu");

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("browserRunner requires input and output paths.");
  process.exit(2);
}

app.whenReady()
  .then(async () => {
    const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const result = await runBrowserAutomation(input, { BrowserWindow });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  })
  .catch((error) => {
    fs.writeFileSync(outputPath, JSON.stringify({
      ok: false,
      source: "local_browser_control",
      code: error.code || "browser_control_failed",
      error: error.message || "Browser control failed."
    }, null, 2), "utf8");
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
  });
