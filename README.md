# Live Translate — Trascrizione e traduzione simultanea per eventi

App per trascrivere dal vivo il parlato di uno **Speaker** (smartphone/desktop)
e mostrarne la traduzione in tempo reale su uno **Schermo** (proiettore,
browser, o come overlay trasparente sopra una presentazione), tramite una
stanza identificata da un codice a 6 caratteri.

## Struttura del progetto

```
live-translate-app/
├── backend/                     # Node.js + Express + Socket.io
│   ├── server.js                 # server HTTP + Socket.io; serve anche il frontend statico
│   ├── src/
│   │   ├── roomManager.js        # stato stanze in memoria, grazia riconnessione, cleanup
│   │   ├── sanitize.js           # sanificazione/validazione input
│   │   ├── translate.js          # proxy verso il servizio di traduzione (MyMemory, gratuito)
│   │   └── logger.js             # logging console + snapshot diagnostico
│   ├── package.json
│   └── .env.example
│
├── frontend/                    # file statici, serviti dal backend
│   ├── index.html                # pagina di ingresso: scegli Speaker o Schermo
│   ├── dashboard.html             # pannello di controllo Speaker (mobile + desktop)
│   ├── display.html               # vista Schermo: pairing + sottotitoli (browser / OBS)
│   └── js/
│       ├── translation-engine.js  # cattura microfono, Web Speech API, traduzione, socket
│       ├── subtitle-renderer.js   # rendering condiviso dei sottotitoli (chip animati)
│       └── languages.js           # elenco lingue supportate (>20)
│
├── overlay-app/                 # app desktop (Electron): overlay trasparente sempre in primo piano
│   ├── main.js / preload.js
│   ├── renderer/ (overlay.html/css/js)
│   └── README.md                 # istruzioni dedicate
│
└── README.md
```

## Tre modi di mostrare i sottotitoli

1. **`display.html` in un browser normale** — schermo/proiettore dedicato solo a
   quello, sfondo nero pieno. Il più semplice.
2. **`display.html?transparent=1` come OBS Browser Source** — se usi già OBS
   Studio o software di regia simile per comporre lo schermo del proiettore,
   aggiungi questa pagina come sorgente trasparente sopra le altre.
3. **App desktop `overlay-app/`** — finestra trasparente, senza bordi, sempre
   in primo piano, che si sovrappone direttamente a PowerPoint/PDF/qualsiasi
   altra finestra senza bisogno di altro software. Vedi
   [`overlay-app/README.md`](overlay-app/README.md).

## Come funziona (flusso dati)

1. Lo **Speaker** apre `dashboard.html`: il client crea automaticamente una stanza
   (`speaker:create-room`) e riceve un codice a 6 caratteri + un `speakerSecret`
   privato (usato solo per il riaggancio, mai mostrato in UI).
2. Lo **Schermo** (browser, OBS o overlay desktop) inserisce il codice ed entra
   nella stanza (`display:join-room`).
3. Lo Speaker preme *AVVIA TRASCRIZIONE*: il microfono viene acquisito, il testo
   riconosciuto viene tradotto (tramite `POST /translate` sul backend) e inviato
   al server (`transcript:chunk`), che lo inoltra immediatamente
   (`transcript:update`) a tutti gli Schermi della stanza.
4. Se lo Speaker perde la connessione (es. rete mobile instabile), la stanza
   resta viva per **60 secondi** in attesa del riaggancio automatico
   (`speaker:rejoin`), senza che lo Schermo perda la sessione.
5. Quando sia Speaker che Schermo hanno abbandonato la stanza, questa viene
   distrutta e la memoria associata liberata immediatamente.

## Esecuzione in locale (sviluppo)

Un solo servizio da avviare: il backend serve anche tutte le pagine statiche.

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Apri `http://localhost:3001` — la pagina di ingresso fa scegliere se procedere
come Speaker (`dashboard.html`) o come Schermo (`display.html`).

> Nota microfono: la Web Speech API richiede un contesto sicuro. `localhost`
> va bene in HTTP; qualsiasi altro host richiede **HTTPS**.

## Traduzione

Il backend include già un proxy di traduzione funzionante e gratuito
(`POST /translate`, vedi [`backend/src/translate.js`](backend/src/translate.js)),
basato su [MyMemory](https://mymemory.translated.net/) — nessuna chiave API
richiesta. Ha una quota giornaliera generosa ma non illimitata: per un uso
intensivo/professionale, sostituisci `translateViaMyMemory` con una chiamata a
DeepL / OpenAI / Google Translate (stesso punto, un solo file da cambiare).

## Deploy su Render / Railway (un solo servizio, backend + frontend)

1. Pusha il repository su GitHub.
2. Crea un nuovo **Web Service** collegato al repo, con **Root Directory** =
   `backend`.
3. Build command: `npm install` — Start command: `npm start`.
4. Imposta le variabili d'ambiente (dalla dashboard del servizio):
   - `CORS_ORIGIN` → `*` va bene dato che frontend e backend sono sullo stesso
     dominio in questo setup.
   - `SPEAKER_GRACE_PERIOD_SECONDS` (default `60`)
   - `ROOM_MAX_IDLE_HOURS` (default `6`)
   - Non impostare `PORT`: sia Render che Railway la iniettano automaticamente
     e `server.js` la legge da `process.env.PORT`.
5. Deploy. Verifica con `GET https://<tuo-servizio>/health`.
6. Apri `https://<tuo-servizio>/` per la pagina di ingresso — questo è anche
   l'URL server da inserire nell'app desktop overlay.

**Note WebSocket**: sia Render che Railway supportano WebSocket persistenti
sui Web Service standard, nessuna configurazione aggiuntiva richiesta.
Socket.io fa comunque automaticamente fallback a long-polling se necessario.

## Sicurezza implementata

- Sanificazione di tutti i campi testuali in ingresso (rimozione tag
  HTML/caratteri di controllo, limiti di lunghezza) — vedi `src/sanitize.js`.
- Solo il socket registrato come Speaker della stanza può inviare chunk di
  trascrizione (`transcript:chunk` viene scartato silenziosamente altrimenti).
- Riaggancio dello Speaker protetto da un `speakerSecret` generato con
  `crypto.randomUUID()`, mai esposto nella UI né conoscibile dal solo codice
  stanza — impedisce che uno Schermo (o terzi) rubi il ruolo di Speaker.
- Codici stanza generati con `crypto.randomBytes`, alfabeto senza caratteri
  ambigui (0/O, 1/I/L).
