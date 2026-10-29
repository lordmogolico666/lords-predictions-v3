/**
 * Lord's Predictions — utils.js
 * Helpers puros: formato, fechas, RNG, odds/Kelly, concurrencia y utilidades varias.
 * No debe acceder al DOM.
 */
"use strict";


    // Utils básicos
    function escapeHTML(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
    function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

    // Semáforo para acotar llamadas concurrentes (enrichment, etc.).
    function createConcurrencyLimiter(maxConcurrent) {
      const limit = Math.max(1, Number(maxConcurrent) || 1);
      let active = 0;
      const queue = [];
      const next = () => {
        if (active >= limit || queue.length === 0) return;
        active++;
        const { task, resolve, reject } = queue.shift();
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      return (task) => new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
      });
    }

    // Ejecuta el mapper con concurrencia acotada y conserva el orden de salida.
    async function mapWithConcurrency(items, limit, mapper) {
      const list = Array.isArray(items) ? items : [];
      const results = new Array(list.length);
      const run = createConcurrencyLimiter(limit);
      await Promise.all(list.map((item, index) => run(async () => {
        results[index] = await mapper(item, index);
      })));
      return results;
    }

    function toNumber(value, fallback = null) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
    function formatNumber(value, digits = 1) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      return n.toFixed(digits);
    }
    function formatPercentage(dec, digits = 1) {
      const n = Number(dec);
      if (!Number.isFinite(n)) return "—";
      return `${(n * 100).toFixed(digits)}%`;
    }
    function formatSpread(spread) {
      const n = Number(spread);
      if (!Number.isFinite(n)) return "—";
      if (Math.abs(n) < 0.05) return "PK";
      return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
    }
    function parseRecord(str) {
      const m = String(str ?? "").match(/(\d+)\s*-\s*(\d+)/);
      if (!m) return { wins: 0, losses: 0, games: 0, winPercentage: 0.5 };
      const wins = Number(m[1]);
      const losses = Number(m[2]);
      const games = wins + losses;
      return { wins, losses, games, winPercentage: games > 0 ? wins / games : 0.5 };
    }

    // RNG
    function hashString(str) {
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }
    function createPRNG(seed) {
      let x = seed >>> 0;
      return function random() {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 4294967296;
      };
    }
    function randomNormal(rng) {
      let u1 = rng(), u2 = rng();
      while (u1 <= Number.EPSILON) u1 = rng();
      while (u2 <= Number.EPSILON) u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    // Poisson para MLB discreto
    function samplePoisson(lambda, rng) {
      const L = Math.exp(-lambda);
      let p = 1, k = 0;
      do {
        k++;
        p *= rng();
      } while (p > L && k < 30);
      return k - 1;
    }

    // Kelly y cuotas
    function americanOddsToProfitMultiplier(price) {
      const odds = Number(price);
      if (!Number.isFinite(odds) || odds === 0) return 100 / 110;
      return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    }
    function calculateKelly(probability, price) {
      const p = clamp(Number(probability), 0, 1);
      const q = 1 - p;
      const b = americanOddsToProfitMultiplier(price);
      const fullKelly = (b * p - q) / b;
      const fractional = Math.max(0, fullKelly) * GLOBAL_CONFIG.KELLY_FRACTION * 100;
      return Math.max(0, fractional);
    }

    // Probabilidad implícita (para no-vig)
    function americanOddsToProb(odds) {
      const o = Number(odds);
      if (!Number.isFinite(o) || o === 0) return null;
      if (o > 0) return 100 / (o + 100);
      return Math.abs(o) / (Math.abs(o) + 100);
    }

    function removeVigTwoWay(homePrice, awayPrice) {
      const ph = americanOddsToProb(homePrice);
      const pa = americanOddsToProb(awayPrice);
      if (ph == null || pa == null) return { homeNoVig: null, awayNoVig: null };
      const sum = ph + pa;
      if (sum <= 0) return { homeNoVig: null, awayNoVig: null };
      return {
        homeNoVig: ph / sum,
        awayNoVig: pa / sum
      };
    }

    // EV en unidades (riesgo 1)
    function calculateEVUnits(probability, price) {
      const p = clamp(Number(probability), 0, 1);
      const q = 1 - p;
      const o = Number(price);
      if (!Number.isFinite(o) || o === 0) return 0;
      let profit = 0;
      if (o > 0) profit = o / 100;
      else profit = 100 / Math.abs(o);
      return p * profit - q * 1;
    }

    // Unidades de una apuesta del cuaderno según resultado y cuota americana.
    function calculateBetUnits(result, stake, price) {
      const s = Number(stake);
      const o = Number(price);
      if (!Number.isFinite(s) || s <= 0) return 0;
      if (result === "WIN") {
        if (!Number.isFinite(o) || o === 0) return 0;
        return o > 0 ? (o / 100) * s : (100 / Math.abs(o)) * s;
      }
      if (result === "LOSS") return -s;
      return 0;
    }

    function americanOddsToDecimal(price) {
      const o = Number(price);
      if (!Number.isFinite(o) || o === 0) return null;
      return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    }

    // Modo bankroll: stake recomendado
    function recommendedStakeUnits(kellyPct, bankroll, maxStakePct) {
      const k = Math.max(0, Number(kellyPct) || 0);
      const br = Math.max(0, Number(bankroll) || 0);
      const maxPct = Math.max(0, Number(maxStakePct) || 0);
      if (br <= 0 || k <= 0) return 0;
      const rawStake = (k / 100) * br;
      const maxStake = (maxPct / 100) * br;
      return Math.min(rawStake, maxStake);
    }
    function computeStakePlan(games) {
      const bankroll = Math.max(0, Number(state.bankroll) || 0);
      const cap = bankroll * Math.max(0, Number(state.maxDailyRiskPct) || 0) / 100;
      const entries = (games || [])
        .filter(g => g.qualified && g.bettingOpen !== false && g.recommendedTeam)
        .map(g => ({
          game: g,
          raw: recommendedStakeUnits(g.kelly ?? 0, bankroll, state.maxStakePerBetPct),
          ev: g.evUnits ?? 0
        }));
      const rawTotal = entries.reduce((sum, e) => sum + e.raw, 0);
      const scale = rawTotal > cap && rawTotal > 0 ? cap / rawTotal : 1;
      const byGame = new Map();
      let total = 0;
      for (const e of entries) {
        const stake = Math.floor(e.raw * scale * 100) / 100;
        byGame.set(e.game.id, stake);
        total += stake;
      }
      return {
        byGame,
        rawTotal,
        total,
        cap,
        scale,
        count: entries.length,
        remaining: Math.max(0, cap - total),
        exceeded: rawTotal > cap
      };
    }
    function plannedStakeFor(game, rawStake) {
      const planned = state.stakePlan?.byGame?.get(game.id);
      return Number.isFinite(planned) ? planned : rawStake;
    }
    function formatSignedPctPoints(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      return `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)} pts`;
    }

    // Fechas
    function getNewYorkDateKey(offset = 0) {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit"
      });
      const parts = Object.fromEntries(
        fmt.formatToParts(new Date())
          .filter(p => p.type !== "literal")
          .map(p => [p.type, p.value])
      );
      const base = new Date(Date.UTC(
        Number(parts.year), Number(parts.month) - 1,
        Number(parts.day) + offset, 12
      ));
      return [
        base.getUTCFullYear(),
        String(base.getUTCMonth() + 1).padStart(2, "0"),
        String(base.getUTCDate()).padStart(2, "0")
      ].join("");
    }
    function shiftDateKey(dateKey, days) {
      const y = Number(dateKey.slice(0, 4));
      const m = Number(dateKey.slice(4, 6));
      const d = Number(dateKey.slice(6, 8));
      const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
      return [
        dt.getUTCFullYear(),
        String(dt.getUTCMonth() + 1).padStart(2, "0"),
        String(dt.getUTCDate()).padStart(2, "0")
      ].join("");
    }
    function formatDateLabel(dateKey) {
      if (!dateKey) return "";
      const y = Number(dateKey.slice(0, 4));
      const m = Number(dateKey.slice(4, 6));
      const d = Number(dateKey.slice(6, 8));
      const dt = new Date(Date.UTC(y, m - 1, d, 12));
      return dt.toLocaleDateString("es-MX", {
        timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric"
      });
    }
    function formatGameTime(iso) {
      if (!iso) return "Horario pendiente";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "Horario pendiente";
      return d.toLocaleTimeString("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
      }) + " ET";
    }
    function formatUpdatedTime(date) {
      if (!date) return "Sin actualizar";
      return date.toLocaleTimeString("es-MX", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    }
    function formatAmericanPrice(price) {
      const n = Number(price);
      if (!Number.isFinite(n) || n === 0) return "—";
      return `${n > 0 ? "+" : ""}${n}`;
    }
    function normalizeBookKey(name) {
      return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    function formatLineImprovement(bestLine) {
      if (!bestLine) return "";
      if (bestLine.spreadDelta > 0.01) {
        return `${escapeHTML(bestLine.provider)} ${formatSpread(bestLine.pickSpread)} (${formatAmericanPrice(bestLine.price)}) · +${formatNumber(bestLine.spreadDelta, 1)} pts`;
      }
      if (bestLine.priceDelta > 0) {
        return `${escapeHTML(bestLine.provider)} ${formatAmericanPrice(bestLine.price)} vs ${formatAmericanPrice(bestLine.primaryPrice)}`;
      }
      return "";
    }

    // Nombres de equipos: aliases + similitud para cruzar casas
    const TEAM_NAME_ALIASES = Object.freeze({
      la: ["los", "angeles"],
      ny: ["new", "york"],
      gs: ["golden", "state"],
      sa: ["san", "antonio"],
      no: ["new", "orleans"],
      okc: ["oklahoma", "city"],
      phx: ["phoenix"],
      tb: ["tampa", "bay"],
      sf: ["san", "francisco"],
      kc: ["kansas", "city"],
      sd: ["san", "diego"],
      nj: ["new", "jersey"]
    });
    function teamNameTokens(name) {
      const normalized = String(name ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return [];
      const out = [];
      for (const token of normalized.split(" ")) {
        const alias = TEAM_NAME_ALIASES[token];
        if (alias) out.push(...alias);
        else out.push(token);
      }
      return out;
    }
    function teamsLikelyMatch(a, b) {
      const ta = teamNameTokens(a);
      const tb = teamNameTokens(b);
      if (!ta.length || !tb.length) return false;
      if (ta.slice(-2).join(" ") === tb.slice(-2).join(" ")) return true;
      const setB = new Set(tb);
      const shared = ta.filter(t => setB.has(t)).length;
      const union = new Set([...ta, ...tb]).size;
      return union > 0 && shared / union >= 0.6;
    }

    function getSportStdDev(sportId) {
      return SPORTS[sportId]?.stdDev || state.sport.stdDev || 1;
    }
