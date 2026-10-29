"use strict";

/**
 * Lord's Predictions — Proxy de cuotas alternativas
 * =================================================
 *
 * Endpoint público (sin exponer la API key):
 *
 *   GET /api/odds?sport=NBA&date=20261028
 *   GET /api/odds?sport=MLB&date=20261028
 *   GET /api/odds?sport=NFL&date=20261028
 *
 * Alias retrocompatible: GET /api/odds/spreads (acepta ?deporte=NBA y las
 * mismas variantes). También acepta ?nba / ?mlb / ?nfl (sin valor) y el nombre
 * interno del proveedor (basketball_nba / baseball_mlb / americanfootball_nfl).
 * ?refresh=1 ignora la caché.
 *
 * Respuesta:
 * {
 *   sport, date, provider, fetchedAt, cached, partial,
 *   requestsRemaining,
 *   games: [{
 *     sportId, idExterno, homeAbbr, awayAbbr, homeTeam, awayTeam, commenceTime,
 *     mainSpread: { spread, homePrice, awayPrice } | null,
 *     mainTotal:  { total, overPrice, underPrice } | null,
 *     altSpreads: [{ spread, homePrice, awayPrice }],
 *     altTotals:  [{ total, overPrice, underPrice }],
 *     // Campos legacy: todas las líneas combinadas, con la casa de cada cuota.
 *     spreads: [{ spread, homePrice, awayPrice, homeBook, awayBook }],
 *     totals:  [{ total, overPrice, underPrice, overBook, underBook }]
 *   }]
 * }
 *
 * `mainSpread` / `mainTotal` se eligen del mercado principal (medianas de las
 * líneas publicadas) y se excluyen de `altSpreads` / `altTotals`. El spread se
 * devuelve desde la perspectiva del equipo local (home). Si el proveedor no
 * publica mercados "alternate_*", se derivan las alternativas de las líneas
 * restantes para que el frontend conserve el indicador visual.
 *
 * Si un partido no se puede mapear con seguridad a abreviaturas ESPN,
 * se omite: el frontend lo deja sin odds alternativas.
 *
 * ---------------------------------------------------------------------
 * Variables de entorno
 * ---------------------------------------------------------------------
 * ODDS_API_KEY       (obligatoria) key de The Odds API. Nunca llega al frontend.
 * ODDS_API_BASE_URL  (opcional) base del proveedor; por defecto
 *                    https://api.the-odds-api.com/v4. Útil para tests/mock.
 * PORT               (opcional) puerto HTTP; por defecto 8787.
 * ODDS_REGIONS       (opcional) regiones; por defecto "us".
 * ODDS_MARKETS       (opcional) mercados separados por coma. Por defecto
 *                    "spreads,totals,alternate_spreads,alternate_totals".
 *                    Cada mercado extra consume créditos del proveedor.
 * ODDS_CACHE_TTL_MS  (opcional) TTL de caché en memoria; por defecto 5 min.
 * ODDS_FETCH_TIMEOUT_MS (opcional) timeout por llamada; por defecto 15 s.
 * ODDS_MAX_EVENTS    (opcional) máximo de eventos a consultar por fecha; 20.
 * ODDS_EVENT_CONCURRENCY (opcional) llamadas simultáneas por evento; 4.
 * CORS_ORIGIN        (opcional) "*" o lista separada por comas.
 *
 * ---------------------------------------------------------------------
 * Despliegue
 * ---------------------------------------------------------------------
 * Render / Railway / Fly: `npm install && npm start` con las variables de
 * entorno configuradas en el panel. No usa filesystem ni estado local fuera
 * de memoria, así que también funciona en contenedores efímeros.
 *
 * Vercel: el archivo exporta la app Express (`module.exports = app`). Para
 * usarlo como función serverless, monta ese export en `api/index.js` y
 * redirige /api/* hacia ella. La caché es por instancia (se pierde en cold
 * starts), lo cual es aceptable para este endpoint.
 *
 * ---------------------------------------------------------------------
 * Nota sobre créditos de The Odds API
 * ---------------------------------------------------------------------
 * El listado de eventos (/sports/{sport}/events) no consume cuota. Las líneas
 * alternativas solo están disponibles en el endpoint por evento:
 * /sports/{sport}/events/{eventId}/odds, y cuestan
 * (nº de mercados únicos) × (nº de regiones) por evento. Con 4 mercados y
 * 1 región, 12 partidos = 48 créditos por refresco (la caché evita repetirlo).
 * Ajusta ODDS_MARKETS / ODDS_MAX_EVENTS según tu plan.
 */

