'use strict';

/**
 * Proxy di traduzione lato server. Prova piu' provider gratuiti in ordine e
 * usa il primo che risponde: i servizi gratuiti spesso bloccano gli IP dei
 * datacenter (Render), quindi averne piu' di uno rende il tutto affidabile.
 * Tutta la logica sta qui: per passare a DeepL/OpenAI si tocca un solo file.
 */

// MyMemory vuole alcuni codici lingua in formato esteso; gli altri provider
// preferiscono il codice ISO breve.
const MYMEMORY_OVERRIDES = { zh: 'zh-CN' };

function shortLang(code) {
  return String(code || '').trim().toLowerCase().split('-')[0] || 'en';
}
function myMemoryLang(code) {
  const clean = String(code || '').trim();
  return MYMEMORY_OVERRIDES[clean] || clean;
}

async function fetchJson(url, ms = 7000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'LiveTranslate/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** MyMemory — quota gratuita alzata a ~50k parole/giorno se MYMEMORY_ACCOUNT_EMAIL e' impostata. */
async function viaMyMemory(text, source, target) {
  const langpair = `${myMemoryLang(source)}|${myMemoryLang(target)}`;
  const email = process.env.MYMEMORY_ACCOUNT_EMAIL;
  const de = email ? `&de=${encodeURIComponent(email)}` : '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}${de}`;
  const data = await fetchJson(url);
  if (data.responseStatus && Number(data.responseStatus) !== 200) {
    throw new Error(data.responseDetails || 'MyMemory rifiutato');
  }
  const t = data.responseData?.translatedText;
  if (!t) throw new Error('MyMemory risposta vuota');
  return t;
}

/** Lingva Translate — front-end privacy per Google Translate, senza chiave, nessuna quota pratica. */
function makeLingva(host) {
  return async function viaLingva(text, source, target) {
    const url = `https://${host}/api/v1/${shortLang(source)}/${shortLang(target)}/${encodeURIComponent(text)}`;
    const data = await fetchJson(url);
    const t = data.translation;
    if (!t) throw new Error(`${host} risposta vuota`);
    return t;
  };
}

// Ordine: prima i proxy Google (nessuna quota), poi MyMemory come rete di sicurezza.
const PROVIDERS = [
  { name: 'lingva.ml', fn: makeLingva('lingva.ml') },
  { name: 'lingva.garudalinux.org', fn: makeLingva('lingva.garudalinux.org') },
  { name: 'mymemory', fn: viaMyMemory },
];

/**
 * Traduce `text` provando i provider in ordine. Lancia solo se falliscono
 * tutti; l'errore riporta cosa ha detto ciascuno, per la diagnostica.
 */
async function translateText(text, source, target) {
  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const out = await p.fn(text, source, target);
      if (out && out.trim()) return out;
      errors.push(`${p.name}: vuoto`);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  throw new Error(`tutti i provider falliti [${errors.join(' | ')}]`);
}

module.exports = { translateText, translateViaMyMemory: viaMyMemory };
