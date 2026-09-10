/**
 * overlay.js — logica della finestra overlay trasparente.
 *
 * Due responsabilita' distinte:
 *  1) Interattivita' selettiva: solo #controlZone deve intercettare i click
 *     (il resto della finestra deve lasciarli passare a PowerPoint/PDF/browser
 *     sottostante). Lo comunichiamo al processo main via overlayAPI.
 *  2) Connessione Socket.io + rendering sottotitoli (stessa logica condivisa
 *     di display.html, tramite subtitle-renderer.js).
 */
import { SubtitleRenderer } from './subtitle-renderer.js';

// -------------------------------------------------------------------
// Riferimenti DOM
// -------------------------------------------------------------------
const controlZone = document.getElementById('controlZone');
const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusDot = document.getElementById('statusDot');
const panel = document.getElementById('panel');
const serverInput = document.getElementById('serverInput');
const roomInput = document.getElementById('roomInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const displaySelect = document.getElementById('displaySelect');
const panelMessage = document.getElementById('panelMessage');
const collapseBtn = document.getElementById('collapseBtn');
const stopBtn = document.getElementById('stopBtn');
const quitQuickBtn = document.getElementById('quitQuickBtn');
const hideBadgeBtn = document.getElementById('hideBadgeBtn');
const revealZone = document.getElementById('revealZone');
const pasteBtn = document.getElementById('pasteBtn');
const subtitleZone = document.getElementById('subtitleZone');

const renderer = new SubtitleRenderer(subtitleZone);

// -------------------------------------------------------------------
// 1) Interattivita' selettiva della finestra (click-through altrove)
// -------------------------------------------------------------------
controlZone.addEventListener('mouseenter', () => window.overlayAPI.setInteractive(true));
controlZone.addEventListener('mouseleave', () => {
  // Se il pannello e' aperto lasciamo l'intera zona interattiva; altrimenti
  // torniamo click-through non appena il mouse esce dal piccolo pulsante.
  if (!panel.classList.contains('open')) window.overlayAPI.setInteractive(false);
});

/** Apre/chiude il pannello e avvisa il processo main (allarga/restringe la finestra). */
function setPanel(open) {
  panel.classList.toggle('open', open);
  window.overlayAPI.setPanelOpen(open);
  if (!open) {
    window.overlayAPI.setInteractive(false);
  } else if (!socket && !roomInput.value) {
    // All'apertura, se non connessi e campo vuoto, proviamo il codice dagli appunti.
    fillRoomFromClipboard(true);
  }
}

toggleBtn.addEventListener('click', () => setPanel(!panel.classList.contains('open')));
collapseBtn.addEventListener('click', () => setPanel(false));

// "Ferma sessione e chiudi": lascia la stanza (lo dice al server) e chiude l'app.
stopBtn.addEventListener('click', () => {
  disconnect();
  window.overlayAPI.quit();
});

// Chiusura rapida diretta dal badge, senza aprire il pannello.
quitQuickBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // non deve anche far scattare il toggle del pannello
  window.overlayAPI.quit();
});

// "Nascondi badge": solo estetica. I sottotitoli continuano, la connessione
// resta. Per riportarlo: passare il mouse nell'angolo in alto a destra.
hideBadgeBtn.addEventListener('click', () => {
  setPanel(false);
  document.body.classList.add('badge-hidden');
});
revealZone.addEventListener('mouseenter', () => {
  document.body.classList.remove('badge-hidden');
});

// -------------------------------------------------------------------
// Selettore schermo overlay (utile con proiettore + laptop collegati)
// -------------------------------------------------------------------
async function populateDisplays() {
  const displays = await window.overlayAPI.getDisplays();
  displaySelect.innerHTML = '';
  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = `${d.width}x${d.height}${d.isPrimary ? ' (principale)' : ' (secondario)'}`;
    displaySelect.appendChild(opt);
  }
}
displaySelect.addEventListener('change', () => {
  window.overlayAPI.moveToDisplay(Number(displaySelect.value));
});
populateDisplays();

// -------------------------------------------------------------------
// 2) Connessione Socket.io + join stanza (persistenza server/codice)
// -------------------------------------------------------------------
// URL del server permanente su Render: precompilato cosi' l'utente deve solo
// incollare il codice stanza. Modificabile a mano e ricordato dopo la 1a connessione.
const DEFAULT_SERVER = 'https://trascrizione-eventi.onrender.com';
const storedServer = localStorage.getItem('lt_overlay_server') || '';
// Ignora eventuali URL di tunnel temporanei (trycloudflare) rimasti in memoria
// da vecchi test: usano un sottodominio che cambia e non e' piu' valido.
serverInput.value = (storedServer && !/trycloudflare\.com/.test(storedServer)) ? storedServer : DEFAULT_SERVER;
roomInput.value = localStorage.getItem('lt_overlay_room') || '';

