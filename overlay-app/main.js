'use strict';

const path = require('path');
const { app, BrowserWindow, screen, ipcMain, clipboard } = require('electron');

// Altezza normale: solo la fascia sottotitoli in basso allo schermo.
const OVERLAY_HEIGHT = 260;
// Altezza quando il pannello impostazioni e' aperto: la finestra si allarga
// verso l'alto (il bordo inferiore resta ancorato) per dare spazio al pannello.
const OVERLAY_HEIGHT_PANEL = 680;

// Protocollo custom (es. livetranslate://join?server=...&room=ABC123) che
// permette al sito web di riaprire/richiamare questa app gia' pronta e
// connessa, esattamente come fanno i link "zoommtg://" o "spotify:".
const PROTOCOL = 'livetranslate';

let overlayWindow = null;
let pendingAutoConnect = null; // dati in attesa se il link arriva prima che la finestra sia pronta
let currentDisplayId = null;   // schermo su cui e' posizionato l'overlay
let panelExpanded = false;      // true = finestra allargata per il pannello

function listDisplaysForRenderer() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    isPrimary: d.id === primary.id,
    width: d.size.width,
    height: d.size.height,
  }));
}

/** Bounds ancorati al bordo inferiore del display; alti a sufficienza se il
 *  pannello e' aperto (la finestra "cresce" verso l'alto, non verso il basso). */
function bottomStripBounds(display, expanded = panelExpanded) {
  const h = Math.min(
    expanded ? OVERLAY_HEIGHT_PANEL : OVERLAY_HEIGHT,
    display.bounds.height,
  );
  return {
    x: display.bounds.x,
    y: display.bounds.y + display.bounds.height - h,
    width: display.bounds.width,
    height: h,
  };
}

function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || null;
}

function applyOverlayBounds() {
  if (!overlayWindow) return;
  const display = displayById(currentDisplayId) || pickDefaultDisplay();
  overlayWindow.setBounds(bottomStripBounds(display));
}

function pickDefaultDisplay() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // Di default preferiamo un secondo schermo (tipicamente il proiettore),
  // se presente; altrimenti usiamo il principale (utile in fase di test).
  return displays.find((d) => d.id !== primary.id) || primary;
}

// -----------------------------------------------------------------------
// Protocollo custom: registrazione + parsing del link in arrivo
// -----------------------------------------------------------------------

function registerProtocolHandler() {
  // In sviluppo (avvio con "electron .") va indicato esplicitamente il
  // comando da rilanciare; da app impacchettata (.exe) basta il nome.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** Estrae { server, room } da un link livetranslate://join?server=...&room=.... */
function parseProtocolUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL}:`) return null;
    const room = (parsed.searchParams.get('room') || '').toUpperCase();
    const server = parsed.searchParams.get('server') || '';
    if (!room) return null;
    return { server, room };
  } catch {
    return null;
  }
}

function extractProtocolData(argv) {
  const target = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  return target ? parseProtocolUrl(target) : null;
}

/**
 * Gestisce un link in arrivo quando l'app e' GIA' avviata (secondo processo
 * da "second-instance", o evento "open-url" su macOS): la finestra e il suo
 * contenuto esistono di sicuro, quindi possiamo inviare l'IPC subito.
 */
function handleIncomingArgvForRunningApp(argv) {
  const data = extractProtocolData(argv);
  if (!data || !overlayWindow) return;
  overlayWindow.webContents.send('overlay:auto-connect', data);
}

function createOverlayWindow(initialAutoConnect) {
  const targetDisplay = pickDefaultDisplay();
  currentDisplayId = targetDisplay.id;
  const bounds = bottomStripBounds(targetDisplay);

  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' e' il livello piu' alto disponibile su Windows/macOS:
  // fa restare la finestra sopra anche a presentazioni a schermo intero
  // (PowerPoint/Keynote in modalita' Presentazione, PDF reader fullscreen, ecc.).
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  try {
    // Rilevante soprattutto su macOS, dove le app fullscreen vivono in uno
    // "Space" separato: senza questo l'overlay non le seguirebbe.
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // Non disponibile su tutte le piattaforme: non e' un errore bloccante.
  }

  // Di default l'intera finestra lascia passare i click a cio' che sta sotto
  // (PowerPoint, il browser con le slide, ecc.). Il renderer attiva/disattiva
  // l'interattivita' in tempo reale quando il mouse entra/esce dal pannello
  // di controllo (vedi preload.js + renderer/overlay.js).
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // Impostato PRIMA di loadFile: se l'avvio e' scattato da un link
  // livetranslate://, il renderer non esiste ancora, quindi qualunque
  // controllo tipo "e' gia' caricato?" fatto qui sarebbe una corsa critica.
  // Salviamo il dato e lo consegniamo in modo affidabile su 'did-finish-load'.
  pendingAutoConnect = initialAutoConnect || null;

  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    console.log(`[overlay] pronto su schermo ${targetDisplay.size.width}x${targetDisplay.size.height} (angolo in alto a destra per le impostazioni)`);
    if (pendingAutoConnect) {
      overlayWindow.webContents.send('overlay:auto-connect', pendingAutoConnect);
      pendingAutoConnect = null;
    }
  });
  overlayWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[overlay] errore nel caricamento dell'interfaccia: ${desc} (${code})`);
  });
}

// -----------------------------------------------------------------------
// IPC: ponte con il renderer (contextIsolation attivo, vedi preload.js)
// -----------------------------------------------------------------------

ipcMain.on('overlay:set-interactive', (_event, interactive) => {
  if (!overlayWindow) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.handle('overlay:get-displays', () => listDisplaysForRenderer());

ipcMain.on('overlay:move-to-display', (_event, displayId) => {
  if (!overlayWindow || !displayById(displayId)) return;
  currentDisplayId = displayId;
  applyOverlayBounds();
});

// Il renderer avvisa quando apre/chiude il pannello: allarghiamo la finestra
// verso l'alto cosi' il pannello non finisce sotto il bordo dello schermo.
ipcMain.on('overlay:set-panel-open', (_event, open) => {
  panelExpanded = Boolean(open);
  applyOverlayBounds();
});

ipcMain.on('overlay:quit', () => app.quit());

ipcMain.handle('overlay:read-clipboard', () => clipboard.readText());

// -----------------------------------------------------------------------
// Avvio: singola istanza + gestione del link in arrivo
// -----------------------------------------------------------------------

registerProtocolHandler();

// Se l'app e' gia' aperta e l'utente clicca di nuovo il link dal sito,
// Windows lancia un secondo processo "usa e getta": lo intercettiamo qui,
// passiamo i dati (server/room) all'istanza gia' attiva e chiudiamo il duplicato.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => handleIncomingArgvForRunningApp(argv));

  // macOS gestisce i link custom con un evento dedicato invece che via argv.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleIncomingArgvForRunningApp([url]);
  });

  app.whenReady().then(() => {
    // Avvio "a freddo" gia' innescato da un link livetranslate://: la finestra
    // non esiste ancora, quindi passiamo il dato direttamente alla creazione
    // invece di tentare un invio IPC che arriverebbe troppo presto e andrebbe perso.
    createOverlayWindow(extractProtocolData(process.argv));
  });

  app.on('window-all-closed', () => app.quit());
}
