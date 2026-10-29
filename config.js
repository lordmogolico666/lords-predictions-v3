/**
 * Lord's Predictions — config.js
 * Configuración estática: deportes, perfiles de riesgo, proveedores, almacenamiento,
 * parlays, totales y parámetros de rendimiento (Monte Carlo, concurrencia, worker).
 * Sin dependencias: puede importarse también desde worker.js.
 */
    "use strict";

    const SPORTS = Object.freeze({
      NBA: {
        id: "NBA",
        label: "NBA",
        description: "NBA Monte Carlo Prediction Engine",
        scoreboardUrl: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
        standingsUrl: "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings",
        homeAdvantageBase: 2.15,
        stdDev: 12.8,
        b2bPenalty: 2.25,
        earlySeasonRegGames: 12,
        unitName: "pts",
        edgeScale: 1.0,
        seasonGames: 82
      },
      MLB: {
        id: "MLB",
        label: "MLB",
        description: "MLB Monte Carlo Prediction Engine (Run Line)",
        scoreboardUrl: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
        standingsUrl: "https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings",
        homeAdvantageBase: 0.28,
        stdDev: 3.1,
        b2bPenalty: 0.0,
        earlySeasonRegGames: 25,
        unitName: "carr",
        edgeScale: 0.18,
        seasonGames: 162
      },
      NFL: {
        id: "NFL",
        label: "NFL",
        description: "NFL Monte Carlo Prediction Engine",
        scoreboardUrl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
        standingsUrl: "https://site.api.espn.com/apis/v2/sports/football/nfl/standings",
        homeAdvantageBase: 2.5,
        stdDev: 13.5,
        b2bPenalty: 0.0,
        earlySeasonRegGames: 4,
        unitName: "pts",
        edgeScale: 1.0,
        seasonGames: 17
      }
    });

    const GLOBAL_CONFIG = Object.freeze({
      DEFAULT_AMERICAN_PRICE: -110,
      KELLY_FRACTION: 0.25,
      AUTO_REFRESH_MS: 5 * 60 * 1000,
      FETCH_TIMEOUT_MS: 14000,
      // Tope global de una carga: evita que la UI quede en "cargando" para siempre.
      LOAD_TIMEOUT_MS: 30000
    });

    const ODDS_API_CONFIG = Object.freeze({
      baseUrl: "https://api.the-odds-api.com/v4/sports",
      sports: { NBA: "basketball_nba", MLB: "baseball_mlb", NFL: "americanfootball_nfl" },
      regions: "us",
      markets: "spreads",
      cacheTtlMs: 2 * 60 * 60 * 1000,
      fetchTimeoutMs: 20000,
      apiKeyStorageKey: "lords_odds_api_key",
      cacheKeyPrefix: "lords_alt_odds_v1_"
    });

    // Cuotas alternativas vía proxy backend. La API key vive solo en el servidor.
    // Si el frontend se sirve desde otro origen, define window.LORDS_ODDS_BASE_URL
    // (por ejemplo "http://localhost:8787") antes de cargar este script.
    // Sin backend (por ejemplo `python -m http.server`) el fetch da 404 y se
    // ignora: nunca debe bloquear el render de los partidos de ESPN.
    const ALT_MARKETS_CONFIG = Object.freeze({
      endpoint: "/api/odds",
      fetchTimeoutMs: 4000
    });

    const ALT_ABBR_ALIASES = Object.freeze({
      UTA: "UTAH",
      UTH: "UTAH",
      NOP: "NO",
      NOR: "NO",
      NYK: "NY",
      GSW: "GS",
      SAS: "SA",
      WAS: "WSH",
      PHO: "PHX",
      CHW: "CWS",
      ARI: "AZ",
      SDP: "SD",
      SFG: "SF",
      TBR: "TB",
      KCR: "KC",
      WSN: "WSH",
      OAK: "ATH",
      FLA: "MIA",
      ANA: "LAA"
    });

    const BOOK_PRIORITY = Object.freeze([
      "DraftKings", "ESPN BET", "FanDuel", "BetMGM", "Caesars", "bet365"
    ]);

    const MODEL_ENRICHMENT = Object.freeze({
      NBA: {
        leaguePace: 99.5,
        leagueOrtg: 114.0,
        leagueDrtg: 114.0,
        leagueEfg: 0.545,
        leagueTovPct: 0.145,
        leagueOrebPct: 0.26
      },
      MLB: {
        leagueRuns: 4.5,
        leagueEra: 4.10,
        leagueFip: 4.10,
        leagueK: 0.22,
        leagueBb: 0.085,
        leagueGb: 0.43
      }
    });

    const PARK_FACTORS = Object.freeze({
      "Coors Field": 1.15,
      "Great American Ball Park": 1.08,
      "Fenway Park": 1.05,
      "Sutter Health Park": 1.05,
      "Yankee Stadium": 1.03,
      "Wrigley Field": 1.03,
      "Citizens Bank Park": 1.04,
      "Globe Life Field": 1.02,
      "Chase Field": 1.02,
      "Oriole Park at Camden Yards": 1.02,
      "Rogers Centre": 1.02,
      "American Family Field": 1.01,
      "Daikin Park": 1.01,
      "Minute Maid Park": 1.01,
      "Guaranteed Rate Field": 1.01,
      "Rate Field": 1.01,
      "Truist Park": 1.00,
      "Target Field": 1.00,
      "Nationals Park": 1.00,
      "Busch Stadium": 0.99,
      "Angel Stadium": 0.99,
      "Progressive Field": 0.98,
      "Kauffman Stadium": 0.98,
      "PNC Park": 0.98,
      "Comerica Park": 0.97,
      "Dodger Stadium": 0.97,
      "Citi Field": 0.96,
      "Tropicana Field": 0.96,
      "loanDepot park": 0.95,
      "Oakland Coliseum": 0.95,
      "T-Mobile Park": 0.94,
      "Petco Park": 0.94,
      "Oracle Park": 0.93
    });

    const ENRICHMENT_CACHE_MS = 6 * 60 * 60 * 1000;
    const PARLAY_ALT_SPREAD_STEPS = [0, 2, 3, 5];
    const PARLAY_ALT_DECIMAL_COST = 0.08;
    const PARLAY_MAX_COMBINATIONS = 25000;
    const PARLAY_MARGIN_SAMPLES = 1600;

    // --- Filtro de calidad de legs para parlays ---
    // Solo partidos con una pata individual suficientemente probable y con EV no negativo.
    const PARLAY_MIN_PROB_PER_LEG = 0.55;        // probabilidad mínima individual
    const PARLAY_MIN_EV_PER_LEG = 0.0;           // EV individual mínimo (en unidades)
    const PARLAY_BASE_MAX_PLAYS = 10;            // máximo de partidos base para formar combos
    const PARLAY_MAX_PARLAYS_SHOWN = 100;        // máximo de parlays a mostrar

    // --- Stake sugerido del parlay (Kelly muy conservador) ---
    const PARLAY_KELLY_FACTOR = 0.25;            // solo 25% del Kelly calculado
    const PARLAY_MAX_STAKE_PCT = 1.0;            // como máximo 1% del bankroll en un parlay

    // --- Selección de línea por leg de parlay ---
    // Primero se buscan líneas "seguras" (prob >= 60%) con EV >= -0.01 y se
    // toma la de mayor probabilidad; si no hay, se toma la de mayor EV.
    const PARLAY_LEG_SAFE_PROB = 0.60;
    const PARLAY_LEG_MIN_EV = -0.01;

    // --- Totales (Over/Under) por partido ---
    // Media base de puntos totales cuando no hay un total esperado del modelo
    // (NBA usa expectedTotal de ESPN si esta disponible). La linea sale de
    // ESPN; sin linea no se calculan probabilidades O/U.
    const TOTAL_BASE = Object.freeze({ NBA: 225, NFL: 44 });
    const TOTAL_SD = Object.freeze({ NBA: 18, NFL: 10 });
    const TOTAL_FALLBACK = 220;
    const TOTAL_MVP_PRICE = -110;

    // --- Team Totals manuales ---
    // Muestra reducida de puntajes por equipo para estimar Over/Under de cada
    // equipo sin repetir Monte Carlo al introducir la línea a mano. Se mantiene
    // pequeña porque se guarda en caché junto a cada partido.
    const TEAM_TOTAL_SAMPLES = 600;
    const TEAM_TOTALS_STORAGE_KEY = "lords_team_totals_v1";

    // --- Categorías de parlay ---
    const PARLAY_CATEGORY_MIN_VALUE_PROB = 0.30; // VALUE: EV > 0 y prob >= 30%
    const PARLAY_CATEGORY_MIN_SAFE_PROB = 0.60;  // SAFE: prob >= 60%
    const PARLAY_CATEGORIES = Object.freeze({
      ALL: { label: "Todos" },
      VALUE: { label: "Value" },
      SAFE: { label: "Seguros" },
      ACTION: { label: "Acción" }
    });
    const PARLAY_CATEGORY_STYLES = Object.freeze({
      VALUE: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
      SAFE: "bg-sky-500/10 border-sky-500/30 text-sky-300",
      ACTION: "bg-amber-500/10 border-amber-500/30 text-amber-300"
    });
    const RISK_PROFILES = Object.freeze({
      CONSERVATIVE: {
        id: "CONSERVATIVE",
        label: "Conservador",
        description: "Pocas apuestas, muy filtradas.",
        minEdgePts: 3.8,
        minEdgeRelative: 0.28,
        minZ: 0.26,
        minConsensusEdge: 0.005,
        minCoverProbability: 0.565,
        minKelly: 1.2,
        maxKelly: 3.0,
        minOdds: -140,
        maxOdds: 140
      },
      STANDARD: {
        id: "STANDARD",
        label: "Estándar",
        description: "Equilibrio entre volumen y calidad, con filtros más estrictos.",
        minEdgePts: 3.5,
        minEdgeRelative: 0.20,
        minZ: 0.25,
        minConsensusEdge: 0.0,
        minCoverProbability: 0.58,
        minKelly: 1.5,
        maxKelly: 4.5,
        minOdds: -150,
        maxOdds: 150
      },
      AGGRESSIVE: {
        id: "AGGRESSIVE",
        label: "Agresivo",
        description: "Más volumen, mayor varianza.",
        minEdgePts: 2.2,
        minEdgeRelative: 0.14,
        minZ: 0.14,
        minConsensusEdge: -0.01,
        minCoverProbability: 0.525,
        minKelly: 0.6,
        maxKelly: 6.0,
        minOdds: -170,
        maxOdds: 170
      }
    });

    const PICKS_STORAGE_KEY = "lords_official_picks_v1";
    // Cuaderno de apuestas manual: registro personal, independiente de los
    // picks oficiales del modelo.
    const BET_JOURNAL_STORAGE_KEY = "lords_bet_journal_v1";
    const BET_JOURNAL_TYPES = Object.freeze(["ATS", "TOTAL", "PROP", "PARLAY", "OTRO"]);
    const BET_JOURNAL_RESULTS = Object.freeze(["PENDING", "WIN", "LOSS", "PUSH"]);
    const LINE_SNAPSHOT_KEY = "lords_line_snapshots_v1";
    const ALERTS_STORAGE_KEY = "lords_alerts_v1";
    const TRACKED_PICKS_KEY = "lords_tracked_picks_v1";
    const PLAYER_PROPS_KEY = "lords_player_props_v1";
    const SNAPSHOT_RETENTION_DAYS = 60;
    const ALERTS_RETENTION_DAYS = 14;

    // --- Rendimiento ---
    // Simulaciones por partido. Se redujeron desde 18k-22k para aliviar el hilo
    // principal; el modelo (medías, márgenes, RNG) es el mismo, por lo que las
    // probabilidades cambian solo por el error de muestreo de Monte Carlo.
    const MONTE_CARLO = Object.freeze({
      sims: Object.freeze({ NBA: 10000, MLB: 9000, NFL: 10000 }),
      fallbackSims: 8000
    });

    // Máximo de peticiones de enriquecimiento simultáneas.
    const ENRICHMENT_CONCURRENCY = 6;

    // Presupuesto total para el enriquecimiento. Si ESPN responde lento o está
    // bloqueado, se renderiza igualmente con el modelo base.
    const ENRICHMENT_BUDGET_MS = 10000;

    // El Monte Carlo corre en un Web Worker. Si no está disponible, main.js
    // ejecuta la misma función simulateGame en el hilo principal (mismo modelo).
    const WORKER_CONFIG = Object.freeze({
      enabled: true,
      script: "worker.js",
      // Un worker colgado no debe retener la carga: al agotarse se reinicia y
      // se cae al hilo principal.
      timeoutMs: 15000
    });