let socket = null;
let joinedRoomId = null;

function setStatus(connected, label) {
  statusDot.classList.toggle('on', connected);
  statusDot.classList.toggle('off', !connected);
  toggleLabel.textContent = label;
}

function setMessage(text) {
  panelMessage.textContent = text || '';
}

function connect() {
  const serverUrl = serverInput.value.trim().replace(/\/+$/, '');
  const roomId = roomInput.value.trim().toUpperCase();

  if (!/^https?:\/\/.+/.test(serverUrl)) {
    setMessage('Inserisci un URL server valido (es. https://tuo-server.onrender.com).');
    return;
  }
  if (!/^[A-Z0-9]{6}$/.test(roomId)) {
    setMessage('Il codice stanza deve avere 6 caratteri alfanumerici.');
    return;
  }

  setMessage('Connessione in corso...');
  connectBtn.disabled = true;

  socket = io(serverUrl, { transports: ['websocket', 'polling'] });
  bindRoomEvents(socket);

  socket.on('connect', () => {
    socket.emit('display:join-room', { roomId }, (res) => {
      connectBtn.disabled = false;
      if (!res?.ok) {
        setMessage(res?.message || 'Impossibile connettersi alla stanza.');
        socket.disconnect();
        socket = null;
        return;
      }

      joinedRoomId = res.roomId;
      localStorage.setItem('lt_overlay_server', serverUrl);
      localStorage.setItem('lt_overlay_room', roomId);

      setStatus(true, roomId);
      setMessage(res.speakerConnected ? '' : 'In attesa dello speaker...');
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      setPanel(false); // connesso: chiudi il pannello e restringi la finestra
    });
  });

  socket.on('connect_error', () => {
    connectBtn.disabled = false;
    setMessage('Impossibile raggiungere il server.');
  });
}

function disconnect() {
  socket?.disconnect();
  socket = null;
  joinedRoomId = null;
  renderer.clear();
  setStatus(false, 'Live Translate');
  setMessage('');
  connectBtn.hidden = false;
  disconnectBtn.hidden = true;
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
[serverInput, roomInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
});
roomInput.addEventListener('input', () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

// Pre-riempimento del codice stanza dagli appunti: lo Speaker copia il codice
// dal sito (tasto "Copia codice"), qui basta un click su "Incolla".
async function fillRoomFromClipboard(silent) {
  try {
    const text = (await window.overlayAPI.readClipboard()) || '';
    const code = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (/^[A-Z0-9]{6}$/.test(code)) {
      roomInput.value = code;
      if (!silent) setMessage('');
      return true;
    }
    if (!silent) setMessage('Negli appunti non c\'è un codice valido a 6 caratteri.');
  } catch {
    if (!silent) setMessage('Impossibile leggere gli appunti.');
  }
  return false;
}
pasteBtn.addEventListener('click', () => fillRoomFromClipboard(false));

// -------------------------------------------------------------------
// Auto-connessione da link livetranslate://join?server=...&room=...
// (l'utente arriva qui dopo aver abbinato il codice sul sito web)
// -------------------------------------------------------------------
window.overlayAPI.onAutoConnect(({ server, room }) => {
  if (server) serverInput.value = server;
  if (room) roomInput.value = room;
  if (!socket) connect();
});

// -------------------------------------------------------------------
// Rendering sottotitoli in arrivo dal server (eventi legati al socket attivo)
// -------------------------------------------------------------------
function bindRoomEvents(s) {
  s.on('transcript:update', (payload) => {
    if (!payload || payload.roomId !== joinedRoomId) return;
    if (!payload.translatedText) return;
    if (payload.status === 'final') renderer.appendFinal(payload.translatedText);
    else renderer.updateInterim(payload.translatedText);
  });
  s.on('speaker:disconnected', () => setMessage('Speaker disconnesso, in attesa di riaggancio...'));
  s.on('speaker:reconnected', () => setMessage(''));
  s.on('speaker:gone', () => setMessage('Speaker non disponibile.'));
  s.on('room:destroyed', () => {
    setMessage('Sessione terminata.');
    disconnect();
  });
}
