const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("vectis", {
  request: (action, input, machineId) =>
    ipcRenderer.invoke("vectis:request", action, input, machineId),
  onWindowEvent: (listener) => {
    const forward = (_event, name) => listener(name);
    ipcRenderer.on("vectis:window", forward);
    return () => ipcRenderer.removeListener("vectis:window", forward);
  },
});
