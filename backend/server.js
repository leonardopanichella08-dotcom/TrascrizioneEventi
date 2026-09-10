'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { RoomManager } = require('./src/roomManager');
const { sanitizeChunkPayload, isValidRoomId, sanitizeText, sanitizeLang } = require('./src/sanitize');
const { translateViaMyMemory } = require('./src/translate');
const logger = require('./src/logger');

const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const GRACE_MS = Number(process.env.SPEAKER_GRACE_PERIOD_SECONDS || 60) * 1000;
const MAX_IDLE_MS = Number(process.env.ROOM_MAX_IDLE_HOURS || 6) * 60 * 60 * 1000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Serve il frontend statico dallo stesso servizio/origine: evita CORS e
// permette un deploy singolo (un solo servizio Render/Railway per tutto).
app.use(express.static(FRONTEND_DIR));

// Endpoint di health-check, utile per Render/Railway e per uptime monitor.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    activeRooms: roomManager.rooms.size,
    uptimeSeconds: process.uptime(),
    // true = quota MyMemory alzata (~50k parole/giorno). Non espone l'email.
    translateQuotaBoosted: Boolean(process.env.MYMEMORY_EMAIL),
  });
});

// Proxy di traduzione lato server (vedi src/translate.js): tiene la logica del
// provider fuori dal browser e in un solo punto sostituibile.
app.post('/translate', async (req, res) => {
  const text = sanitizeText(req.body?.text, 2000);
  const source = sanitizeLang(req.body?.source);
  const target = sanitizeLang(req.body?.target);

  if (!text || !source || !target) {
    return res.status(400).json({ error: 'Parametri mancanti o non validi (text, source, target).' });
  }

  try {
    const translatedText = await translateViaMyMemory(text, source, target);
    res.json({ translatedText });
  } catch (err) {
    logger.warn(`Traduzione fallita (${source} -> ${target}): ${err.message}`);
    res.status(502).json({ error: 'Servizio di traduzione temporaneamente non disponibile.' });
  }
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  // Ping piu' frequente per rilevare disconnessioni mobile rapidamente,
  // pur restando tollerante a brevi interruzioni di rete (roaming, tunnel).
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

const roomManager = new RoomManager({ graceMs: GRACE_MS, maxIdleMs: MAX_IDLE_MS, logger });

// ---------------------------------------------------------------------------
// Propagazione eventi di stato stanza verso i client connessi
// ---------------------------------------------------------------------------

function broadcastRoomState(roomId) {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  io.to(roomId).emit('room:state', {
    roomId,
    speakerConnected: Boolean(room.speakerSocketId),
    displaysCount: room.displaySocketIds.size,
  });
}

roomManager.on('speaker:grace-started', ({ roomId, graceMs }) => {
  io.to(roomId).emit('speaker:disconnected', { roomId, graceMs, temporary: true });
  broadcastRoomState(roomId);
  logger.warn(`Speaker disconnesso dalla stanza ${roomId}, grazia di ${graceMs}ms avviata`);
});

roomManager.on('speaker:grace-expired', ({ roomId }) => {
  io.to(roomId).emit('speaker:gone', { roomId });
  logger.warn(`Grazia scaduta per la stanza ${roomId}: speaker considerato uscito definitivamente`);
});

roomManager.on('room:destroyed', ({ roomId }) => {
  io.to(roomId).emit('room:destroyed', { roomId });
  // Forza l'uscita di eventuali socket residui dalla room Socket.io, cosi' la
  // memoria associata (listener, riferimenti interni) viene rilasciata subito.
  io.socketsLeave(roomId);
  logger.info(`Stanza distrutta e memoria liberata: ${roomId}`);
});

// ---------------------------------------------------------------------------
// Wiring degli eventi Socket.io per connessione client
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  logger.info(`Client connesso: ${socket.id}`);
  socket.data.role = null; // 'speaker' | 'display'
  socket.data.roomId = null;

  // --- Speaker: creazione stanza -------------------------------------------------
  socket.on('speaker:create-room', (_payload, ack) => {
    const { roomId, speakerSecret } = roomManager.createRoom(socket.id);
    socket.join(roomId);
    socket.data.role = 'speaker';
    socket.data.roomId = roomId;

    logger.info(`Nuova stanza creata: ${roomId} (speaker ${socket.id})`);
    const response = { roomId, speakerSecret };
    if (typeof ack === 'function') ack({ ok: true, ...response });
    else socket.emit('room:created', response);

    broadcastRoomState(roomId);
  });

  // --- Speaker: riaggancio dopo disconnessione temporanea -------------------------
  socket.on('speaker:rejoin', ({ roomId, speakerSecret } = {}, ack) => {
    const cleanRoomId = typeof roomId === 'string' ? roomId.toUpperCase().trim() : '';
    if (!isValidRoomId(cleanRoomId)) {
      const err = { ok: false, code: 'INVALID_ROOM_ID', message: 'Codice stanza non valido.' };
      if (typeof ack === 'function') ack(err);
      else socket.emit('room:error', err);
      return;
    }

    const result = roomManager.reclaimSpeaker(cleanRoomId, speakerSecret, socket.id);
    if (!result.ok) {
      const err = { ok: false, code: result.reason, message: 'Impossibile riagganciarsi alla stanza.' };
      if (typeof ack === 'function') ack(err);
      else socket.emit('room:error', err);
      return;
    }

    socket.join(cleanRoomId);
    socket.data.role = 'speaker';
    socket.data.roomId = cleanRoomId;

    logger.info(`Speaker riagganciato alla stanza ${cleanRoomId} (${socket.id})`);
    if (typeof ack === 'function') ack({ ok: true, roomId: cleanRoomId });
    io.to(cleanRoomId).emit('speaker:reconnected', { roomId: cleanRoomId });
    broadcastRoomState(cleanRoomId);
  });

  // --- Display: accesso alla stanza -----------------------------------------------
  socket.on('display:join-room', ({ roomId } = {}, ack) => {
    const cleanRoomId = typeof roomId === 'string' ? roomId.toUpperCase().trim() : '';
    if (!isValidRoomId(cleanRoomId)) {
      const err = { ok: false, code: 'INVALID_ROOM_ID', message: 'Formato codice stanza non valido.' };
      if (typeof ack === 'function') ack(err);
      else socket.emit('room:error', err);
      return;
    }

    const room = roomManager.joinDisplay(cleanRoomId, socket.id);
    if (!room) {
      const err = { ok: false, code: 'ROOM_NOT_FOUND', message: 'Nessuna stanza attiva con questo codice.' };
      if (typeof ack === 'function') ack(err);
      else socket.emit('room:error', err);
      return;
    }

    socket.join(cleanRoomId);
    socket.data.role = 'display';
    socket.data.roomId = cleanRoomId;

    logger.info(`Display connesso alla stanza ${cleanRoomId} (${socket.id})`);
    const response = { ok: true, roomId: cleanRoomId, speakerConnected: Boolean(room.speakerSocketId) };
    if (typeof ack === 'function') ack(response);
    else socket.emit('room:joined', response);

    broadcastRoomState(cleanRoomId);
  });

  // --- Pipeline dati: forward a bassa latenza dei chunk trascritti/tradotti -------
  socket.on('transcript:chunk', (raw) => {
    // Solo lo speaker della stanza puo' inviare chunk: evita che un display
    // (o un client malevolo che ha solo il roomId) inietti testo falso.
    if (socket.data.role !== 'speaker' || !socket.data.roomId) return;

    const payload = sanitizeChunkPayload(raw);
    if (!payload || payload.roomId !== socket.data.roomId) return;

    roomManager.touch(payload.roomId);
    // Forward immediato a tutti i display della stanza (esclude il mittente:
    // lo speaker mostra gia' l'anteprima locale senza bisogno di echo dal server).
    socket.to(payload.roomId).emit('transcript:update', payload);
  });

  // --- Disconnessione ---------------------------------------------------------
  socket.on('disconnect', (reason) => {
    const { role, roomId } = socket.data;
    logger.info(`Client disconnesso: ${socket.id} (motivo: ${reason})`);
    if (!roomId) return;

    if (role === 'speaker') {
      // Solo se questo socket e' ancora quello registrato come speaker attivo
      // (evita di avviare una grazia "fantasma" dopo un rejoin da altro socket).
      const room = roomManager.getRoom(roomId);
      if (room && room.speakerSocketId === socket.id) {
        roomManager.handleSpeakerDisconnect(roomId);
      }
    } else if (role === 'display') {
      roomManager.leaveDisplay(roomId, socket.id);
      broadcastRoomState(roomId);
    }
  });
});

// ---------------------------------------------------------------------------
// Diagnostica periodica: stato stanze attive su console
// ---------------------------------------------------------------------------

setInterval(() => logger.roomsSnapshot(roomManager), 30_000).unref?.();

httpServer.listen(PORT, () => {
  logger.info(`Live Translate backend in ascolto sulla porta ${PORT}`);
  logger.info(`CORS origin consentita: ${CORS_ORIGIN}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM ricevuto, chiusura server in corso...');
  roomManager.shutdown();
  httpServer.close(() => process.exit(0));
});
