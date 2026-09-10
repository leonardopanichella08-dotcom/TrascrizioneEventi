'use strict';

/**
 * Proxy di traduzione lato server verso MyMemory (api.mymemory.translated.net),
 * un servizio pubblico e gratuito che non richiede API key per un uso normale.
 * Il proxy vive sul backend per due motivi:
 *   1) evitare CORS lato browser;
 *   2) poter sostituire il provider (DeepL/OpenAI/Google) in un solo punto,
 *      senza toccare il frontend.
 */

// MyMemory vuole alcuni codici lingua in formato esteso invece del semplice ISO 639-1.
const LANG_OVERRIDES = {
  zh: 'zh-CN',
};

function normalizeLang(code) {
  const clean = (code || '').trim();
  return LANG_OVERRIDES[clean] || clean;
}

/**
 * Traduce `text` da `source` a `target`. Lancia un errore descrittivo se il
 * servizio non e' raggiungibile o restituisce una risposta anomala (es. quota
 * giornaliera gratuita esaurita), cosi' il chiamante puo' decidere il fallback.
 */
async function translateViaMyMemory(text, source, target) {
  const langpair = `${normalizeLang(source)}|${normalizeLang(target)}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`MyMemory HTTP ${response.status}`);
  }

  const data = await response.json();

  // MyMemory risponde sempre con HTTP 200 anche in caso di errore applicativo
  // (es. quota esaurita): l'esito reale va letto da responseStatus.
  if (data.responseStatus && Number(data.responseStatus) !== 200) {
    throw new Error(data.responseDetails || 'MyMemory ha rifiutato la richiesta');
  }

  const translated = data.responseData?.translatedText;
  if (!translated) {
    throw new Error('Risposta di traduzione vuota');
  }
  return translated;
}

module.exports = { translateViaMyMemory };
