// 画面（renderer）からメイン側の機能を使うための最小限の窓口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quiverNative', {
  screens: () => ipcRenderer.invoke('quiver:screens'),
  setCaptureSource: (id) => ipcRenderer.send('quiver:capture-source', id),
  setKeepAlive: (on) => ipcRenderer.send('quiver:keep-alive', on),
  // 外部ソフト用API
  apiConfigure: (c) => ipcRenderer.invoke('quiver:api-config', c),
  apiNewToken: () => ipcRenderer.invoke('quiver:new-token'),
  apiSetDevice: (d) => ipcRenderer.send('quiver:api-device', d),
  apiOnRequest: (cb) => ipcRenderer.on('quiver:api-req', (_e, r) => cb(r)),
  apiRespond: (r) => ipcRenderer.send('quiver:api-res', r),
  apiOnLog: (cb) => ipcRenderer.on('quiver:api-log', (_e, l) => cb(l)),
  cursor: () => ipcRenderer.invoke('quiver:cursor'),
});
