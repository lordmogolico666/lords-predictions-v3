/**
 * Lord's Predictions — api.js
 * Red: ESPN (scoreboard, standings, enriquecimiento), The Odds API y proxy de líneas alternativas.
 * Todas las peticiones de enriquecimiento pasan por un semáforo global y aceptan AbortSignal.
 */
"use strict";

    const enrichmentCaches = {
      nbaTeam: new Map(),
      nbaInjuries: new Map(),
      mlbPitcher: new Map(),
      mlbTeam: new Map(),
      mlbBullpen: new Map(),
      mlbTeamIds: new Map()
    };

    // Semáforo global para no saturar los endpoints de enriquecimiento.
    const enrichmentLimiter = createConcurrencyLimiter(ENRICHMENT_CONCURRENCY);
    const enrichmentFetchJSON = (url, signal) =>
      enrichmentLimiter(() => fetchJSON(url, { signal }));

    // Evita repetir el mismo warning en cada auto-refresh cuando no hay proxy.
    let altMarketsWarned = false;

    // Fetch
    // `signal` permite cancelar la carga completa (AbortController de loadGames).
    async function fetchJSON(url, options = {}) {
      const { signal: externalSignal = null, timeoutMs = GLOBAL_CONFIG.FETCH_TIMEOUT_MS } = options;
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timeout);
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
    async function fetchScoreboard(sportConfig, dateKey, signal = null) {
      return fetchJSON(`${sportConfig.scoreboardUrl}?dates=${dateKey}&limit=100`, { signal });
    }
    async function fetchStandings(sportConfig, season, signal = null) {
      if (!sportConfig.standingsUrl) return null;
      try {
        return await fetchJSON(`${sportConfig.standingsUrl}?season=${season}`, { signal });
      } catch (e) {
        console.warn("Standings failed, continuing without:", e);
        return null;
      }
    }

    // Enriquecimiento del modelo (ESPN team/player stats)
    function enrichmentGet(cache, key) {
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at > ENRICHMENT_CACHE_MS) {
        cache.delete(key);
        return null;
      }
      return entry.value;
    }
    function enrichmentSet(cache, key, value) {
      cache.set(key, { at: Date.now(), value });
      return value;
    }
    function readEnrichmentStat(stats, name) {
      if (!Array.isArray(stats)) return null;
      const stat = stats.find(s => s.name === name || s.displayName === name);
      return stat ? toNumber(stat.value, toNumber(stat.displayValue)) : null;
    }

    async function fetchNbaTeamEnrichment(team, standingsMap, season, signal = null) {
      const key = `${season}-${team.id}`;
      const cached = enrichmentGet(enrichmentCaches.nbaTeam, key);
      if (cached) return cached;
      try {
        const data = await enrichmentFetchJSON(
          `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/statistics?season=${season}&seasontype=2`,
          signal
        );
        const categories = data?.results?.stats?.categories || [];
        const flat = categories.flatMap(c => c.stats || []);
        const games = readEnrichmentStat(flat, "gamesPlayed");
        const fga = readEnrichmentStat(flat, "avgFieldGoalsAttempted");
        const fta = readEnrichmentStat(flat, "avgFreeThrowsAttempted");
        const oreb = readEnrichmentStat(flat, "avgOffensiveRebounds");
        const reb = readEnrichmentStat(flat, "avgRebounds");
        const drb = readEnrichmentStat(flat, "avgDefensiveRebounds");
        const tov = readEnrichmentStat(flat, "avgTurnovers");
        const fgm = readEnrichmentStat(flat, "avgFieldGoalsMade");
        const tpm = readEnrichmentStat(flat, "avgThreePointFieldGoalsMade");
        const threePctRaw = readEnrichmentStat(flat, "threePointPct");
        const ftPctRaw = readEnrichmentStat(flat, "freeThrowPct");
        const points = readEnrichmentStat(flat, "avgPoints");
        const possessions = [fga, fta, oreb, tov].every(Number.isFinite)
          ? fga + 0.44 * fta - oreb + tov
          : null;
        if (!Number.isFinite(games) || !Number.isFinite(possessions) || possessions <= 0) {
          return null;
        }
        const standing = standingsMap.get(String(team.id)) ||
                         standingsMap.get(String(team.abbreviation).toUpperCase()) || {};
        const pointsAgainst = Number.isFinite(standing.pointsAgainst) ? standing.pointsAgainst : null;
        const ortg = Number.isFinite(points) ? points / possessions * 100 : null;
        const drtg = Number.isFinite(pointsAgainst) ? pointsAgainst / possessions * 100 : null;
        const efg = Number.isFinite(fgm) && Number.isFinite(tpm) && fga > 0
          ? (fgm + 0.5 * tpm) / fga
          : null;
        const tovPct = tov != null ? tov / possessions : null;
        const orebRate = oreb != null && fga != null && fta != null && tov != null
          ? oreb / (fga + 0.44 * fta + tov)
          : null;
        const summary = {
          teamId: team.id,
          abbreviation: team.abbreviation,
          games,
          possessions,
          ortg,
          drtg,
          netRating: ortg != null && drtg != null ? ortg - drtg : null,
          efg,
          threePct: Number.isFinite(threePctRaw) ? threePctRaw / 100 : null,
          ftPct: Number.isFinite(ftPctRaw) ? ftPctRaw / 100 : null,
          tovPct,
          oreb,
          reb,
          drb,
          orebRate,
          pointsFor: points,
          pointsAgainst
        };
        return enrichmentSet(enrichmentCaches.nbaTeam, key, summary);
      } catch (e) {
        console.warn("NBA team stats failed:", team.abbreviation, e);
        return null;
      }
    }

    async function fetchNbaInjuries(teamId, signal = null) {
      const key = `injuries-${teamId}`;
      const cached = enrichmentGet(enrichmentCaches.nbaInjuries, key);
      if (cached) return cached;
      try {
        const list = await enrichmentFetchJSON(
          `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${teamId}/injuries`,
          signal
        );
        const items = (list?.items || []).slice(0, 6);
        const details = await Promise.allSettled(items.map(async item => {
          const ref = String(item?.$ref || "").replace("http://", "https://");
          if (!ref) return null;
          const injury = await enrichmentFetchJSON(ref, signal);
          return {
            status: injury?.status || "",
            comment: injury?.shortComment || injury?.longComment || "",
            athleteId: injury?.athlete?.["$ref"]?.split("/athletes/")[1]?.split("/")[0] || null
          };
        }));
        const out = details
          .filter(r => r.status === "fulfilled" && r.value)
          .map(r => r.value)
          .filter(d => /out|doubtful|day-to-day|questionable/i.test(d.status));
        return enrichmentSet(enrichmentCaches.nbaInjuries, key, out);
      } catch (e) {
        return [];
      }
    }

    async function fetchMlbPitcherEnrichment(athleteId, season, signal = null) {
      if (!athleteId) return null;
      const key = `${season}-${athleteId}`;
      const cached = enrichmentGet(enrichmentCaches.mlbPitcher, key);
      if (cached) return cached;
      try {
        const athleteRef = `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/athletes/${athleteId}`;
        const statUrls = [2, 3].map(type =>
          `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/seasons/${season}/types/${type}/athletes/${athleteId}/statistics`
        );
        const [athleteRes, ...statRes] = await Promise.allSettled([
          enrichmentFetchJSON(athleteRef, signal),
          ...statUrls.map(u => enrichmentFetchJSON(u, signal))
        ]);
        let stats = null;
        for (const r of statRes) {
          if (r.status !== "fulfilled" || !r.value) continue;
          let data = r.value;
          if (data["$ref"]) {
            try {
              data = await enrichmentFetchJSON(String(data["$ref"]).replace("http://", "https://"), signal);
            } catch {
              continue;
            }
          }
          const pitching = data?.splits?.categories?.find(c => c.name === "pitching")?.stats;
          if (pitching && (readEnrichmentStat(pitching, "innings") || 0) > 0) {
            stats = pitching;
            break;
          }
        }
        if (!stats) return null;
        const fullInnings = readEnrichmentStat(stats, "fullInnings");
        const partInnings = readEnrichmentStat(stats, "partInnings");
        const rawInnings = readEnrichmentStat(stats, "innings");
        const ip = Number.isFinite(fullInnings)
          ? fullInnings + (Number.isFinite(partInnings) ? partInnings / 3 : 0)
          : (Number.isFinite(rawInnings)
            ? Math.floor(rawInnings) + ((Math.round(rawInnings * 10) % 10) / 3)
            : null);
        const k = readEnrichmentStat(stats, "strikeouts") ?? 0;
        const bb = readEnrichmentStat(stats, "walks") ?? 0;
        const hbp = readEnrichmentStat(stats, "battersHit") ?? 0;
        const hr = readEnrichmentStat(stats, "homeRuns") ?? 0;
        const bf = readEnrichmentStat(stats, "battersFaced");
        const gb = readEnrichmentStat(stats, "groundBalls");
        const fb = readEnrichmentStat(stats, "flyBalls");
        const era = readEnrichmentStat(stats, "ERA");
        const whip = readEnrichmentStat(stats, "WHIP");
        const fip = Number.isFinite(ip) && ip > 0
          ? (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.15
          : null;
        const athlete = athleteRes.status === "fulfilled" ? athleteRes.value : null;
        const hand = athlete?.throws?.abbreviation || athlete?.hand?.abbreviation || null;
        const qualityRaw = Number.isFinite(era) || Number.isFinite(fip)
          ? ((MODEL_ENRICHMENT.MLB.leagueEra - (era ?? fip)) * 0.55 +
             (MODEL_ENRICHMENT.MLB.leagueFip - (fip ?? era)) * 0.45) * 0.6
          : 0;
        const sampleWeight = Number.isFinite(ip) ? clamp(ip / 80, 0.3, 1) : 0.3;
        const summary = {
          athleteId: String(athleteId),
          name: athlete?.displayName || `Pitcher ${athleteId}`,
          hand,
          ip,
          era,
          fip,
          whip,
          kPct: bf > 0 ? k / bf : null,
          bbPct: bf > 0 ? bb / bf : null,
          gbPct: Number.isFinite(gb) && Number.isFinite(fb) && gb + fb > 0 ? gb / (gb + fb) : null,
          quality: clamp(qualityRaw * sampleWeight, -2, 2)
        };
        return enrichmentSet(enrichmentCaches.mlbPitcher, key, summary);
      } catch (e) {
        console.warn("MLB pitcher stats failed:", athleteId, e);
        return null;
      }
    }

    async function fetchMlbTeamEnrichment(team, season, signal = null) {
      const key = `${season}-${team.id}`;
      const cached = enrichmentGet(enrichmentCaches.mlbTeam, key);
      if (cached) return cached;
      try {
        const [data, bullpen] = await Promise.all([
          enrichmentFetchJSON(
            `https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${team.id}/statistics?season=${season}&seasontype=2`,
            signal
          ),
          fetchMlbBullpenStats(team, season, signal)
        ]);
        const categories = data?.results?.stats?.categories || [];
        const batting = categories.find(c => c.name === "batting")?.stats || [];
        const pitching = categories.find(c => c.name === "pitching")?.stats || [];
        const games = readEnrichmentStat(batting, "teamGamesPlayed");
        const runs = readEnrichmentStat(batting, "runs");
        const runsAllowed = readEnrichmentStat(pitching, "runs");
        const era = readEnrichmentStat(pitching, "ERA");
        const whip = readEnrichmentStat(pitching, "WHIP");
        const ops = readEnrichmentStat(batting, "OPS");
        if (!Number.isFinite(games) || games <= 0) return null;
        const summary = {
          teamId: team.id,
          abbreviation: team.abbreviation,
          games,
          runsPerGame: Number.isFinite(runs) ? runs / games : null,
          runsAllowedPerGame: Number.isFinite(runsAllowed) ? runsAllowed / games : null,
          era,
          whip,
          ops,
          bullpen: bullpen || null
        };
        return enrichmentSet(enrichmentCaches.mlbTeam, key, summary);
      } catch (e) {
        console.warn("MLB team stats failed:", team.abbreviation, e);
        return null;
      }
    }

    async function fetchMlbTeamIdMap(signal = null) {
      const cached = enrichmentGet(enrichmentCaches.mlbTeamIds, "map");
      if (cached) return cached;
      const aliases = {
        CHW: "CWS", ARI: "AZ", SDP: "SD", SFG: "SF", TBR: "TB",
        KCR: "KC", WSN: "WSH", OAK: "ATH", FLA: "MIA"
      };
      const data = await enrichmentFetchJSON("https://statsapi.mlb.com/api/v1/teams?sportId=1", signal);
      const map = new Map();
      for (const team of data?.teams || []) {
        if (!team?.id) continue;
        if (team.abbreviation) {
          map.set(`abbr:${String(team.abbreviation).toUpperCase()}`, team.id);
          map.set(`abbr:${aliases[String(team.abbreviation).toUpperCase()] || String(team.abbreviation).toUpperCase()}`, team.id);
        }
        if (team.name) map.set(`name:${normalizeVenueKey(team.name)}`, team.id);
        if (team.shortName) map.set(`name:${normalizeVenueKey(team.shortName)}`, team.id);
      }
      for (const [alias, abbr] of Object.entries(aliases)) {
        const id = map.get(`abbr:${abbr}`);
        if (id) map.set(`abbr:${alias}`, id);
      }
      return enrichmentSet(enrichmentCaches.mlbTeamIds, "map", map);
    }

    async function fetchMlbBullpenStats(team, season, signal = null) {
      const key = `${season}-${team.id}`;
      const cached = enrichmentGet(enrichmentCaches.mlbBullpen, key);
      if (cached) return cached;
      try {
        const idMap = await fetchMlbTeamIdMap(signal);
        const mlbId = idMap.get(`abbr:${String(team.abbreviation || "").toUpperCase()}`) ||
                      idMap.get(`name:${normalizeVenueKey(team.name)}`) ||
                      idMap.get(`name:${normalizeVenueKey(team.displayName)}`) ||
                      null;
        if (!mlbId) return null;
        const data = await enrichmentFetchJSON(
          `https://statsapi.mlb.com/api/v1/teams/${mlbId}/stats?stats=statSplits&group=pitching&sitCodes=rp&season=${season}`,
          signal
        );
        const stat = data?.stats?.[0]?.splits?.[0]?.stat;
        if (!stat) return null;
        const era = toNumber(stat.era);
        const whip = toNumber(stat.whip);
        const ipRaw = toNumber(stat.inningsPitched);
        const ip = Number.isFinite(ipRaw)
          ? Math.floor(ipRaw) + ((Math.round(ipRaw * 10) % 10) / 3)
          : null;
        const k = toNumber(stat.strikeOuts) ?? 0;
        const bb = toNumber(stat.baseOnBalls) ?? 0;
        const hbp = toNumber(stat.hitByPitch) ?? 0;
        const hr = toNumber(stat.homeRuns) ?? 0;
        const bf = toNumber(stat.battersFaced);
        const fip = Number.isFinite(ip) && ip > 0
          ? (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.15
          : null;
        const summary = {
          era,
          fip,
          whip,
          ip,
          kPct: bf > 0 ? k / bf : null,
          bbPct: bf > 0 ? bb / bf : null,
          quality: era != null ? clamp((MODEL_ENRICHMENT.MLB.leagueEra - era) * 0.5, -1.5, 1.5) : 0
        };
        return enrichmentSet(enrichmentCaches.mlbBullpen, key, summary);
      } catch (e) {
        console.warn("MLB bullpen stats failed:", team.abbreviation, e);
        return null;
      }
    }

    function normalizeVenueKey(value) {
      return String(value || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
    }

    async function fetchMlbWeather(dateKey, signal = null) {
      const key = `weather-${dateKey}`;
      const cached = enrichmentGet(enrichmentCaches.mlbTeam, key);
      if (cached) return cached;
      try {
        const isoDate = `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
        const data = await enrichmentFetchJSON(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${isoDate}&hydrate=weather,venue`,
          signal
        );
        const map = new Map();
        for (const date of data?.dates || []) {
          for (const game of date.games || []) {
            const away = game?.teams?.away?.team?.name;
            const home = game?.teams?.home?.team?.name;
            if (!away || !home) continue;
            const mapKey = `${normalizeVenueKey(away)}@${normalizeVenueKey(home)}`;
            map.set(mapKey, {
              condition: game.weather?.condition || "",
              temp: toNumber(game.weather?.temp),
              wind: game.weather?.wind || "",
              venue: game.venue?.name || ""
            });
          }
        }
        return enrichmentSet(enrichmentCaches.mlbTeam, key, map);
      } catch (e) {
        console.warn("MLB weather failed:", e);
        return new Map();
      }
    }
    function computeWeatherFactor(weather) {
      if (!weather || !Number.isFinite(weather.temp)) return 1;
      const wind = String(weather.wind || "").toLowerCase();
      const mph = toNumber((wind.match(/(\d+(?:\.\d+)?)\s*mph/) || [])[1], 0);
      let factor = 1 + (weather.temp - 70) * 0.0015;
      if (wind.includes("out to")) factor += Math.max(0, mph - 5) * 0.002;
      else if (wind.includes("in from")) factor -= Math.max(0, mph - 5) * 0.002;
      else factor += Math.max(0, mph - 8) * 0.0005;
      return clamp(factor, 0.94, 1.08);
    }

    function getParkFactor(venueName) {
      const key = normalizeVenueKey(venueName);
      if (!key) return 1;
      for (const [name, factor] of Object.entries(PARK_FACTORS)) {
        const parkKey = normalizeVenueKey(name);
        if (parkKey === key || key.includes(parkKey) || parkKey.includes(key)) return factor;
      }
      return 1;
    }

    function buildNbaModelInputs(home, away) {
      if (!home || !away) return null;
      const expectedPoss = clamp((home.possessions + away.possessions) / 2, 92, 108);
      const marginPer100 = (home.netRating ?? 0) - (away.netRating ?? 0);
      const sampleWeight = clamp(Math.min(home.games || 0, away.games || 0) / 20, 0.15, 1);
      const effMargin = clamp(marginPer100 * expectedPoss / 100, -10, 10) * sampleWeight;
      const homeInjuries = home.injuries || [];
      const awayInjuries = away.injuries || [];
      const weightInjuries = list => list.reduce((sum, inj) => {
        if (/out/i.test(inj.status)) return sum + 0.75;
        if (/doubtful|questionable/i.test(inj.status)) return sum + 0.4;
        return sum + 0.15;
      }, 0);
      const injuryAdjustment = clamp(weightInjuries(awayInjuries) - weightInjuries(homeInjuries), -3, 3);
      const varianceFactor = clamp(
        Math.sqrt(expectedPoss / MODEL_ENRICHMENT.NBA.leaguePace) * (1 + 0.02 * (homeInjuries.length + awayInjuries.length)),
        0.95,
        1.14
      );
      const homePts = home.ortg != null && away.drtg != null
        ? (home.ortg + away.drtg) / 2 * expectedPoss / 100
        : null;
      const awayPts = away.ortg != null && home.drtg != null
        ? (away.ortg + home.drtg) / 2 * expectedPoss / 100
        : null;
      return {
        type: "NBA",
        expectedPoss,
        effMargin,
        injuryAdjustment,
        varianceFactor,
        expectedTotal: homePts != null && awayPts != null ? homePts + awayPts : null,
        home: { ...home, injuries: homeInjuries },
        away: { ...away, injuries: awayInjuries }
      };
    }

    function buildMlbModelInputs(game, homeTeam, awayTeam, homePitcher, awayPitcher, weather = null) {
      const park = getParkFactor(game.venue?.name);
      const weatherFactor = computeWeatherFactor(weather);
      const league = MODEL_ENRICHMENT.MLB;
      const homeOffAdj = homeTeam?.runsPerGame != null ? (homeTeam.runsPerGame - league.leagueRuns) * 0.25 : 0;
      const awayOffAdj = awayTeam?.runsPerGame != null ? (awayTeam.runsPerGame - league.leagueRuns) * 0.25 : 0;
      const homeDefAdj = homeTeam?.runsAllowedPerGame != null ? (homeTeam.runsAllowedPerGame - league.leagueRuns) * 0.25 : 0;
      const awayDefAdj = awayTeam?.runsAllowedPerGame != null ? (awayTeam.runsAllowedPerGame - league.leagueRuns) * 0.25 : 0;
      const homeBullpenEra = homeTeam?.bullpen?.era ?? homeTeam?.era;
      const awayBullpenEra = awayTeam?.bullpen?.era ?? awayTeam?.era;
      const homeBullpenAdj = homeBullpenEra != null ? clamp((league.leagueEra - homeBullpenEra) * 0.5, -1.5, 1.5) : 0;
      const awayBullpenAdj = awayBullpenEra != null ? clamp((league.leagueEra - awayBullpenEra) * 0.5, -1.5, 1.5) : 0;
      return {
        type: "MLB",
        park,
        weather,
        weatherFactor,
        homePitcher,
        awayPitcher,
        homeTeam,
        awayTeam,
        homeBullpen: homeTeam?.bullpen || null,
        awayBullpen: awayTeam?.bullpen || null,
        homeOffAdj,
        awayOffAdj,
        homeDefAdj,
        awayDefAdj,
        homeBullpenAdj,
        awayBullpenAdj,
        expectedTotal: null
      };
    }

    // Presupuesto de tiempo para todo el enriquecimiento: si se excede, la app
    // sigue con el modelo base en lugar de dejar la carga esperando.
    async function enrichGames(games, sportConfig, standingsMap, season, signal = null) {
      if (!games.length) return games;
      let timer = null;
      const budget = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), ENRICHMENT_BUDGET_MS);
      });
      try {
        const enriched = await Promise.race([
          enrichGamesInternal(games, sportConfig, standingsMap, season, signal),
          budget
        ]);
        if (enriched == null) {
          console.warn("Enriquecimiento lento; se usa el modelo base.");
          return games;
        }
        return enriched;
      } finally {
        clearTimeout(timer);
      }
    }

    async function enrichGamesInternal(games, sportConfig, standingsMap, season, signal = null) {
      try {
        if (sportConfig.id === "NBA") {
          const teams = new Map();
          for (const game of games) {
            teams.set(String(game.home.id), game.home);
            teams.set(String(game.away.id), game.away);
          }
          // Concurrencia limitada: evita saturar la red con 30+ equipos a la vez.
          const entries = await mapWithConcurrency([...teams.values()], ENRICHMENT_CONCURRENCY, async team => {
            const [stats, injuries] = await Promise.allSettled([
              fetchNbaTeamEnrichment(team, standingsMap, season, signal),
              fetchNbaInjuries(team.id, signal)
            ]);
            if (stats.status !== "fulfilled" || !stats.value) return null;
            return {
              key: String(team.id),
              value: {
                ...stats.value,
                injuries: injuries.status === "fulfilled" ? injuries.value : []
              }
            };
          });
          const byTeam = new Map(entries.filter(Boolean).map(e => [e.key, e.value]));
          return games.map(game => {
            const home = byTeam.get(String(game.home.id));
            const away = byTeam.get(String(game.away.id));
            const modelInputs = buildNbaModelInputs(home, away);
            return modelInputs ? { ...game, modelInputs } : game;
          });
        }
        if (sportConfig.id === "MLB") {
          const teams = new Map();
          const pitcherIds = new Set();
          for (const game of games) {
            teams.set(String(game.home.id), game.home);
            teams.set(String(game.away.id), game.away);
            if (game.probablePitcherIds?.home) pitcherIds.add(game.probablePitcherIds.home);
            if (game.probablePitcherIds?.away) pitcherIds.add(game.probablePitcherIds.away);
          }
          const [teamEntries, pitcherEntries, weatherMap] = await Promise.all([
            mapWithConcurrency([...teams.values()], ENRICHMENT_CONCURRENCY, async team => {
              const stats = await fetchMlbTeamEnrichment(team, season, signal);
              return stats ? [String(team.id), stats] : null;
            }),
            mapWithConcurrency([...pitcherIds], ENRICHMENT_CONCURRENCY, async id => {
              const stats = await fetchMlbPitcherEnrichment(id, season, signal);
              return stats ? [String(id), stats] : null;
            }),
            fetchMlbWeather(state.dateKey, signal)
          ]);
          const teamMap = new Map(teamEntries.filter(Boolean));
          const pitcherMap = new Map(pitcherEntries.filter(Boolean));
          return games.map(game => {
            const weatherKey = `${normalizeVenueKey(game.away.name)}@${normalizeVenueKey(game.home.name)}`;
            const weather = weatherMap.get(weatherKey) || null;
            const modelInputs = buildMlbModelInputs(
              game,
              teamMap.get(String(game.home.id)),
              teamMap.get(String(game.away.id)),
              pitcherMap.get(String(game.probablePitcherIds?.home || "")),
              pitcherMap.get(String(game.probablePitcherIds?.away || "")),
              weather
            );
            return { ...game, modelInputs };
          });
        }
      } catch (e) {
        console.warn("Model enrichment failed, using base model:", e);
      }
      return games;
    }

    // Standings helpers
    function collectStandingEntries(node, out = []) {
      if (!node || typeof node !== "object") return out;
      if (Array.isArray(node.entries)) {
        for (const entry of node.entries) if (entry?.team) out.push(entry);
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") collectStandingEntries(v, out);
      }
      return out;
    }
    function normalizeStatName(v) {
      return String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    function readStandingStat(entry, aliases) {
      const names = aliases.map(normalizeStatName);
      const stats = Array.isArray(entry?.stats) ? entry.stats : [];
      for (const s of stats) {
        const cand = [s.name, s.displayName, s.shortDisplayName, s.abbreviation].map(normalizeStatName);
        if (cand.some(n => names.includes(n))) {
          const val = toNumber(s.value, toNumber(s.displayValue));
          if (val !== null) return val;
        }
      }
      return null;
    }
    function buildTeamStatistics(standingsData) {
      if (!standingsData) return new Map();
      const entries = collectStandingEntries(standingsData);
      const map = new Map();
      for (const e of entries) {
        const team = e.team;
        const wins = readStandingStat(e, ["wins", "win", "w"]);
        const losses = readStandingStat(e, ["losses", "loss", "l"]);
        const games = Number.isFinite(wins) && Number.isFinite(losses) ? wins + losses : 0;
        let pf = readStandingStat(e, ["avgPointsFor", "pointsForPerGame", "ppg", "avgpointsscored", "runspergame"]);
        let pa = readStandingStat(e, ["avgPointsAgainst", "pointsAgainstPerGame", "oppg", "avgrunsallowed"]);
        // NFL publica totales de temporada (pointsFor/pointsAgainst), no promedios.
        let totalsUsed = false;
        if (!Number.isFinite(pf)) {
          const total = readStandingStat(e, ["pointsFor", "totalPointsFor"]);
          if (Number.isFinite(total) && games > 0) { pf = total / games; totalsUsed = true; }
        }
        if (!Number.isFinite(pa)) {
          const total = readStandingStat(e, ["pointsAgainst", "totalPointsAgainst"]);
          if (Number.isFinite(total) && games > 0) { pa = total / games; totalsUsed = true; }
        }
        let diff = readStandingStat(e, ["pointDifferential", "differential", "diff", "runDifferential", "avgRunDifferential"]);
        if (Number.isFinite(pf) && Number.isFinite(pa)) {
          diff = pf - pa;
        } else if (Number.isFinite(diff) && totalsUsed && games > 0) {
          diff = diff / games;
        }
        const teamStats = {
          wins: wins ?? 0,
          losses: losses ?? 0,
          games,
          winPercentage: games > 0 ? wins / games : 0.5,
          pointsFor: pf,
          pointsAgainst: pa,
          differential: diff
        };
        if (team.id) map.set(String(team.id), teamStats);
        if (team.abbreviation) map.set(String(team.abbreviation).toUpperCase(), teamStats);
      }
      return map;
    }

    // Scoreboard helpers
    function getCompetitor(comp, homeAway) {
      return comp?.competitors?.find(c => c.homeAway === homeAway);
    }
    function getTeamRecord(competitor) {
      return competitor?.records?.find(r => r.type === "total")?.summary ||
             competitor?.records?.[0]?.summary || "-";
    }
    function getAmericanSpreadPrice(teamOdds, oddsEntry, side) {
      const pointSpread = oddsEntry?.pointSpread?.[side];
      return toNumber(pointSpread?.close?.odds) ??
             toNumber(pointSpread?.current?.odds) ??
             toNumber(teamOdds?.spreadOdds) ??
             toNumber(teamOdds?.current?.spread?.american);
    }

    function extractHomeSpread(odds, away, home) {
      const pointSpreadHome = toNumber(odds?.pointSpread?.home?.close?.line) ??
                              toNumber(odds?.pointSpread?.home?.current?.line);
      if (pointSpreadHome !== null) return pointSpreadHome;
      const directSpread = toNumber(odds?.homeTeamOdds?.spread);
      if (directSpread !== null) return directSpread;

      const rawSpread = Math.abs(toNumber(odds.spread, NaN));
      if (Number.isFinite(rawSpread)) {
        if (odds.homeTeamOdds?.favorite === true) return -rawSpread;
        if (odds.awayTeamOdds?.favorite === true) return rawSpread;
      }
      if (odds.details) {
        const m = String(odds.details).toUpperCase().match(/([A-Z]{2,4})\s*([+-]\d+(?:\.\d+)?)/);
        if (m) {
          const listed = m[1];
          const spreadVal = Number(m[2]);
          // details a veces trae la moneyline ("TB -112"): descartar valores atípicos
          if (Number.isFinite(spreadVal) && Math.abs(spreadVal) <= 30) {
            if (listed === String(home?.team?.abbreviation).toUpperCase()) return spreadVal;
            if (listed === String(away?.team?.abbreviation).toUpperCase()) return -spreadVal;
          }
        }
      }
      return null;
    }

    function parseTotalLine(value) {
      const direct = toNumber(value);
      if (direct !== null) return direct;
      const match = String(value ?? "").match(/(?:o|u)\s*(\d+(?:\.\d+)?)/i) ||
                    String(value ?? "").match(/(\d+(?:\.\d+)?)/);
      return match ? Number(match[1]) : null;
    }
    function isValidAmericanPrice(price) {
      if (!Number.isFinite(price)) return false;
      const abs = Math.abs(price);
      return abs >= 100 && abs <= 1000;
    }
    function impliedProbabilitySum(p1, p2) {
      const a = americanOddsToProb(p1);
      const b = americanOddsToProb(p2);
      return a == null || b == null ? null : a + b;
    }
    function extractMarketSide(oddsEntry, kind) {
      return {
        spread: {
          home: toNumber(oddsEntry?.pointSpread?.home?.[kind]?.line),
          away: toNumber(oddsEntry?.pointSpread?.away?.[kind]?.line),
          homePrice: toNumber(oddsEntry?.pointSpread?.home?.[kind]?.odds),
          awayPrice: toNumber(oddsEntry?.pointSpread?.away?.[kind]?.odds)
        },
        total: {
          line: parseTotalLine(oddsEntry?.total?.over?.[kind]?.line),
          overPrice: toNumber(oddsEntry?.total?.over?.[kind]?.odds),
          underPrice: toNumber(oddsEntry?.total?.under?.[kind]?.odds)
        },
        moneyline: {
          home: toNumber(oddsEntry?.moneyline?.home?.[kind]?.odds),
          away: toNumber(oddsEntry?.moneyline?.away?.[kind]?.odds)
        }
      };
    }

    function parseOddsOffer(oddsEntry, away, home) {
      if (!oddsEntry) return null;
      const provider = oddsEntry.provider?.displayName ||
                       oddsEntry.provider?.name ||
                       oddsEntry.provider?.id ||
                       "Casa";
      const homeSpread = extractHomeSpread(oddsEntry, away, home);
      const homeRawPrice = getAmericanSpreadPrice(oddsEntry.homeTeamOdds, oddsEntry, "home");
      const awayRawPrice = getAmericanSpreadPrice(oddsEntry.awayTeamOdds, oddsEntry, "away");
      const homePrice = homeRawPrice ?? GLOBAL_CONFIG.DEFAULT_AMERICAN_PRICE;
      const awayPrice = awayRawPrice ?? GLOBAL_CONFIG.DEFAULT_AMERICAN_PRICE;
      const estimatedPrice = homeRawPrice == null || awayRawPrice == null;
      const pricesOk = isValidAmericanPrice(homePrice) && isValidAmericanPrice(awayPrice);
      const close = extractMarketSide(oddsEntry, "close");
      const open = extractMarketSide(oddsEntry, "open");
      const total = close.total.line ?? toNumber(oddsEntry.overUnder);
      const issues = [];

      if (!Number.isFinite(homeSpread)) {
        issues.push({ code: "SPREAD_MISSING", severity: "block", message: "Spread incompleto o inválido." });
      }
      if (!pricesOk) {
        issues.push({ code: "PRICE_INVALID", severity: "block", message: "Cuotas americanas inválidas (deben ser ±100 a ±1000)." });
      } else if (estimatedPrice) {
        issues.push({ code: "PRICE_ESTIMATED", severity: "block", message: "Falta una cuota real; no se puede evaluar el valor." });
      }
      const vigSum = pricesOk ? impliedProbabilitySum(homePrice, awayPrice) : null;
      if (vigSum != null && (vigSum < 0.99 || vigSum > 1.30)) {
        issues.push({
          code: "PRICE_INCONSISTENT",
          severity: "block",
          message: `Cuotas inconsistentes (prob. implícita ${formatPercentage(vigSum)}).`
        });
      } else if (vigSum != null && vigSum > 1.18) {
        issues.push({
          code: "VIG_HIGH",
          severity: "warn",
          message: `Vigorish alto (${formatPercentage(vigSum - 1)}).`
        });
      }
      if (Number.isFinite(total) && (close.total.overPrice == null || close.total.underPrice == null)) {
        issues.push({ code: "TOTAL_PRICE_MISSING", severity: "warn", message: "Total sin precio en ambos lados." });
      }
      if ((close.moneyline.home == null) !== (close.moneyline.away == null)) {
        issues.push({ code: "ML_INCOMPLETE", severity: "warn", message: "Moneyline incompleto." });
      }

      return {
        id: `espn:${normalizeBookKey(provider) || "casa"}`,
        provider,
        homeSpread,
        awaySpread: Number.isFinite(homeSpread) ? -homeSpread : null,
        homePrice,
        awayPrice,
        total,
        totalOverPrice: close.total.overPrice,
        totalUnderPrice: close.total.underPrice,
        mlHome: close.moneyline.home,
        mlAway: close.moneyline.away,
        open: {
          homeSpread: open.spread.home,
          homePrice: open.spread.homePrice,
          awayPrice: open.spread.awayPrice,
          total: open.total.line,
          totalOverPrice: open.total.overPrice,
          totalUnderPrice: open.total.underPrice,
          mlHome: open.moneyline.home,
          mlAway: open.moneyline.away
        },
        estimatedPrice,
        issues,
        source: "ESPN",
        lineValid: Number.isFinite(homeSpread) && pricesOk && !estimatedPrice
      };
    }

    function pickPrimaryOffer(offers) {
      for (const name of BOOK_PRIORITY) {
        const key = normalizeBookKey(name);
        const found = offers.find(o => normalizeBookKey(o.provider) === key);
        if (found) return found;
      }
      return offers[0] || null;
    }

    function extractMarket(comp, away, home) {
      const entries = Array.isArray(comp?.odds) ? comp.odds.filter(Boolean) : [];
      const offers = entries.map(e => parseOddsOffer(e, away, home)).filter(Boolean);
      const validOffers = offers.filter(o => o.lineValid);
      const primary = pickPrimaryOffer(validOffers);
      const venue = {
        id: comp?.venue?.id ? String(comp.venue.id) : "",
        name: comp?.venue?.fullName || "",
        city: comp?.venue?.address?.city || "",
        state: comp?.venue?.address?.state || ""
      };
      const statusState = comp?.status?.type?.state || "pre";
      const statusName = comp?.status?.type?.name || "";
      const neutralSite = comp?.neutralSite === true;
      const wasSuspended = comp?.wasSuspended === true;
      if (!primary) {
        const issues = offers[0]?.issues?.length
          ? offers[0].issues
          : [{ code: "LINE_MISSING", severity: "block", message: "Sin spread o cuotas utilizables." }];
        return {
          available: false,
          homeSpread: null,
          total: null,
          totalOverPrice: null,
          totalUnderPrice: null,
          mlHome: null,
          mlAway: null,
          open: null,
          homePrice: GLOBAL_CONFIG.DEFAULT_AMERICAN_PRICE,
          awayPrice: GLOBAL_CONFIG.DEFAULT_AMERICAN_PRICE,
          provider: offers[0]?.provider || "Sin línea",
          lineValid: false,
          issues,
          dataValid: false,
          offers,
          validOffers,
          booksCount: validOffers.length,
          venue,
          statusState,
          statusName,
          neutralSite,
          wasSuspended
        };
      }
      const issues = [...(primary.issues || [])];
      if (!primary.open || !Number.isFinite(primary.open.homeSpread)) {
        issues.push({ code: "OPEN_LINE_MISSING", severity: "warn", message: "La casa no publica línea de apertura; se usará la primera observada." });
      }
      if (Number.isFinite(primary.total) && (primary.totalOverPrice == null || primary.totalUnderPrice == null)) {
        issues.push({ code: "TOTAL_INCOMPLETE", severity: "warn", message: "Total sin cuota completa de over/under." });
      }
      return {
        available: true,
        homeSpread: primary.homeSpread,
        total: primary.total,
        totalOverPrice: primary.totalOverPrice,
        totalUnderPrice: primary.totalUnderPrice,
        mlHome: primary.mlHome,
        mlAway: primary.mlAway,
        open: primary.open ? { ...primary.open, provider: primary.provider } : null,
        homePrice: primary.homePrice,
        awayPrice: primary.awayPrice,
        provider: primary.provider,
        lineValid: primary.lineValid,
        issues,
        dataValid: !issues.some(i => i.severity === "block"),
        offers,
        validOffers,
        booksCount: validOffers.length,
        venue,
        statusState,
        statusName,
        neutralSite,
        wasSuspended
      };
    }

    function extractYesterdayTeams(scoreboardData) {
      const set = new Set();
      for (const ev of scoreboardData?.events || []) {
        const comp = ev?.competitions?.[0];
        const statusName = comp?.status?.type?.name || "";
        if (statusName.includes("CANCELED") || statusName.includes("POSTPONED")) continue;
        for (const c of comp?.competitors || []) {
          if (c?.team?.id) set.add(String(c.team.id));
          if (c?.team?.abbreviation) set.add(String(c.team.abbreviation).toUpperCase());
        }
      }
      return set;
    }

    function normalizeGames(scoreboardData, yesterdayTeams) {
      return (scoreboardData?.events || [])
        .map(ev => {
          const comp = ev?.competitions?.[0];
          if (!comp) return null;
          const away = getCompetitor(comp, "away");
          const home = getCompetitor(comp, "home");
          if (!away?.team || !home?.team) return null;
          const awayTeam = {
            id: String(away.team.id || ""),
            abbreviation: away.team.abbreviation || "AWY",
            name: away.team.displayName || away.team.shortDisplayName || away.team.abbreviation,
            logo: away.team.logo || "",
            record: getTeamRecord(away)
          };
          const homeTeam = {
            id: String(home.team.id || ""),
            abbreviation: home.team.abbreviation || "HME",
            name: home.team.displayName || home.team.shortDisplayName || home.team.abbreviation,
            logo: home.team.logo || "",
            record: getTeamRecord(home)
          };
          const awayB2B = yesterdayTeams.has(awayTeam.id) || yesterdayTeams.has(awayTeam.abbreviation.toUpperCase());
          const homeB2B = yesterdayTeams.has(homeTeam.id) || yesterdayTeams.has(homeTeam.abbreviation.toUpperCase());
          const market = extractMarket(comp, away, home);
          const statusName = comp.status?.type?.name || market.statusName || "STATUS_SCHEDULED";
          const statusText = `${statusName} ${comp.status?.type?.detail || ""} ${comp.status?.type?.shortDetail || ""}`.toUpperCase();
          const probablePitchers = {};
          const probablePitcherIds = {};
          for (const c of comp.competitors || []) {
            const prob = (c.probables || []).find(p => p.name === "probableStartingPitcher") || c.probables?.[0];
            const name = prob?.athlete?.displayName || prob?.athlete?.fullName;
            if (name) probablePitchers[c.homeAway] = name;
            if (prob?.athlete?.id) probablePitcherIds[c.homeAway] = String(prob.athlete.id);
          }
          return {
            id: String(ev.id || comp.id),
            eventDate: ev.date,
            time: formatGameTime(ev.date),
            away: awayTeam,
            home: homeTeam,
            awayScore: toNumber(away.score),
            homeScore: toNumber(home.score),
            awayB2B,
            homeB2B,
            market,
            totalLine: Number.isFinite(market.total) ? market.total : null,
            status: comp.status?.type?.shortDetail || comp.status?.type?.detail || "Programado",
            statusName,
            statusState: comp.status?.type?.state || market.statusState || "pre",
            postponed: /POSTPONED|POSPUESTO/.test(statusText),
            canceled: /CANCELED|CANCELLED|CANCELADO/.test(statusText),
            suspended: market.wasSuspended === true || /SUSPENDED|SUSPENDIDO/.test(statusText),
            neutralSite: market.neutralSite === true,
            venue: market.venue,
            probablePitchers,
            probablePitcherIds,
            completed: (comp.status?.type?.completed === true) || 
                       statusName.includes("FINAL") ||
                       (comp.status?.type?.state || "") === "post"
          };
        })
        .filter(Boolean);
    }

    // Proveedor alterno de cuotas (The Odds API)
    function loadOddsApiKey() {
      try { return localStorage.getItem(ODDS_API_CONFIG.apiKeyStorageKey) || ""; } catch { return ""; }
    }
    function saveOddsApiKey(value) {
      const key = String(value ?? "").trim();
      if (!key) return;
      state.oddsApiKey = key;
      state.oddsKeyDraft = "";
      state.altOdds.error = "";
      try {
        localStorage.setItem(ODDS_API_CONFIG.apiKeyStorageKey, key);
      } catch (e) {
        console.warn("No se pudo guardar la API key:", e);
      }
      refreshAltOdds({ force: true });
      render();
    }
    function saveOddsApiKeyFromInput() {
      const input = document.getElementById("oddsApiKeyInput");
      saveOddsApiKey(input?.value || "");
    }
    function clearOddsApiKey() {
      state.oddsApiKey = "";
      state.oddsKeyDraft = "";
      state.altOddsEvents = null;
      state.altOdds = {
        loading: false, error: "", requestsRemaining: null, updatedAt: null,
        bookCount: 0, matchedGames: 0, fromCache: false
      };
      try { localStorage.removeItem(ODDS_API_CONFIG.apiKeyStorageKey); } catch {}
      state.games = [];
      state.lastUpdated = null;
      loadGames();
    }
    function getAltOddsCacheKey(sportKey) {
      return `${ODDS_API_CONFIG.cacheKeyPrefix}${sportKey}`;
    }
    function loadAltOddsCache(sportKey) {
      try {
        const raw = localStorage.getItem(getAltOddsCacheKey(sportKey));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.events) || !Number.isFinite(parsed.fetchedAt)) return null;
        return parsed;
      } catch { return null; }
    }
    function saveAltOddsCache(sportKey, payload) {
      try {
        localStorage.setItem(getAltOddsCacheKey(sportKey), JSON.stringify(payload));
      } catch (e) {
        console.warn("No se pudo guardar el caché de cuotas:", e);
      }
    }
    function findOddsApiEvent(game, events) {
      if (!Array.isArray(events) || !events.length) return null;
      const gameTime = game.eventDate ? new Date(game.eventDate).getTime() : NaN;
      return events.find(ev => {
        const evTime = ev?.commence_time ? new Date(ev.commence_time).getTime() : NaN;
        if (Number.isFinite(gameTime) && Number.isFinite(evTime) &&
            Math.abs(evTime - gameTime) > 12 * 60 * 60 * 1000) return false;
        return teamsLikelyMatch(game.home.name, ev.home_team) &&
               teamsLikelyMatch(game.away.name, ev.away_team);
      }) || null;
    }
    function bookmakerToOffer(bookmaker, event) {
      const market = (bookmaker?.markets || []).find(m => m.key === "spreads");
      if (!market) return null;
      const homeOutcome = (market.outcomes || []).find(o => teamsLikelyMatch(o.name, event.home_team));
      const awayOutcome = (market.outcomes || []).find(o => teamsLikelyMatch(o.name, event.away_team));
      if (!homeOutcome || !awayOutcome) return null;
      const homeSpread = toNumber(homeOutcome.point);
      const awaySpread = toNumber(awayOutcome.point);
      const homePrice = toNumber(homeOutcome.price);
      const awayPrice = toNumber(awayOutcome.price);
      return {
        id: `oddsapi:${normalizeBookKey(bookmaker.key || bookmaker.title)}`,
        provider: bookmaker.title || bookmaker.key || "Casa",
        homeSpread,
        awaySpread,
        homePrice,
        awayPrice,
        total: null,
        estimatedPrice: false,
        source: "The Odds API",
        updatedAt: bookmaker.last_update || null,
        lineValid: Number.isFinite(homeSpread) && Number.isFinite(homePrice) && Number.isFinite(awayPrice)
      };
    }
    async function applyAltOddsEvents(events, meta = {}) {
      state.altOdds.updatedAt = meta.updatedAt || new Date();
      state.altOdds.requestsRemaining = meta.requestsRemaining ?? state.altOdds.requestsRemaining;
      state.altOdds.fromCache = !!meta.fromCache;
      if (!Array.isArray(events) || !events.length || !state.games.length) return;

      state.altOdds.error = "";
      state.altOddsEvents = events;
      const bookNames = new Set();
      let matchedGames = 0;
      const updatedGames = state.games.map(game => {
        const event = findOddsApiEvent(game, events);
        if (!event) return game;
        const altOffers = (event.bookmakers || [])
          .map(b => {
            const offer = bookmakerToOffer(b, event);
            if (offer) bookNames.add(offer.provider);
            return offer;
          })
          .filter(o => o && o.lineValid);
        if (!altOffers.length) return game;
        matchedGames++;
        const offers = mergeBookOffers(game.market.offers || [], altOffers);
        const market = { ...game.market, offers, booksCount: offers.length, hasAltBooks: true };
        const primaryKey = normalizeBookKey(market.provider);
        const matchingPrimary = altOffers.find(o => normalizeBookKey(o.provider) === primaryKey);
        if (matchingPrimary) {
          market.homeSpread = matchingPrimary.homeSpread;
          market.homePrice = matchingPrimary.homePrice;
          market.awayPrice = matchingPrimary.awayPrice;
          market.provider = matchingPrimary.provider;
          market.lineValid = matchingPrimary.lineValid;
          market.available = true;
        } else if (!market.lineValid || !Number.isFinite(market.homeSpread)) {
          const fill = pickPrimaryOffer(altOffers);
          if (fill) {
            market.homeSpread = fill.homeSpread;
            market.homePrice = fill.homePrice;
            market.awayPrice = fill.awayPrice;
            market.provider = fill.provider;
            market.lineValid = fill.lineValid;
            market.available = true;
          }
        }
        return { ...game, market };
      });

      state.altOdds.bookCount = bookNames.size;
      state.altOdds.matchedGames = matchedGames;
      state.games = updatedGames;

      if (state.standingsMap && state.standingsMap.size) {
        const sportId = state.sport.id;
        state.games = await runModel(state.games, state.standingsMap, state.sport, state.riskProfile);
        if (state.sport.id !== sportId) return;
      }
      updateLineIntelligence(state.games);
      generateParlays();
      saveCache(state.dateKey, state.games);
      render();
    }
    async function requestAltOdds(sportKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ODDS_API_CONFIG.fetchTimeoutMs);
      try {
        const url = new URL(`${ODDS_API_CONFIG.baseUrl}/${sportKey}/odds/`);
        url.searchParams.set("apiKey", state.oddsApiKey);
        url.searchParams.set("regions", ODDS_API_CONFIG.regions);
        url.searchParams.set("markets", ODDS_API_CONFIG.markets);
        url.searchParams.set("oddsFormat", "american");
        url.searchParams.set("dateFormat", "iso");
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        const requestsRemaining = toNumber(res.headers.get("x-requests-remaining"));
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.message) message = body.message;
          } catch {}
          throw new Error(message);
        }
        const events = await res.json();
        return { events: Array.isArray(events) ? events : [], requestsRemaining };
      } finally {
        clearTimeout(timeout);
      }
    }
    async function refreshAltOdds(options = {}) {
      const { force = false } = options;
      if (!state.oddsApiKey) {
        state.altOdds.error = "";
        render();
        return;
      }
      const sportKey = ODDS_API_CONFIG.sports[state.sport.id];
      if (!sportKey || state.altOdds.loading) return;
      const sportId = state.sport.id;
      const cached = loadAltOddsCache(sportKey);
      const fresh = cached && (Date.now() - cached.fetchedAt) < ODDS_API_CONFIG.cacheTtlMs;
      if (!force && fresh) {
        await applyAltOddsEvents(cached.events, {
          updatedAt: new Date(cached.fetchedAt),
          requestsRemaining: cached.requestsRemaining,
          fromCache: true
        });
        return;
      }
      state.altOdds.loading = true;
      state.altOdds.error = "";
      render();
      try {
        const { events, requestsRemaining } = await requestAltOdds(sportKey);
        saveAltOddsCache(sportKey, { fetchedAt: Date.now(), events, requestsRemaining });
        state.altOdds.loading = false;
        if (state.sport.id !== sportId) {
          refreshAltOdds();
          return;
        }
        await applyAltOddsEvents(events, { updatedAt: new Date(), requestsRemaining, fromCache: false });
      } catch (err) {
        console.warn("Cuotas alternativas no disponibles:", err);
        state.altOdds.loading = false;
        state.altOdds.error = err?.name === "AbortError"
          ? "Tiempo de espera agotado al consultar The Odds API."
          : `No se pudieron cargar las cuotas alternativas: ${err?.message || "error desconocido"}`;
        render();
      }
    }

    // Líneas alternativas vía backend/proxy
    function getAltMarketsBaseUrl() {
      const override = typeof window !== "undefined" ? window.LORDS_ODDS_BASE_URL : "";
      return String(override || "").replace(/\/+$/, "");
    }

    function normalizeAltAbbr(value) {
      const abbr = String(value ?? "").trim().toUpperCase();
      return ALT_ABBR_ALIASES[abbr] || abbr;
    }

    function findAltMarketGame(game, marketGames, sportId = state.sport.id) {
      if (!Array.isArray(marketGames) || !marketGames.length) return null;
      const home = normalizeAltAbbr(game?.home?.abbreviation);
      const away = normalizeAltAbbr(game?.away?.abbreviation);
      if (!home || !away) return null;
      const expectedSport = String(sportId || "").toUpperCase();
      const matches = marketGames.filter(entry => {
        const entrySport = String(entry?.sportId || "").toUpperCase();
        if (entrySport && expectedSport && entrySport !== expectedSport) return false;
        return normalizeAltAbbr(entry?.homeAbbr) === home &&
          normalizeAltAbbr(entry?.awayAbbr) === away;
      });
      return matches.length === 1 ? matches[0] : null;
    }

    function normalizeAltSpreadLine(line) {
      const spread = toNumber(line?.spread);
      const homePrice = toNumber(line?.homePrice);
      const awayPrice = toNumber(line?.awayPrice);
      if (spread == null || homePrice == null || awayPrice == null) return null;
      return { spread, homePrice, awayPrice };
    }

    function normalizeAltTotalLine(line) {
      const total = toNumber(line?.total);
      const overPrice = toNumber(line?.overPrice);
      const underPrice = toNumber(line?.underPrice);
      if (total == null || total <= 0 || overPrice == null || underPrice == null) return null;
      return { total, overPrice, underPrice };
    }

    function normalizeAltSpreadLines(lines) {
      if (!Array.isArray(lines)) return [];
      const bySpread = new Map();
      for (const line of lines) {
        const normalized = normalizeAltSpreadLine(line);
        if (!normalized) continue;
        if (!bySpread.has(normalized.spread)) {
          bySpread.set(normalized.spread, normalized);
        }
      }
      return [...bySpread.values()].sort((a, b) => a.spread - b.spread);
    }

    function normalizeAltTotalLines(lines) {
      if (!Array.isArray(lines)) return [];
      const byTotal = new Map();
      for (const line of lines) {
        const normalized = normalizeAltTotalLine(line);
        if (!normalized) continue;
        if (!byTotal.has(normalized.total)) {
          byTotal.set(normalized.total, normalized);
        }
      }
      return [...byTotal.values()].sort((a, b) => a.total - b.total);
    }

    function altSpreadCount(game) {
      const altLines = game?.altMarkets?.altSpreads;
      const lines = Array.isArray(altLines) && altLines.length
        ? altLines
        : game?.altMarkets?.spreads;
      if (!Array.isArray(lines) || !lines.length) return 0;
      const baseSpread = game?.altMarkets?.mainSpread?.spread ?? toNumber(game?.market?.homeSpread);
      return lines.filter(line =>
        Number.isFinite(line.spread) &&
        (baseSpread == null || Math.abs(line.spread - baseSpread) > 0.01)
      ).length;
    }

    function altTotalCount(game) {
      const altLines = game?.altMarkets?.altTotals;
      const lines = Array.isArray(altLines) && altLines.length
        ? altLines
        : game?.altMarkets?.totals;
      if (!Array.isArray(lines) || !lines.length) return 0;
      const baseTotal = game?.altMarkets?.mainTotal?.total ?? toNumber(game?.market?.total);
      return lines.filter(line =>
        Number.isFinite(line.total) &&
        (baseTotal == null || Math.abs(line.total - baseTotal) > 0.01)
      ).length;
    }

    function applyAltMarketsPayload(payload, meta = {}) {
      const marketGames = Array.isArray(payload?.games) ? payload.games : [];
      const payloadSport = String(payload?.sport || payload?.sportId || state.sport.id).toUpperCase();
      let matchedGames = 0;
      state.games = state.games.map(game => {
        const entry = findAltMarketGame(game, marketGames, payloadSport);
        if (!entry) return { ...game, altMarkets: null };

        const mainSpread = normalizeAltSpreadLine(entry.mainSpread);
        const mainTotal = normalizeAltTotalLine(entry.mainTotal);
        const spreads = normalizeAltSpreadLines(entry.spreads);
        const totals = normalizeAltTotalLines(entry.totals);
        let altSpreads = normalizeAltSpreadLines(entry.altSpreads);
        let altTotals = normalizeAltTotalLines(entry.altTotals);

        // Compatibilidad con respuestas legacy del proxy que solo traían
        // spreads/totals combinados.
        if (!altSpreads.length) {
          const baseSpread = mainSpread?.spread ?? toNumber(game?.market?.homeSpread);
          altSpreads = spreads.filter(line =>
            baseSpread == null || Math.abs(line.spread - baseSpread) > 0.01
          );
        }
        if (!altTotals.length) {
          const baseTotal = mainTotal?.total ?? toNumber(game?.market?.total);
          altTotals = totals.filter(line =>
            baseTotal == null || Math.abs(line.total - baseTotal) > 0.01
          );
        }

        if (!spreads.length && !totals.length && !altSpreads.length && !altTotals.length) {
          return { ...game, altMarkets: null };
        }
        matchedGames++;
        return {
          ...game,
          altMarkets: {
            idExterno: entry.idExterno || null,
            updatedAt: meta.updatedAt || null,
            mainSpread,
            mainTotal,
            altSpreads,
            altTotals,
            spreads,
            totals
          }
        };
      });
      state.altMarkets = {
        loading: false,
        error: "",
        updatedAt: meta.updatedAt || null,
        matchedGames,
        fromCache: meta.fromCache === true,
        requestsRemaining: Number.isFinite(meta.requestsRemaining) ? meta.requestsRemaining : null
      };
      generateParlays();
      saveCache(state.dateKey, state.games);
      render();
    }

    async function refreshAltMarkets(reqId = state.requestId) {
      if (!state.games.length) return;
      const sportId = state.sport.id;
      const dateKey = state.dateKey;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ALT_MARKETS_CONFIG.fetchTimeoutMs);
      state.altMarkets.loading = true;
      state.altMarkets.error = "";
      try {
        const baseUrl = getAltMarketsBaseUrl();
        const url = new URL(`${baseUrl}${ALT_MARKETS_CONFIG.endpoint}`, window.location.href);
        url.searchParams.set("sport", sportId);
        url.searchParams.set("date", dateKey);
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) message = body.error;
          } catch {}
          const error = new Error(message);
          error.notConfigured = res.status === 404;
          throw error;
        }
        const payload = await res.json();
        if (reqId !== state.requestId || state.sport.id !== sportId || state.dateKey !== dateKey) return;
        altMarketsWarned = false;
        applyAltMarketsPayload(payload, {
          updatedAt: payload.fetchedAt ? new Date(payload.fetchedAt) : new Date(),
          fromCache: payload.cached === true,
          requestsRemaining: payload.requestsRemaining
        });
      } catch (err) {
        if (reqId !== state.requestId) return;
        state.altMarkets.loading = false;
        if (err?.notConfigured) {
          // Sin backend no hay datos derivados que mostrar: se descarta el estado
          // de la integración y la app sigue solo con las líneas de ESPN.
          state.altMarkets.updatedAt = null;
          state.altMarkets.matchedGames = 0;
          state.altMarkets.fromCache = false;
          state.altMarkets.requestsRemaining = null;
        }
        state.altMarkets.error = err?.notConfigured
          ? "Cuotas alternativas no disponibles (sin backend /api/odds). Se usan solo las líneas de ESPN."
          : err?.name === "AbortError"
            ? "Tiempo de espera agotado al consultar las líneas alternativas."
            : `No se pudieron cargar las líneas alternativas: ${err?.message || "error desconocido"}`;
        if (!altMarketsWarned) {
          altMarketsWarned = true;
          console.warn("Odds alternativos no disponibles, continuo sin /api/odds", err?.message || err);
        }
        render();
      } finally {
        clearTimeout(timeout);
      }
    }

