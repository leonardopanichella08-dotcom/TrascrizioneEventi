/**
 * subtitle-renderer.js
 * ----------------------------------------------------------------------------
 * Logica di rendering dei sottotitoli condivisa tra:
 *   - frontend/display.html (vista browser classica / OBS Browser Source)
 *   - overlay-app (finestra desktop trasparente sempre in primo piano)
 *
 * Riceve un container gia' posizionato/stilizzato dal chiamante e gestisce
 * solo la logica delle righe: aggiunta, sostituzione dell'anteprima interim,
 * animazione di ingresso/uscita e limite massimo di righe visibili.
 *
 * Ogni riga e' un "chip" (sfondo semi-trasparente + bordi arrotondati) cosi'
 * il testo resta leggibile sopra qualunque contenuto sottostante (slide,
 * PDF, pagina web) — come una sovrapposizione PNG, non un pannello opaco.
 */

export class SubtitleRenderer {
  /**
   * @param {HTMLElement} container
   * @param {{ maxLines?: number, fallbackRemoveMs?: number }} [opts]
   */
  constructor(container, { maxLines = 3, fallbackRemoveMs = 700 } = {}) {
    this.container = container;
    this.maxLines = maxLines;
    this.fallbackRemoveMs = fallbackRemoveMs;
    this.interimEl = null;
  }

  /** Aggiunge una riga definitiva; rimpiazza l'eventuale anteprima interim in corso. */
  appendFinal(text) {
    if (!text) return;
    if (this.interimEl) {
      this.interimEl.remove();
      this.interimEl = null;
    }

    const line = document.createElement('div');
    line.className = 'subtitle-line final';
    line.textContent = text;
    this.container.appendChild(line);

    // Forza un reflow cosi' la transizione parte davvero da opacity:0.
    // eslint-disable-next-line no-unused-expressions
    line.offsetHeight;
    requestAnimationFrame(() => line.classList.add('shown'));

    this._pruneOldLines();
  }

  /** Aggiorna (o crea) la riga di anteprima interim, senza animazioni ripetute ad ogni battito. */
  updateInterim(text) {
    if (!text) return;
    if (!this.interimEl) {
      this.interimEl = document.createElement('div');
      this.interimEl.className = 'subtitle-line interim';
      this.container.appendChild(this.interimEl);
      this.interimEl.offsetHeight;
      requestAnimationFrame(() => this.interimEl.classList.add('shown'));
    }
    this.interimEl.textContent = text;
  }

  /** Svuota tutte le righe (es. su cambio stanza). */
  clear() {
    this.container.innerHTML = '';
    this.interimEl = null;
  }

  _pruneOldLines() {
    const finalLines = Array.from(this.container.querySelectorAll('.subtitle-line.final'));
    const excess = finalLines.length - this.maxLines;
    for (let i = 0; i < excess; i++) {
      const el = finalLines[i];
      el.classList.add('fading');
      el.classList.remove('shown');
      const remove = () => el.remove();
      el.addEventListener('transitionend', remove, { once: true });
      // Rete di sicurezza: se la finestra/tab e' in background le transizioni
      // CSS possono essere sospese dal motore di rendering e 'transitionend'
      // non scatta mai, causando accumulo di nodi DOM durante un evento lungo.
      setTimeout(remove, this.fallbackRemoveMs);
    }
  }
}
