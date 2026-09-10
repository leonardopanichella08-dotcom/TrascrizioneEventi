'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Ponte sicuro tra renderer (overlay.html, sandboxed, contextIsolation) e
 * processo main. Espone solo le poche azioni necessarie all'overlay.
 */
contextBridge.exposeInMainWorld('overlayAPI', {
  setInteractive: (interactive) => ipcRenderer.send('overlay:set-interactive', interactive),
  getDisplays: () => ipcRenderer.invoke('overlay:get-displays'),
  moveToDisplay: (displayId) => ipcRenderer.send('overlay:move-to-display', displayId),
  setPanelOpen: (open) => ipcRenderer.send('overlay:set-panel-open', open),
  quit: () => ipcRenderer.send('overlay:quit'),
  // Chiamato quando l'utente arriva da un link livetranslate://join?... sul sito.
  onAutoConnect: (callback) => ipcRenderer.on('overlay:auto-connect', (_event, data) => callback(data)),
  // Legge il testo negli appunti (per il pre-riempimento automatico del codice stanza).
  readClipboard: () => ipcRenderer.invoke('overlay:read-clipboard'),
});
