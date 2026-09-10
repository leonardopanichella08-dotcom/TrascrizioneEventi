/**
 * subtitle-renderer.js
 * ----------------------------------------------------------------------------
 * Logica di rendering dei sottotitoli condivisa tra:
 *   - frontend/display.html (vista browser / OBS Browser Source)
 *   - overlay-app (finestra desktop trasparente sempre in primo piano)
 *
 * Modalita' "flusso di parole": non mostra l'intera frase, ma un flusso
 * continuo in cui l'ultima parola detta compare subito ed evidenziata; il
 * testo piu' vecchio scorre verso l'alto e sparisce. Al massimo 2 righe
 * visibili (il resto viene tagliato dal contenitore). Pause ed errori dello
 * speaker non contano: il flusso non si ferma mai ad aspettare la frase.
 *
 * NB: la copia in overlay-app/renderer/subtitle-renderer.js va tenuta
 * allineata a questa (import cross-cartella non affidabile nel pacchetto).
 */

export class SubtitleRenderer {
  /**
   * @param {HTMLElement} container
   * @param {{ maxWords?: number }} [opts] maxWords = limite di sicurezza sul
   *   testo tenuto in memoria; le righe VISIBILI restano 2, imposte dal CSS.
   */
  constructor(container, { maxWords = 28 } = {}) {
    this.container = container;
    this.maxWords = maxWords;
    this._committed = '';   // parlato gia' finalizzato (troncato in coda a maxWords)
    this._rendered = '';    // ultimo testo effettivamente a schermo
    this._lastHeadWord = '';
    // Il testo vive in un figlio ancorato in basso (via CSS): quando supera
    // le 2 righe, la parte alta esce dal contenitore e viene tagliata.
    this.streamEl = document.createElement('div');
    this.streamEl.className = 'subtitle-stream';
    this.container.appendChild(this.streamEl);
  }

  _tailByWords(s) {
    const w = String(s).trim().split(/\s+/).filter(Boolean);
    return w.slice(-this.maxWords).join(' ');
  }

  /** Disegna il testo: corpo come testo semplice + ultima parola in uno span animabile. */
  _render(fullText) {
    const text = this._tailByWords(fullText);
    if (text === this._rendered) return;

    const words = text.split(' ');
    const headWord = words.length ? words[words.length - 1] : '';
    const body = words.slice(0, -1).join(' ');

    this.streamEl.textContent = body ? body + ' ' : '';
    if (headWord) {
      const headEl = document.createElement('span');
      headEl.className = 'head-word';
      headEl.textContent = headWord;
      // Anima solo quando la parola in testa cambia davvero, non ad ogni
      // rifinitura dello stesso token da parte del riconoscitore.
      if (headWord !== this._lastHeadWord) headEl.classList.add('pop');
      this.streamEl.appendChild(headEl);
    }

    this._rendered = text;
    this._lastHeadWord = headWord;
  }

  /** Anteprima in corso: aggiorna il flusso in tempo reale. */
  updateInterim(text) {
    if (!text) return;
    this._render(`${this._committed} ${text}`.trim());
  }

  /** Segmento finalizzato: lo consolida e continua il flusso. */
  appendFinal(text) {
    if (!text) return;
    this._committed = this._tailByWords(`${this._committed} ${text}`.trim());
    this._render(this._committed);
  }

  /** Azzera tutto (es. cambio stanza / sessione terminata). */
  clear() {
    this._committed = '';
    this._rendered = '';
    this._lastHeadWord = '';
    this.streamEl.textContent = '';
  }
}
