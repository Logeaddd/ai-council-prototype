const { contextBridge, webUtils } = require("electron");

contextBridge.exposeInMainWorld("aiCouncilDesktop", {
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  }
});