require("dotenv").config();

const path = require("node:path");
const express = require("express");
const cors = require("cors");

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const PROVIDER_BASE_URL = (
  process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4"
).replace(/\/+$/, "");
const API_KEY = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "";
const PORT = Number(process.env.PORT) || 8787;
const REGIONS = process.env.ODDS_REGIONS || "us";
const MARKET_LIST = (process.env.ODDS_MARKETS || "spreads,totals,alternate_spreads,alternate_totals")
  .split(",")
  .map(m => m.trim())
  .filter(Boolean);
const MARKETS = MARKET_LIST.join(",");
const CACHE_TTL_MS = Number(process.env.ODDS_CACHE_TTL_MS) || 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.ODDS_FETCH_TIMEOUT_MS) || 15000;
const MAX_EVENTS = Number(process.env.ODDS_MAX_EVENTS) || 20;
const EVENT_CONCURRENCY = Number(process.env.ODDS_EVENT_CONCURRENCY) || 4;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const SPORT_KEYS = Object.freeze({
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
  NFL: "americanfootball_nfl"
});

const SPREAD_MARKET_KEYS = new Set(["spreads", "alternate_spreads"]);
const TOTAL_MARKET_KEYS = new Set(["totals", "alternate_totals"]);

// ---------------------------------------------------------------------------
// Abreviaturas ESPN por nombre completo del proveedor
// ---------------------------------------------------------------------------
// The Odds API entrega nombres completos ("Boston Celtics"). El frontend
// empareja con las abreviaturas de ESPN, así que el proxy traduce aquí.
// Se aceptan también alias históricos para no perder partidos.

