/**
 * translation-engine.js
 * ----------------------------------------------------------------------------
 * Modulo ES6 responsabile di:
 *   1) Acquisizione continua dal microfono via Web Speech API
 *      (webkitSpeechRecognition), con auto-restart quando il browser la
 *      interrompe spontaneamente (tipico su mobile dopo pause di silenzio).
 *   2) Traduzione a bassa latenza dei frammenti riconosciuti (interim/final),
 *      con debounce sugli interim per non saturare l'API di traduzione.
 *   3) Invio dei chunk elaborati al server Node.js via Socket.io.
 *
 * Nessuna dipendenza da build tool: e' un <script type="module"> puro,
 * pensato per essere importato direttamente da dashboard.html.
 */

/**
 * Genera un identificativo breve e sufficientemente unico per un chunk,
 * senza dipendere da crypto.randomUUID (non disponibile su http:// non sicuro).
 */
function generateChunkId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shortLang(code) {
  return String(code || '').trim().toLowerCase().split('-')[0] || 'en';
}

/**
 * Traduzione via MyMemory chiamata DIRETTAMENTE dal browser dello Speaker.
 * Motivo: i servizi gratuiti bloccano gli IP dei datacenter (il proxy sul
 * server Render viene rifiutato con 403/429), mentre il browser dello Speaker
 * ha un IP residenziale normale. MyMemory invia header CORS permissivi.
 * L'email (window.LIVE_TRANSLATE_CONFIG.translateEmail) alza la quota a ~50k
 * parole/giorno; viene inviata solo a MyMemory.
 */
async function translateViaMyMemory(text, sourceLang, targetLang) {
  const langpair = `${shortLang(sourceLang)}|${shortLang(targetLang)}`;
  const email = window.LIVE_TRANSLATE_CONFIG?.translateEmail;
  const de = email ? `&de=${encodeURIComponent(email)}` : '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}${de}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);
  const data = await response.json();
  if (data.responseStatus && Number(data.responseStatus) !== 200) {
    throw new Error(data.responseDetails || 'MyMemory ha rifiutato la richiesta');
  }
  const t = data.responseData?.translatedText;
  if (!t) throw new Error('Risposta di traduzione vuota');
  return t;
}

/**
 * Funzione di traduzione di default: prova MyMemory dal browser; se fallisce,
 * ripiega sul proxy del server (`translateEndpoint`). Sostituibile del tutto
 * con `engine.setTranslator(fn)` per collegare DeepL / OpenAI.
 */
async function defaultTranslate(text, sourceLang, targetLang) {
  if (!text) return '';
  try {
    return await translateViaMyMemory(text, sourceLang, targetLang);
  } catch (browserErr) {
    const endpoint = window.LIVE_TRANSLATE_CONFIG?.translateEndpoint;
    if (!endpoint) throw browserErr;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: sourceLang, target: targetLang }),
    });
    if (!response.ok) throw new Error(`Traduzione non disponibile (HTTP ${response.status})`);
    const data = await response.json();
    return data.translatedText ?? data.translation ?? text;
  }
}

const RECOGNITION_ERROR_MESSAGES = {
  'not-allowed': 'Permesso microfono negato. Abilitalo nelle impostazioni del browser per continuare.',
  'audio-capture': 'Nessun microfono rilevato sul dispositivo.',
  'no-speech': null, // non un vero errore: nessun parlato rilevato nella finestra corrente
  network: 'Connessione di rete instabile: il riconoscimento vocale potrebbe interrompersi.',
  aborted: null, // stop intenzionale, non e' un errore da mostrare
};

export class TranscriptionEngine {
  /**
   * @param {object} opts
   * @param {import('socket.io-client').Socket} opts.socket - connessione Socket.io gia' inizializzata
   * @param {() => string} opts.getRoomId
   * @param {() => string} opts.getSourceLang - es. "it-IT"
   * @param {() => string} opts.getTargetLang - es. "en"
   * @param {(text: string) => void} [opts.onInterim] - callback per anteprima locale (testo originale)
   * @param {(entry: {original: string, translated: string}) => void} [opts.onFinal]
   * @param {(translatedPreview: string) => void} [opts.onTranslationPreview] - traduzione interim
   * @param {(message: string) => void} [opts.onError]
   * @param {(listening: boolean) => void} [opts.onStatusChange]
   */
  constructor({
    socket,
    getRoomId,
    getSourceLang,
    getTargetLang,
    onInterim = () => {},
    onFinal = () => {},
    onTranslationPreview = () => {},
    onError = () => {},
    onStatusChange = () => {},
  }) {
    this.socket = socket;
    this.getRoomId = getRoomId;
    this.getSourceLang = getSourceLang;
    this.getTargetLang = getTargetLang;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onTranslationPreview = onTranslationPreview;
    this.onError = onError;
    this.onStatusChange = onStatusChange;

    this.translateFn = defaultTranslate;

    this._recognition = null;
    this._isListening = false; // stato "desiderato" dall'utente (vs stato reale del motore)
    this._shouldRun = false; // flag per distinguere stop intenzionale da stop spontaneo
    this._utteranceCounter = 0;

    // Streaming interim: traduce/invia al massimo una volta ogni _interimThrottleMs,
    // usando sempre il testo piu' recente, e salta se non e' cambiato niente.
    // Cosi' il flusso di parole a schermo e' quasi istantaneo senza moltiplicare
    // all'infinito le chiamate al servizio di traduzione.
    this._interimThrottleMs = 400;
    this._interimTimer = null;
    this._pendingInterim = '';
    this._lastInterimSent = '';
    this._lastInterimWordCount = 0;
  }

