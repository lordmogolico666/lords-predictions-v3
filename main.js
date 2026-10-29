/**
 * Lord's Predictions — main.js
 * Estado global, orquestación de carga, cliente del Web Worker e inicialización.
 * Debe cargarse el último.
 */
"use strict";

    const state = {
      sport: SPORTS.NBA,
      dayOffset: 0,
      dateKey: "",
      dateLabel: "",
      games: [],
      tab: "ALL",
      loading: false,
      error: "",
      warning: "",
      source: "ESPN",
      lastUpdated: null,
      requestId: 0,
      testsPassed: false,
      riskProfile: RISK_PROFILES.STANDARD,
      officialPicks: [],
      betJournal: [],
      trackedPicks: [],
      lineSnapshots: {},
      alerts: [],
      autoTrack: true,
      standingsMap: new Map(),
      oddsApiKey: "",
      oddsKeyDraft: "",
      altOddsEvents: null,
      altOdds: {
        loading: false,
        error: "",
        requestsRemaining: null,
        updatedAt: null,
        bookCount: 0,
        matchedGames: 0,
        fromCache: false
      },
      altMarkets: {
        loading: false,
        error: "",
        updatedAt: null,
        matchedGames: 0,
        fromCache: false,
        requestsRemaining: null
      },
      filters: {
        onlyWithLine: false,
        onlyQualified: false,
        status: "ALL",
        minEdge: 0,
        minProbability: 0,
        sideType: "ALL",
        onlyClean: false
      },
      sort: {
        field: "EDGE",
        direction: "DESC"
      },
      viewMode: "DETAILED",
      bankroll: 100,
      maxStakePerBetPct: 3,
      maxDailyRiskPct: 10,
      minZOverride: null,
      backtestSource: "OFFICIAL",
      officialAnalytics: {
        sport: "ALL",
        segment: "PROB"
      },
      parlayConfig: {
        size: 2,
        baseSet: "PLAYS"
      },
      parlayCategoryFilter: "ALL",
      parlayMeta: null,
      parlays: [],
      playerProps: [],
      propsError: "",
      propsNotice: "",
      kellyContext: null,
      workerActive: false
    };

    // AbortController de la carga en curso (se cancela al iniciar otra).
    let activeLoadController = null;
    function getDrawdownStats(picks) {
      const settled = (picks || [])
        .filter(p => ["WIN", "LOSS", "PUSH"].includes(p.result))
        .slice()
        .sort((a, b) => (a.settledAt || a.createdAt || 0) - (b.settledAt || b.createdAt || 0));
      let equity = 0;
      let peak = 0;
      let maxDrawdown = 0;
      for (const pick of settled) {
        equity += Number(pick.units) || 0;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, peak - equity);
      }
      return {
        equity,
        peak,
        drawdown: Math.max(0, peak - equity),
        maxDrawdown,
        count: settled.length
      };
    }
    function getSeasonProgress(sportConfig) {
      const totalGames = sportConfig.seasonGames || (sportConfig.id === "MLB" ? 162 : 82);
      const seen = new Set();
      let sum = 0;
      let teams = 0;
      if (state.standingsMap?.values) {
        for (const stats of state.standingsMap.values()) {
          if (!stats || seen.has(stats)) continue;
          seen.add(stats);
          sum += Number(stats.games) || 0;
          teams++;
        }
      }
      if (!teams && state.games.length) {
        const teamGames = new Map();
        for (const game of state.games) {
          for (const side of ["home", "away"]) {
            const team = game[side];
            if (!team?.abbreviation) continue;
            teamGames.set(team.abbreviation, Math.max(teamGames.get(team.abbreviation) || 0, parseRecord(team.record).games));
          }
        }
        for (const games of teamGames.values()) {
          sum += games;
          teams++;
        }
      }
      const avgGames = teams ? sum / teams : 0;
      return { progress: clamp(avgGames / totalGames, 0, 1), avgGames, totalGames, teams };
    }
    function getKellyContext(profile, sportConfig) {
      const season = getSeasonProgress(sportConfig);
      const seasonFactor = 0.5 + 0.5 * season.progress;
      const officialSettled = state.officialPicks.filter(p => ["WIN", "LOSS", "PUSH"].includes(p.result));
      const useOfficial = officialSettled.length >= 5;
      const drawdown = getDrawdownStats(useOfficial ? officialSettled : state.trackedPicks);
      const effectiveDrawdown = drawdown.count >= 5 ? drawdown.drawdown : 0;
      const drawdownFactor = clamp(1 - effectiveDrawdown * 0.04, 0.55, 1);
      return {
        maxKelly: profile.maxKelly * seasonFactor * drawdownFactor,
        seasonFactor,
        drawdownFactor,
        seasonProgress: season.progress,
        avgGames: season.avgGames,
        totalGames: season.totalGames,
        drawdownUnits: effectiveDrawdown,
        maxDrawdownUnits: drawdown.count >= 5 ? drawdown.maxDrawdown : 0,
        drawdownSource: useOfficial ? "official" : "tracked",
        settledCount: drawdown.count
      };
    }

    // --- Cliente del Web Worker de Monte Carlo ---
    // El worker importa config/utils/model y ejecuta simulateGame completo. Si
    // falla o no existe, runModel cae al hilo principal con la misma función.
    let monteCarloWorker = null;
    let monteCarloSeq = 0;
    let monteCarloDisabled = false;
    const monteCarloPending = new Map();

    // Cancela las peticiones pendientes y descarta el worker actual. La próxima
    // carga intentará crear uno nuevo (o usará el hilo principal).
    function resetMonteCarloWorker(reason) {
      for (const pending of monteCarloPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      monteCarloPending.clear();
      try { monteCarloWorker?.terminate(); } catch { /* noop */ }
      monteCarloWorker = null;
    }

    function initMonteCarloWorker() {
      if (!WORKER_CONFIG.enabled || typeof Worker === "undefined" || monteCarloDisabled) return null;
      if (monteCarloWorker) return monteCarloWorker;
      try {
        monteCarloWorker = new Worker(WORKER_CONFIG.script);
        monteCarloWorker.onmessage = (event) => {
          const { requestId, results, error } = event.data || {};
          const pending = monteCarloPending.get(requestId);
          if (!pending) return;
          monteCarloPending.delete(requestId);
          clearTimeout(pending.timer);
          if (error) pending.reject(new Error(error));
          else pending.resolve(results);
        };
        monteCarloWorker.onerror = (event) => {
          console.warn("Worker de Monte Carlo no disponible, usando hilo principal:", event?.message || event);
          monteCarloDisabled = true;
          resetMonteCarloWorker("worker_error");
        };
      } catch (e) {
        console.warn("No se pudo iniciar el Worker de Monte Carlo:", e);
        monteCarloWorker = null;
      }
      return monteCarloWorker;
    }

    function simulateGamesInWorker(games, params) {
      const worker = initMonteCarloWorker();
      if (!worker) return null;
      const requestId = ++monteCarloSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // Worker colgado: se descarta para no retener la carga; la próxima
          // vez se crea uno nuevo o se simula en el hilo principal.
          console.warn("Worker de Monte Carlo sin respuesta; se reinicia.");
          resetMonteCarloWorker("worker_timeout");
        }, WORKER_CONFIG.timeoutMs);
        monteCarloPending.set(requestId, { resolve, reject, timer });
        worker.postMessage({
          requestId,
          sportId: params.sportConfig.id,
          games,
          standingsMap: params.standingsMap,
          riskProfile: params.riskProfile,
          kellyContext: params.kellyContext,
          dateKey: params.dateKey,
          minZOverride: state.minZOverride,
          sims: params.sims ?? null
        });
      });
    }

    async function runModel(games, standingsMap, sportConfig, riskProfile) {
      const kellyContext = getKellyContext(riskProfile, sportConfig);
      state.kellyContext = kellyContext;
      if (!games.length) return [];
      if (!monteCarloDisabled) {
        try {
          const pending = simulateGamesInWorker(games, {
            standingsMap,
            sportConfig,
            riskProfile,
            kellyContext,
            dateKey: state.dateKey
          });
          if (pending) {
            const results = await pending;
            if (Array.isArray(results) && results.length === games.length) {
              state.workerActive = true;
              return results;
            }
            throw new Error("worker_results_invalid");
          }
        } catch (e) {
          console.warn("Monte Carlo en worker falló; se usa el hilo principal:", e?.message || e);
        }
      }
      state.workerActive = false;
      return games.map(g => simulateGame(g, standingsMap, sportConfig, riskProfile, kellyContext));
    }
    // Reaplica las líneas/cuotas manuales de Team Totals sobre las muestras de
    // puntaje ya simuladas; no vuelve a correr Monte Carlo.
    function applyManualTeamTotals(games) {
      if (!Array.isArray(games) || !games.length) return games;
      const manual = getManualTeamTotals(state.sport.id, state.dateKey);
      for (const game of games) {
        const entry = manual[game.id];
        game.teamTotals = computeTeamTotals(entry || game.teamTotals, game.teamScoreSamples);
      }
      return games;
    }
    async function loadGames(options = {}) {
      const { silent = false } = options;
      const reqId = ++state.requestId;
      // Cancela la carga anterior para no acumular peticiones ni renders viejos.
      if (activeLoadController) activeLoadController.abort();
      const controller = new AbortController();
      activeLoadController = controller;
      const signal = controller.signal;
      // Tope global: si ESPN o el enriquecimiento se cuelgan, la carga termina
      // con caché/aviso en lugar de dejar el spinner para siempre.
      const loadDeadline = Date.now() + GLOBAL_CONFIG.LOAD_TIMEOUT_MS;
      const loadWatchdog = setTimeout(() => controller.abort(), GLOBAL_CONFIG.LOAD_TIMEOUT_MS);
      const assertBeforeDeadline = () => {
        if (Date.now() > loadDeadline) {
          const timeoutError = new Error("load_timeout");
          timeoutError.isLoadTimeout = true;
          throw timeoutError;
        }
      };
      state.dateKey = getNewYorkDateKey(state.dayOffset);
      state.dateLabel = formatDateLabel(state.dateKey);
      state.error = "";
      state.warning = "";
      state.parlays = [];
      state.parlayMeta = null;
      state.altMarkets = {
        loading: false,
        error: "",
        updatedAt: null,
        matchedGames: 0,
        fromCache: false,
        requestsRemaining: null
      };
      if (!silent) state.loading = true;
      render();
      const sportConfig = state.sport;
      try {
        const scoreboard = await fetchScoreboard(sportConfig, state.dateKey, signal);
        const yKey = shiftDateKey(state.dateKey, -1);
        const seasonHint = Number(scoreboard?.events?.[0]?.season?.year);
        const inferredSeason = Number.isFinite(seasonHint) && seasonHint > 2000
          ? seasonHint
          : inferSeasonForSport(state.dateKey, sportConfig);
        const [yRes, stRes] = await Promise.allSettled([
          fetchScoreboard(sportConfig, yKey, signal),
          fetchStandings(sportConfig, inferredSeason, signal)
        ]);
        if (reqId !== state.requestId) return;
        assertBeforeDeadline();
        const yData = yRes.status === "fulfilled" ? yRes.value : { events: [] };
        const stData = stRes.status === "fulfilled" ? stRes.value : null;
        const standingsMap = buildTeamStatistics(stData);
        if (!stData) {
          state.warning = "Standings no disponibles. Usando récords del scoreboard.";
        } else if (sportConfig.id === "NFL" && standingsMap.size === 0) {
          state.warning = "Standings NFL limitados, usando récord básico";
        }
        const yTeams = extractYesterdayTeams(yData);
        state.standingsMap = standingsMap;
        const normGames = normalizeGames(scoreboard, yTeams);
        const enrichedGames = await enrichGames(normGames, sportConfig, standingsMap, inferredSeason, signal);
        if (reqId !== state.requestId) return;
        assertBeforeDeadline();
        const modeledGames = await runModel(enrichedGames, standingsMap, sportConfig, state.riskProfile);
        if (reqId !== state.requestId) return;
        assertBeforeDeadline();
        state.games = applyManualTeamTotals(modeledGames);
        refreshAltMarkets(reqId);

        if (state.officialPicks.length && state.games.length) {
          const gameMap = new Map(state.games.map(g => [getGameKey(g), g]));
          state.officialPicks = state.officialPicks.map(p => {
            const game = gameMap.get(p.id);
            if (!game) return p;
            const isFinal = game.completed ||
                            (game.statusName || "").includes("FINAL") ||
                            (game.status || "").toLowerCase().includes("final");
            if (!isFinal) return p;
            return settlePickWithGame(p, game);
          });
          saveOfficialPicks(state.officialPicks);
        }
        settleBetJournalWithGames();

        updateLineIntelligence(state.games);
        generateParlays();
        state.source = "ESPN";
        state.lastUpdated = new Date();
        saveCache(state.dateKey, state.games);
        if (state.oddsApiKey && state.dayOffset >= 0) {
          refreshAltOdds();
        }
      } catch (err) {
        // Solo una carga supersedida se descarta; un timeout del watchdog sí
        // debe pintar el aviso (o la caché) y liberar el spinner.
        if (reqId !== state.requestId) return;
        const timedOut = err?.isLoadTimeout || err?.name === "AbortError";
        if (timedOut) console.warn("Carga interrumpida por tiempo de espera.");
        else console.error(err);
        const cache = loadCache(state.dateKey);
        if (cache) {
          state.games = applyManualTeamTotals(cache.games);
          annotateGamesFromSnapshots(state.games);
          settleBetJournalWithGames();
          state.source = "Caché local";
          state.lastUpdated = new Date(cache.savedAt);
          state.warning = timedOut
            ? "Tiempo de espera agotado. Mostrando datos en caché."
            : "Error al conectar con ESPN. Mostrando datos en caché.";
        } else {
          state.games = [];
          state.source = "Sin conexión";
          state.error = timedOut
            ? "Tiempo de espera agotado al cargar los partidos. Revisa tu conexión e inténtalo de nuevo."
            : "No se pudo conectar con ESPN. Abre el archivo desde un servidor local o verifica CORS.";
        }
        generateParlays();
        refreshAltMarkets(reqId);
      } finally {
        clearTimeout(loadWatchdog);
        if (reqId === state.requestId) {
          state.loading = false;
          render();
        }
      }
    }

    // Inicialización
    state.officialPicks = loadOfficialPicks();
    state.betJournal = loadBetJournal();
    state.oddsApiKey = loadOddsApiKey();
    state.lineSnapshots = loadLineSnapshots();
    state.alerts = loadAlerts();
    state.trackedPicks = loadTrackedPicks();
    state.autoTrack = loadAutoTrack();
    state.playerProps = loadPlayerProps();
    runSelfTests();
    render();
    loadGames();

    setInterval(() => {
      if (!document.hidden && !state.loading) loadGames({ silent: true });
    }, GLOBAL_CONFIG.AUTO_REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !state.loading && (!state.lastUpdated || Date.now() - state.lastUpdated.getTime() > 2 * 60 * 1000)) {
        loadGames({ silent: true });
      }
    });