const TEAM_ABBREVIATIONS = Object.freeze({
  NBA: {
    "atlanta hawks": "ATL",
    "boston celtics": "BOS",
    "brooklyn nets": "BKN",
    "charlotte hornets": "CHA",
    "chicago bulls": "CHI",
    "cleveland cavaliers": "CLE",
    "dallas mavericks": "DAL",
    "denver nuggets": "DEN",
    "detroit pistons": "DET",
    "golden state warriors": "GS",
    "houston rockets": "HOU",
    "indiana pacers": "IND",
    "la clippers": "LAC",
    "los angeles clippers": "LAC",
    "los angeles lakers": "LAL",
    "memphis grizzlies": "MEM",
    "miami heat": "MIA",
    "milwaukee bucks": "MIL",
    "minnesota timberwolves": "MIN",
    "new orleans pelicans": "NO",
    "new york knicks": "NY",
    "oklahoma city thunder": "OKC",
    "orlando magic": "ORL",
    "philadelphia 76ers": "PHI",
    "phoenix suns": "PHX",
    "portland trail blazers": "POR",
    "sacramento kings": "SAC",
    "san antonio spurs": "SA",
    "toronto raptors": "TOR",
    "utah jazz": "UTAH",
    "washington wizards": "WSH"
  },
  MLB: {
    "arizona diamondbacks": "AZ",
    "athletics": "ATH",
    "oakland athletics": "ATH",
    "atlanta braves": "ATL",
    "baltimore orioles": "BAL",
    "boston red sox": "BOS",
    "chicago cubs": "CHC",
    "chicago white sox": "CWS",
    "cincinnati reds": "CIN",
    "cleveland guardians": "CLE",
    "colorado rockies": "COL",
    "detroit tigers": "DET",
    "houston astros": "HOU",
    "kansas city royals": "KC",
    "los angeles angels": "LAA",
    "anaheim angels": "LAA",
    "los angeles dodgers": "LAD",
    "miami marlins": "MIA",
    "milwaukee brewers": "MIL",
    "minnesota twins": "MIN",
    "new york mets": "NYM",
    "new york yankees": "NYY",
    "philadelphia phillies": "PHI",
    "pittsburgh pirates": "PIT",
    "san diego padres": "SD",
    "san francisco giants": "SF",
    "seattle mariners": "SEA",
    "st louis cardinals": "STL",
    "tampa bay rays": "TB",
    "texas rangers": "TEX",
    "toronto blue jays": "TOR",
    "washington nationals": "WSH"
  },
  NFL: {
    "arizona cardinals": "ARI",
    "atlanta falcons": "ATL",
    "baltimore ravens": "BAL",
    "buffalo bills": "BUF",
    "carolina panthers": "CAR",
    "chicago bears": "CHI",
    "cincinnati bengals": "CIN",
    "cleveland browns": "CLE",
    "dallas cowboys": "DAL",
    "denver broncos": "DEN",
    "detroit lions": "DET",
    "green bay packers": "GB",
    "houston texans": "HOU",
    "indianapolis colts": "IND",
    "jacksonville jaguars": "JAX",
    "kansas city chiefs": "KC",
    "las vegas raiders": "LV",
    "oakland raiders": "LV",
    "los angeles chargers": "LAC",
    "san diego chargers": "LAC",
    "los angeles rams": "LAR",
    "st louis rams": "LAR",
    "miami dolphins": "MIA",
    "minnesota vikings": "MIN",
    "new england patriots": "NE",
    "new orleans saints": "NO",
    "new york giants": "NYG",
    "new york jets": "NYJ",
    "philadelphia eagles": "PHI",
    "pittsburgh steelers": "PIT",
    "seattle seahawks": "SEA",
    "san francisco 49ers": "SF",
    "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN",
    "washington commanders": "WSH",
    "washington football team": "WSH"
  }
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTeamAbbr(sportId, teamName) {
  return TEAM_ABBREVIATIONS[sportId]?.[normalizeName(teamName)] || null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundLine(value) {
  return Math.round(value * 100) / 100;
}

function headerNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function getNewYorkDateKey(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const parts = NEW_YORK_DATE_FORMATTER.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}${values.month}${values.day}`;
}

function resolveSportId(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (SPORT_KEYS[upper]) return upper;
  const lower = value.toLowerCase();
  for (const [id, key] of Object.entries(SPORT_KEYS)) {
    if (key === lower) return id;
  }
  return null;
}

function mapWithConcurrency(items, limit, mapper) {
  if (!items.length) return Promise.resolve([]);
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }
  );
  return Promise.all(workers).then(() => results);
}

// ---------------------------------------------------------------------------
// Proveedor externo
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const err = new Error(body?.message || body?.error || `HTTP ${res.status}`);
      err.upstreamStatus = res.status;
      err.upstream = true;
      throw err;
    }
    return { body, headers: res.headers };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEvents(sportKey) {
  const url = `${PROVIDER_BASE_URL}/sports/${sportKey}/events?apiKey=${encodeURIComponent(API_KEY)}`;
  const { body } = await fetchJson(url);
  return Array.isArray(body) ? body : [];
}

async function fetchEventOdds(sportKey, eventId) {
  const url = new URL(`${PROVIDER_BASE_URL}/sports/${sportKey}/events/${encodeURIComponent(eventId)}/odds`);
  url.searchParams.set("apiKey", API_KEY);
  url.searchParams.set("regions", REGIONS);
  url.searchParams.set("markets", MARKETS);
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");
  const { body, headers } = await fetchJson(url.toString());
  return {
    event: body && typeof body === "object" ? body : null,
    requestsRemaining: headerNumber(headers.get("x-requests-remaining"))
  };
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

function mergeQuote(existing, price, book) {
  const value = toNumber(price);
  if (value == null) return existing;
  if (!existing || value > existing.price) return { price: value, book };
  return existing;
}

function addSpreadLine(map, pair, book) {
  const spread = toNumber(pair.spread);
  if (spread == null) return;
  const key = roundLine(spread).toFixed(2);
  const entry = map.get(key) || { spread: roundLine(spread), home: null, away: null };
  entry.home = mergeQuote(entry.home, pair.homePrice, book);
  entry.away = mergeQuote(entry.away, pair.awayPrice, book);
  map.set(key, entry);
}

function addTotalLine(map, pair, book) {
  const total = toNumber(pair.total);
  if (total == null) return;
  const key = roundLine(total).toFixed(2);
  const entry = map.get(key) || { total: roundLine(total), over: null, under: null };
  entry.over = mergeQuote(entry.over, pair.overPrice, book);
  entry.under = mergeQuote(entry.under, pair.underPrice, book);
  map.set(key, entry);
}

function finalizeSpreads(map) {
  return [...map.values()]
    .filter(entry => entry.home && entry.away)
    .map(entry => ({
      spread: entry.spread,
      homePrice: Math.round(entry.home.price),
      awayPrice: Math.round(entry.away.price),
      homeBook: entry.home.book || null,
      awayBook: entry.away.book || null
    }))
    .sort((a, b) => a.spread - b.spread);
}

function finalizeTotals(map) {
  return [...map.values()]
    .filter(entry => entry.over && entry.under)
    .map(entry => ({
      total: entry.total,
      overPrice: Math.round(entry.over.price),
      underPrice: Math.round(entry.under.price),
      overBook: entry.over.book || null,
      underBook: entry.under.book || null
    }))
    .sort((a, b) => a.total - b.total);
}

function pickMedianLine(lines, field) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const sorted = lines.slice().sort((a, b) => a[field] - b[field]);
  return sorted[Math.floor((sorted.length - 1) / 2)] || null;
}

function toSpreadQuote(line) {
  if (!line) return null;
  return {
    spread: line.spread,
    homePrice: line.homePrice,
    awayPrice: line.awayPrice
  };
}

function toTotalQuote(line) {
  if (!line) return null;
  return {
    total: line.total,
    overPrice: line.overPrice,
    underPrice: line.underPrice
  };
}

function sameLine(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
}

function extractSpreadPairs(market, homeTeam, awayTeam) {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
  const homeOutcomes = outcomes.filter(outcome => normalizeName(outcome.name) === normalizeName(homeTeam));
  const awayOutcomes = outcomes.filter(outcome => normalizeName(outcome.name) === normalizeName(awayTeam));
  const pairs = [];
  for (const home of homeOutcomes) {
    const homePoint = toNumber(home.point);
    if (homePoint == null) continue;
    const away = awayOutcomes.find(outcome => {
      const awayPoint = toNumber(outcome.point);
      return awayPoint != null && Math.abs(awayPoint + homePoint) < 0.001;
    });
    if (!away) continue;
    pairs.push({
      spread: homePoint,
      homePrice: home.price,
      awayPrice: away.price
    });
  }
  return pairs;
}

function extractTotalPairs(market) {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
  const overs = outcomes.filter(outcome => normalizeName(outcome.name).startsWith("over"));
  const unders = outcomes.filter(outcome => normalizeName(outcome.name).startsWith("under"));
  const pairs = [];
  for (const over of overs) {
    const total = toNumber(over.point);
    if (total == null) continue;
    const under = unders.find(outcome => {
      const underPoint = toNumber(outcome.point);
      return underPoint != null && Math.abs(underPoint - total) < 0.001;
    });
    if (!under) continue;
    pairs.push({ total, overPrice: over.price, underPrice: under.price });
  }
  return pairs;
}

function normalizeEventOdds(sportId, event, oddsEvent) {
  const homeTeam = oddsEvent?.home_team || event?.home_team || "";
  const awayTeam = oddsEvent?.away_team || event?.away_team || "";
  const homeAbbr = getTeamAbbr(sportId, homeTeam);
  const awayAbbr = getTeamAbbr(sportId, awayTeam);
  if (!homeAbbr || !awayAbbr) return null;

  const spreadMap = new Map();
  const totalMap = new Map();
  const mainSpreadMap = new Map();
  const mainTotalMap = new Map();
  const altSpreadMap = new Map();
  const altTotalMap = new Map();
  const bookmakers = Array.isArray(oddsEvent?.bookmakers) ? oddsEvent.bookmakers : [];

  for (const bookmaker of bookmakers) {
    const book = bookmaker?.title || bookmaker?.key || "Casa";
    const markets = Array.isArray(bookmaker?.markets) ? bookmaker.markets : [];
    for (const market of markets) {
      const marketKey = market?.key;
      if (SPREAD_MARKET_KEYS.has(marketKey)) {
        const targetMap = marketKey === "alternate_spreads" ? altSpreadMap : mainSpreadMap;
        for (const pair of extractSpreadPairs(market, homeTeam, awayTeam)) {
          addSpreadLine(spreadMap, pair, book);
          addSpreadLine(targetMap, pair, book);
        }
      } else if (TOTAL_MARKET_KEYS.has(marketKey)) {
        const targetMap = marketKey === "alternate_totals" ? altTotalMap : mainTotalMap;
        for (const pair of extractTotalPairs(market)) {
          addTotalLine(totalMap, pair, book);
          addTotalLine(targetMap, pair, book);
        }
      }
    }
  }

  const spreads = finalizeSpreads(spreadMap);
  const totals = finalizeTotals(totalMap);
  if (!spreads.length && !totals.length) return null;

  const mainSpreads = finalizeSpreads(mainSpreadMap);
  const mainTotals = finalizeTotals(mainTotalMap);
  const mainSpread = pickMedianLine(mainSpreads, "spread") || pickMedianLine(spreads, "spread");
  const mainTotal = pickMedianLine(mainTotals, "total") || pickMedianLine(totals, "total");

  // Las alternativas excluyen la línea principal. Si el proveedor no expone
  // alternate_spreads/alternate_totals, se derivan de las líneas restantes.
  let altSpreads = finalizeSpreads(altSpreadMap)
    .filter(line => !mainSpread || !sameLine(line.spread, mainSpread.spread));
  let altTotals = finalizeTotals(altTotalMap)
    .filter(line => !mainTotal || !sameLine(line.total, mainTotal.total));

  if (!altSpreads.length) {
    altSpreads = spreads.filter(line => !mainSpread || !sameLine(line.spread, mainSpread.spread));
  }
  if (!altTotals.length) {
    altTotals = totals.filter(line => !mainTotal || !sameLine(line.total, mainTotal.total));
  }

  return {
    sportId,
    idExterno: event?.id || oddsEvent?.id || null,
    homeAbbr,
    awayAbbr,
    homeTeam,
    awayTeam,
    commenceTime: event?.commence_time || oddsEvent?.commence_time || null,
    mainSpread: toSpreadQuote(mainSpread),
    mainTotal: toTotalQuote(mainTotal),
    altSpreads: altSpreads.map(toSpreadQuote),
    altTotals: altTotals.map(toTotalQuote),
    spreads,
    totals
  };
}

function filterEventsByDate(events, dateKey) {
  if (!dateKey) return events;
  return events.filter(event => getNewYorkDateKey(event?.commence_time) === dateKey);
}

// ---------------------------------------------------------------------------
// Construcción de payload y caché
// ---------------------------------------------------------------------------

async function buildOddsPayload(sportId, dateKey) {
  const sportKey = SPORT_KEYS[sportId];
  const allEvents = await fetchEvents(sportKey);
  const events = filterEventsByDate(allEvents, dateKey)
    .slice()
    .sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime())
    .slice(0, MAX_EVENTS);

  const results = await mapWithConcurrency(events, EVENT_CONCURRENCY, async event => {
    try {
      const odds = await fetchEventOdds(sportKey, event.id);
      return { ok: true, event, odds };
    } catch (err) {
      return {
        ok: false,
        event,
        message: err?.message || "error desconocido",
        status: err?.upstreamStatus || null
      };
    }
  });

  const games = [];
  const errors = [];
  let skippedUnmapped = 0;
  let requestsRemaining = null;

  for (const result of results) {
    if (!result.ok) {
      errors.push({ eventId: result.event?.id || null, message: result.message, status: result.status });
      continue;
    }
    if (result.odds.requestsRemaining != null) {
      requestsRemaining = result.odds.requestsRemaining;
    }
    const normalized = normalizeEventOdds(sportId, result.event, result.odds.event);
    if (normalized) games.push(normalized);
    else skippedUnmapped++;
  }

  if (results.length > 0 && games.length === 0 && errors.length === results.length) {
    const first = errors[0];
    const err = new Error(first.message || "El proveedor no devolvió cuotas.");
    err.upstream = true;
    err.status = 502;
    throw err;
  }

  if (errors.length) {
    console.warn(
      `[odds-proxy] ${sportId} ${dateKey}: ${errors.length}/${results.length} eventos fallaron.`,
      errors.slice(0, 2).map(e => `${e.eventId || "?"}: ${e.message}`)
    );
  }
  if (skippedUnmapped) {
    console.warn(`[odds-proxy] ${sportId} ${dateKey}: ${skippedUnmapped} eventos sin abreviaturas ESPN.`);
  }

  return {
    sport: sportId,
    date: dateKey || null,
    provider: "the-odds-api",
    fetchedAt: new Date().toISOString(),
    cached: false,
    partial: errors.length > 0 && games.length > 0,
    requestsRemaining,
    upstream: {
      events: allEvents.length,
      eventsForDate: events.length,
      eventsRequested: results.length,
      eventsWithMarkets: games.length,
      failedEvents: errors.length,
      unmappedEvents: skippedUnmapped
    },
    games
  };
}

const cache = new Map();
const inFlight = new Map();

function getCacheKey(sportKey, dateKey) {
  return `${sportKey}:${dateKey || "all"}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > 50) {
    cache.delete(cache.keys().next().value);
  }
}

async function getOddsPayload(sportId, dateKey, options = {}) {
  const { force = false } = options;
  const cacheKey = getCacheKey(SPORT_KEYS[sportId], dateKey);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (!force && cached && cached.expiresAt > now) {
    return { ...cached.payload, cached: true };
  }
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = (async () => {
    const payload = await buildOddsPayload(sportId, dateKey);
    const expiresAt = Date.now() + CACHE_TTL_MS;
    const stored = { ...payload, expiresAt: new Date(expiresAt).toISOString() };
    cache.set(cacheKey, { payload: stored, expiresAt });
    pruneCache();
    return stored;
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

// ---------------------------------------------------------------------------
// App Express
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

const allowedOrigins = CORS_ORIGIN.split(",").map(origin => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.includes("*") ? "*" : allowedOrigins }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    provider: "the-odds-api",
    configured: Boolean(API_KEY),
    markets: MARKET_LIST,
    regions: REGIONS,
    cacheEntries: cache.size
  });
});