  /** Consente di sostituire il motore di traduzione (DeepL/OpenAI/Google/LibreTranslate). */
  setTranslator(fn) {
    this.translateFn = fn;
  }

  isSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** Avvia acquisizione e riconoscimento continuo. Richiede permesso microfono al browser. */
  async start() {
    if (!this.isSupported()) {
      this.onError('Il riconoscimento vocale non e\' supportato da questo browser. Prova con Chrome.');
      return;
    }

    this._shouldRun = true;
    this._buildRecognition();

    try {
      this._recognition.start();
    } catch (err) {
      // "InvalidStateError" se e' gia' in esecuzione: ignorabile.
      if (err?.name !== 'InvalidStateError') {
        this.onError(`Impossibile avviare il microfono: ${err.message}`);
      }
    }
  }

  /** Ferma volontariamente il riconoscimento (l'utente preme Pausa/Stop). */
  stop() {
    this._shouldRun = false;
    clearTimeout(this._interimTimer);
    this._interimTimer = null;
    this._recognition?.stop();
    this._setListening(false);
  }

  _setListening(value) {
    this._isListening = value;
    this.onStatusChange(value);
  }

  _buildRecognition() {
    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionImpl();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.getSourceLang();

    recognition.onstart = () => {
      this._setListening(true);
    };

    recognition.onresult = (event) => this._handleResult(event);

    recognition.onerror = (event) => {
      const message = RECOGNITION_ERROR_MESSAGES[event.error];
      if (message) this.onError(message);
      // 'not-allowed' e 'audio-capture' sono irrecuperabili: non ha senso auto-restart.
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        this._shouldRun = false;
      }
    };

    // Auto-restart: il browser (specialmente su mobile) puo' terminare
    // spontaneamente il riconoscimento dopo pause di silenzio o timeout interni.
    // Se l'utente non ha premuto Stop, riavviamo immediatamente in modo trasparente.
    recognition.onend = () => {
      this._setListening(false);
      if (this._shouldRun) {
        setTimeout(() => {
          if (!this._shouldRun) return;
          try {
            recognition.lang = this.getSourceLang(); // la lingua puo' essere cambiata nel frattempo
            recognition.start();
          } catch (err) {
            if (err?.name !== 'InvalidStateError') {
              this.onError(`Riavvio automatico del microfono fallito: ${err.message}`);
            }
          }
        }, 250);
      }
    };

    this._recognition = recognition;
  }

  _handleResult(event) {
    // Ricostruisce l'intero buffer di risultati dall'ultimo indice processato,
    // secondo il comportamento standard della Web Speech API.
    let interimText = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      if (result.isFinal) finalText += transcript;
      else interimText += transcript;
    }

    if (interimText) {
      this.onInterim(interimText);
      this._scheduleInterimTranslation(interimText);
    }

    if (finalText) {
      this._processFinal(finalText.trim());
    }
  }

  /**
   * Streaming interim: throttle a intervallo fisso (leading+trailing) che usa
   * sempre l'ultimo testo disponibile e non ritraduce se e' identico all'ultimo
   * inviato. Serve un flusso quasi istantaneo senza saturare il traduttore.
   */
  _scheduleInterimTranslation(text) {
    this._pendingInterim = text;
    if (this._interimTimer) return;
    this._interimTimer = setTimeout(async () => {
      this._interimTimer = null;
      const t = this._pendingInterim;
      if (!t || t === this._lastInterimSent) return;
      // Traduci solo se e' comparsa almeno una parola nuova: le rifiniture
      // dello stesso token dal riconoscitore non valgono una chiamata API.
      const words = t.split(/\s+/).filter(Boolean).length;
      if (words <= this._lastInterimWordCount && t.length <= this._lastInterimSent.length) return;
      this._lastInterimWordCount = words;
      this._lastInterimSent = t;
      const translated = await this._safeTranslate(t);
      if (translated == null) return;
      this.onTranslationPreview(translated);
      this._emitChunk({ status: 'interim', originalText: t, translatedText: translated });
    }, this._interimThrottleMs);
  }

  /** Frase definitiva: tradotta subito per consolidare il flusso. */
  async _processFinal(text) {
    if (!text) return;
    clearTimeout(this._interimTimer); // scarta l'interim ancora in coda per questa frase
    this._interimTimer = null;
    this._lastInterimSent = '';
    this._lastInterimWordCount = 0;

    const translated = await this._safeTranslate(text);
    if (translated == null) return;

    this.onFinal({ original: text, translated });
    this._emitChunk({ status: 'final', originalText: text, translatedText: translated });
  }

  async _safeTranslate(text) {
    try {
      return await this.translateFn(text, this.getSourceLang(), this.getTargetLang());
    } catch (err) {
      // Non blocchiamo mai la pipeline live: meglio mostrare il testo originale
      // (non tradotto) che lasciare un buco silenzioso nei sottotitoli.
      this.onError(`Traduzione non riuscita, mostro il testo originale: ${err.message}`);
      return text;
    }
  }

  _emitChunk({ status, originalText, translatedText }) {
    const roomId = this.getRoomId();
    if (!roomId || !this.socket?.connected) return;

    this._utteranceCounter += 1;
    this.socket.emit('transcript:chunk', {
      roomId,
      chunkId: `${roomId}-${this._utteranceCounter}-${generateChunkId()}`,
      status,
      sourceLang: this.getSourceLang(),
      targetLang: this.getTargetLang(),
      originalText,
      translatedText,
      timestamp: Date.now(),
    });
  }
}

export { defaultTranslate };
