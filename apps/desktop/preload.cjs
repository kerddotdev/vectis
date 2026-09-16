const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("vectis", {
  request: (action, input, machineId) =>
    ipcRenderer.invoke("vectis:request", action, input, machineId),
});