async function handleOddsRequest(req, res) {
  try {
    const rawSport = req.query.sport ?? req.query.deporte ??
      (req.query.nba !== undefined ? "NBA" :
        req.query.mlb !== undefined ? "MLB" :
        req.query.nfl !== undefined ? "NFL" : "");
    const sportId = resolveSportId(rawSport);
    if (!sportId) {
      return res.status(400).json({
        error: "Parámetro 'sport' inválido. Usa NBA, MLB o NFL.",
        code: "INVALID_SPORT"
      });
    }

    const dateKey = String(req.query.date ?? "").trim();
    if (dateKey && !/^\d{8}$/.test(dateKey)) {
      return res.status(400).json({
        error: "Parámetro 'date' inválido. Formato esperado: YYYYMMDD.",
        code: "INVALID_DATE"
      });
    }

    if (!API_KEY) {
      return res.status(503).json({
        error: "ODDS_API_KEY no está configurada en el servidor.",
        code: "MISSING_API_KEY"
      });
    }

    const force = String(req.query.refresh ?? "") === "1";
    const payload = await getOddsPayload(sportId, dateKey, { force });
    res.set("Cache-Control", payload.cached ? "private, max-age=60" : "no-store");
    res.json(payload);
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    const status = timedOut ? 504 : 502;
    const message = timedOut
      ? "El proveedor de cuotas agotó el tiempo de espera."
      : `No se pudieron obtener las cuotas: ${err?.message || "error desconocido"}`;
    console.error(`[odds-proxy] ${message}`);
    res.status(status).json({ error: message, code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR" });
  }
}

app.get(["/api/odds", "/api/odds/spreads"], handleOddsRequest);

// Servir el frontend desde el mismo origen facilita el uso local:
// http://localhost:8787/index.html llama a /api/odds sin CORS.
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada.", code: "NOT_FOUND" });
});

app.use((err, req, res, next) => {
  console.error("[odds-proxy] error interno:", err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Error interno del proxy.", code: "INTERNAL_ERROR" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[odds-proxy] escuchando en http://localhost:${PORT}`);
    console.log(`[odds-proxy] proveedor: ${PROVIDER_BASE_URL}`);
    console.log(`[odds-proxy] mercados: ${MARKETS} · regiones: ${REGIONS} · TTL: ${CACHE_TTL_MS} ms`);
    if (!API_KEY) {
      console.warn("[odds-proxy] falta ODDS_API_KEY; /api/odds responderá 503.");
    }
  });
}

module.exports = app;
