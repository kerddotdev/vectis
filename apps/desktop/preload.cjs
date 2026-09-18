const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("vectis", {
  request: (action, input) => ipcRenderer.invoke("vectis:request", action, input),
});
