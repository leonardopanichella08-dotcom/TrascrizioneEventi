'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Alfabeto senza caratteri ambigui (0/O, 1/I/L) per codici stanza leggibili a voce/vista.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

/**
 * RoomManager: unica fonte di verita' per lo stato delle stanze in memoria.
 * Nessuna persistenza esterna per design: le sessioni sono effimere (durata
 * di un evento) e questo evita complessita' operativa inutile.
 *
 * Eventi emessi:
 *  - 'room:destroyed'        { roomId }
 *  - 'speaker:grace-started' { roomId, graceMs }
 *  - 'speaker:grace-expired' { roomId }
 */
class RoomManager extends EventEmitter {
  constructor({ graceMs = 60_000, maxIdleMs = 6 * 60 * 60 * 1000, logger = console } = {}) {
    super();
    this.graceMs = graceMs;
    this.maxIdleMs = maxIdleMs;
    this.logger = logger;
    /** @type {Map<string, RoomState>} */
    this.rooms = new Map();

    // Rete di sicurezza contro leak di memoria: rimuove stanze "zombie"
    // rimaste inattive troppo a lungo (es. crash di client senza evento disconnect).
    this._sweepInterval = setInterval(() => this._sweepIdleRooms(), 5 * 60 * 1000);
    this._sweepInterval.unref?.();
  }

  /** Genera un codice stanza univoco a 6 caratteri alfanumerici. */
  _generateRoomId() {
    let roomId;
    do {
      const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
      roomId = Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join('');
    } while (this.rooms.has(roomId));
    return roomId;
  }

  /** Crea una nuova stanza per uno Speaker e restituisce { roomId, speakerSecret }. */
  createRoom(speakerSocketId) {
    const roomId = this._generateRoomId();
    const speakerSecret = crypto.randomUUID();

    const room = {
      roomId,
      speakerSocketId,
      speakerSecret,
      displaySocketIds: new Set(),
      graceTimer: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.rooms.set(roomId, room);
    return { roomId, speakerSecret };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  touch(roomId) {
    const room = this.rooms.get(roomId);
    if (room) room.lastActivityAt = Date.now();
  }

  /** Un Display prova ad unirsi: valida esistenza stanza e la registra. */
  joinDisplay(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.displaySocketIds.add(socketId);
    room.lastActivityAt = Date.now();
    return room;
  }

  /** Rimuove un Display dalla stanza (su disconnessione). Restituisce la stanza se ancora presente. */
  leaveDisplay(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.displaySocketIds.delete(socketId);
    this._destroyIfEmpty(room);
    return room;
  }

  /**
   * Gestisce la disconnessione dello Speaker: NON distrugge subito la stanza,
   * avvia una finestra di grazia (default 60s) in attesa del riaggancio.
   */
  handleSpeakerDisconnect(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.speakerSocketId = null;
    this.emit('speaker:grace-started', { roomId, graceMs: this.graceMs });

    clearTimeout(room.graceTimer);
    room.graceTimer = setTimeout(() => {
      room.graceTimer = null;
      // Se nel frattempo lo speaker non si e' riagganciato, la stanza resta
      // "orfana" di speaker; viene distrutta solo se anche i display sono assenti.
      this.emit('speaker:grace-expired', { roomId });
      this._destroyIfEmpty(room);
    }, this.graceMs);
  }

  /**
   * Tenta di riagganciare uno Speaker ad una stanza esistente usando il
   * segreto rilasciato alla creazione (evita che chiunque conosca il roomId
   * possa "rubare" il ruolo di speaker).
   */
  reclaimSpeaker(roomId, speakerSecret, newSocketId) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: 'ROOM_NOT_FOUND' };
    if (room.speakerSecret !== speakerSecret) return { ok: false, reason: 'INVALID_SECRET' };

    clearTimeout(room.graceTimer);
    room.graceTimer = null;
    room.speakerSocketId = newSocketId;
    room.lastActivityAt = Date.now();
    return { ok: true, room };
  }

  /** Distrugge la stanza se non ha ne' speaker connesso (grazia scaduta) ne' display. */
  _destroyIfEmpty(room) {
    const speakerGoneForGood = !room.speakerSocketId && !room.graceTimer;
    const noDisplays = room.displaySocketIds.size === 0;
    if (speakerGoneForGood && noDisplays) {
      this.destroyRoom(room.roomId);
    }
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    clearTimeout(room.graceTimer);
    this.rooms.delete(roomId);
    this.emit('room:destroyed', { roomId });
  }

  _sweepIdleRooms() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (now - room.lastActivityAt > this.maxIdleMs) {
        this.logger.warn?.(`Rimozione stanza inattiva da troppo tempo: ${room.roomId}`);
        this.destroyRoom(room.roomId);
      }
    }
  }

  /** Riepilogo leggibile delle stanze attive, per logging/diagnostica. */
  listRoomsSummary() {
    const now = Date.now();
    return Array.from(this.rooms.values()).map((room) => ({
      roomId: room.roomId,
      speakerConnected: Boolean(room.speakerSocketId),
      graceRemainingMs: room.graceTimer ? this.graceMs : 0,
      displaysCount: room.displaySocketIds.size,
      ageMinutes: Math.round((now - room.createdAt) / 60000),
    }));
  }

  shutdown() {
    clearInterval(this._sweepInterval);
    for (const room of this.rooms.values()) {
      clearTimeout(room.graceTimer);
    }
    this.rooms.clear();
  }
}

module.exports = { RoomManager, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH };
