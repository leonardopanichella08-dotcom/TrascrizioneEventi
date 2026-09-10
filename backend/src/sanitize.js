'use strict';

/**
 * Sanificazione input minima ma efficace per un canale real-time testuale.
 * Obiettivo: neutralizzare injection (HTML/script) e input anomali (payload
 * enormi, caratteri di controllo) senza appesantire la pipeline a bassa latenza.
 */

const MAX_TEXT_LENGTH = 4000; // un "chunk" di parlato non supera mai questa lunghezza
const MAX_LANG_LENGTH = 20;
const ROOM_ID_REGEX = /^[A-Z0-9]{6}$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/** Rimuove tag HTML, entita' pericolose e caratteri di controllo da una stringa. */
function sanitizeText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return '';

  let out = value
    // rimuove tag HTML/XML (< ... >) per evitare injection nel display
    .replace(/<[^>]*>/g, '')
    // rimuove caratteri di controllo (eccetto whitespace normale, gestito da trim)
    .replace(CONTROL_CHARS_REGEX, '')
    .trim();

  if (out.length > maxLength) {
    out = out.slice(0, maxLength);
  }
  return out;
}

/** Valida/normalizza un codice di lingua semplice (es. "it", "en-US"). */
function sanitizeLang(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().slice(0, MAX_LANG_LENGTH);
  // consente solo lettere, trattini e underscore (BCP-47 like)
  return /^[a-zA-Z-_]+$/.test(cleaned) ? cleaned : '';
}

/** Valida il formato del codice stanza (6 caratteri alfanumerici maiuscoli). */
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_REGEX.test(roomId);
}

/** Sanifica l'intero payload di un chunk di trascrizione/traduzione. */
function sanitizeChunkPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const roomId = typeof raw.roomId === 'string' ? raw.roomId.toUpperCase().trim() : '';
  if (!isValidRoomId(roomId)) return null;

  const status = raw.status === 'final' ? 'final' : 'interim'; // whitelist rigida

  return {
    roomId,
    chunkId: sanitizeText(String(raw.chunkId ?? ''), 128) || null,
    status,
    sourceLang: sanitizeLang(raw.sourceLang),
    targetLang: sanitizeLang(raw.targetLang),
    originalText: sanitizeText(raw.originalText),
    translatedText: sanitizeText(raw.translatedText),
    // il timestamp e' sempre generato/validato server-side, mai fidarsi del client
    timestamp: Date.now(),
  };
}

module.exports = {
  sanitizeText,
  sanitizeLang,
  isValidRoomId,
  sanitizeChunkPayload,
  ROOM_ID_REGEX,
};
