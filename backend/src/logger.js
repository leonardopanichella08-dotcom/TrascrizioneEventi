'use strict';

/**
 * Logger essenziale su console con timestamp ISO e livelli.
 * Niente dipendenze esterne: per un servizio di questa dimensione
 * un logger strutturato pesante (winston/pino) sarebbe overengineering.
 */

function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info(msg, meta) {
    console.log(`[${timestamp()}] [INFO]  ${msg}`, meta ?? '');
  },
  warn(msg, meta) {
    console.warn(`[${timestamp()}] [WARN]  ${msg}`, meta ?? '');
  },
  error(msg, meta) {
    console.error(`[${timestamp()}] [ERROR] ${msg}`, meta ?? '');
  },
  /** Stampa lo stato corrente di tutte le stanze attive (diagnostica). */
  roomsSnapshot(roomManager) {
    const rooms = roomManager.listRoomsSummary();
    if (rooms.length === 0) {
      console.log(`[${timestamp()}] [STATE] Nessuna stanza attiva.`);
      return;
    }
    console.log(`[${timestamp()}] [STATE] Stanze attive: ${rooms.length}`);
    for (const r of rooms) {
      console.log(
        `    - ${r.roomId} | speaker: ${r.speakerConnected ? 'connesso' : `assente (grazia ${r.graceRemainingMs}ms)`} | display: ${r.displaysCount} | eta: ${r.ageMinutes}min`
      );
    }
  },
};

module.exports = logger;
