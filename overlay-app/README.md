# Live Translate — Overlay Desktop

App desktop (Electron) che apre una **finestra trasparente, senza bordi,
sempre in primo piano**, agganciata alla parte inferiore dello schermo del
proiettore. Mostra i sottotitoli sopra a **qualsiasi cosa** stia proiettando
quel PC — PowerPoint/Keynote a schermo intero, un PDF, una pagina web,
un'altra finestra — senza dover cambiare le tue abitudini di presentazione.

## Apertura automatica dal sito (consigliato)

L'app è già installata e registrata su questo PC come gestore del link
`livetranslate://`. Questo significa che il flusso normale è:

1. Sul sito, scegli **"Sono lo Schermo"**.
2. Inserisci il codice stanza a 6 caratteri (mostrato allo Speaker).
3. Il browser chiede una volta "Aprire Live Translate Overlay?" → conferma.
4. L'app si apre **già connessa alla stanza giusta**, nessun altro passaggio.

Non serve più aprire un terminale né inserire manualmente server/codice: è
tutto automatico da quel momento in poi, su questo PC.

> Se il browser chiede ogni volta conferma ("Aprire sempre link di questo
> tipo con questa app?"), spunta l'opzione per ricordare la scelta.

## Eseguibile

L'app pronta all'uso si trova in:

```
overlay-app\dist\win-unpacked\Live Translate Overlay.exe
```

Puoi trascinarla sul Desktop o aggiungerla alla barra delle applicazioni per
un accesso rapido. Se la sposti in un'altra cartella, va rieseguita una volta
per aggiornare la registrazione del link (vedi sotto).

## Uso manuale (senza passare dal sito)

- L'intera finestra, tranne il piccolo badge **"Live Translate"** in alto a
  destra, **lascia passare i click** a ciò che sta sotto: puoi cliccare,
  scorrere le slide, usare il mouse normalmente come se l'overlay non ci
  fosse.
- Passa il mouse sul badge (o cliccalo) per aprire il pannello e inserire a
  mano **URL server** e **codice stanza**, poi premi **Connetti**.
- Server e codice vengono ricordati per la volta successiva.

## Chiudere l'app

- **Rapido**: passa il mouse sul badge in alto a destra e premi la "×"
  accanto — chiude l'app subito, senza aprire il pannello.
- In alternativa, apri il pannello (click sul badge) e premi **Esci**.
- Non essendo mostrata nella barra delle applicazioni (`skipTaskbar`), questi
  sono gli unici due modi per chiuderla dall'interfaccia.

## Selezione dello schermo

Il menu **"Schermo overlay"** nel pannello elenca i monitor collegati. Di
default l'app si posiziona sul **secondo schermo** se ne rileva uno
(tipicamente il proiettore); su un solo monitor usa quello. Puoi cambiarlo in
qualsiasi momento dal pannello.

## Rigenerare l'eseguibile / registrare il link su un altro PC

```bash
cd overlay-app
npm install
npm run dist
```

L'app pronta finisce in `dist/win-unpacked/`. Eseguila almeno una volta sul
PC dove verrà usata: al primo avvio si registra automaticamente come gestore
di `livetranslate://` (nessuna azione manuale richiesta, nessun account).

> Nota tecnica: la build produce un `.exe` standalone completo e funzionante.
> L'ultimo step opzionale di electron-builder (comprimerlo in un unico file
> "portable") richiede la Modalità Sviluppatore di Windows attiva
> (Impostazioni → Aggiornamento e sicurezza → Per sviluppatori) per creare
> link simbolici; senza non è un problema — la cartella `win-unpacked`
> generata è già pienamente utilizzabile così com'è.

## Limiti noti

- Alcuni software di presentazione in modalità "Presentatore esclusiva" con
  rendering DirectX/OpenGL a bassissimo livello (rari, principalmente
  videogiochi) potrebbero non lasciar passare finestre sempre-in-primo-piano.
  PowerPoint, Keynote, PDF reader e browser non rientrano in questo caso.
- La finestra ha un'altezza fissa (260px) ancorata al bordo inferiore dello
  schermo scelto; non è (ancora) ridimensionabile via UI.
