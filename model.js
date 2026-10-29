/**
 * Lord's Predictions — model.js
 * Modelo: strength, Monte Carlo (simulateGame), totales, líneas alternativas y motor de parlays.
 * Debe poder ejecutarse dentro de un Web Worker (sin DOM y sin depender de `state`).
 * Las funciones que sí usan `state` (motor de parlays) solo se invocan en el hilo principal.
 */
"use strict";

    function percentile(sortedArray, p) {
      if (!sortedArray.length) return null;
      const idx = (sortedArray.length - 1) * p;
      const lower = Math.floor(idx);
      const upper = Math.ceil(idx);
      if (lower === upper) return sortedArray[lower];
      const weight = idx - lower;
      return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
    }

    // Muestra ordenada y reducida de los márgenes simulados. Se guarda en el
    // partido para estimar ATS de líneas alternativas sin repetir Monte Carlo
    // ni cargar en caché las 18k-22k simulaciones completas.
    function downsampleSortedSamples(sorted, maxSamples = PARLAY_MARGIN_SAMPLES) {
      if (!Array.isArray(sorted) || !sorted.length) return [];
      if (sorted.length <= maxSamples) return sorted.slice();
      const result = new Array(maxSamples);
      const step = (sorted.length - 1) / (maxSamples - 1);
      for (let i = 0; i < maxSamples; i++) {
        result[i] = sorted[Math.round(i * step)];
      }
      return result;
    }
    function getEffectiveMinEdge(profile, sport) {
      return profile.minEdgePts * (sport.edgeScale || 1);
    }
    function getEffectiveMinZ(profile, minZOverride) {
      const override = minZOverride !== undefined
        ? minZOverride
        : (typeof state !== "undefined" ? state.minZOverride : null);
      return Number.isFinite(override) ? override : (profile.minZ ?? 0.20);
    }

    function coverProbabilityFromMargins(margins, isHome, spread) {
      if (!Array.isArray(margins) || !margins.length || !Number.isFinite(spread)) return null;
      let covers = 0, losses = 0;
      for (let i = 0; i < margins.length; i++) {
        const ats = (isHome ? margins[i] : -margins[i]) + spread;
        if (ats > 0.0001) covers++;
        else if (ats < -0.0001) losses++;
      }
      const decisions = covers + losses;
      return decisions > 0 ? covers / decisions : null;
    }

    // Probabilidad de cubrir un spread usando los márgenes simulados guardados
    // en el partido. Se estima estrictamente P(ATS > 0), así que los empujes
    // cuentan en el denominador, sin volver a ejecutar Monte Carlo.
    function estimateCoverProbForSide(game, spreadAlt, sideAbbr) {
      const samples = game?.marginSamples;
      if (!Array.isArray(samples) || !samples.length || !Number.isFinite(spreadAlt)) return null;
      const homeAbbr = String(game?.home?.abbreviation || "").toUpperCase();
      const awayAbbr = String(game?.away?.abbreviation || "").toUpperCase();
      const side = String(sideAbbr || "").toUpperCase();
      let isHome;
      if (side && side === homeAbbr) isHome = true;
      else if (side && side === awayAbbr) isHome = false;
      else return null;

      let wins = 0, total = 0;
      for (const m of samples) {
        const margin = Number(m);
        if (!Number.isFinite(margin)) continue;
        const ats = (isHome ? margin : -margin) + spreadAlt;
        if (ats > 0.0001) wins++;
        total++;
      }
      return total > 0 ? wins / total : null;
    }

    function standardNormalCdf(z) {
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const density = 0.3989422804 * Math.exp(-z * z / 2);
      const tail = density * t * (
        0.319381530 + t * (
          -0.356563782 + t * (
            1.781477937 + t * (
              -1.821255978 + t * 1.330274429
            )
          )
        )
      );
      return z >= 0 ? 1 - tail : tail;
    }

    // Respaldo para partidos cacheados antes de guardar marginSamples.
    function coverProbabilityFromModel(game, isHome, spread) {
      const expectedHomeMargin = game?.expectedHomeMargin == null
        ? null
        : toNumber(game.expectedHomeMargin);
      const stdDev = game?.simStdDev == null ? null : toNumber(game.simStdDev);
      if (!Number.isFinite(expectedHomeMargin) || !Number.isFinite(stdDev) || stdDev <= 0) {
        return null;
      }
      const sideMean = isHome ? expectedHomeMargin : -expectedHomeMargin;
      return clamp(standardNormalCdf((sideMean + spread) / stdDev), 0.001, 0.999);
    }

    function americanFromDecimal(decimal) {
      const dec = Number(decimal);
      if (!Number.isFinite(dec) || dec <= 1) return null;
      const raw = dec >= 2 ? (dec - 1) * 100 : -100 / (dec - 1);
      let rounded = Math.round(raw / 5) * 5;
      if (rounded > -100 && rounded < 100) rounded = rounded >= 0 ? 100 : -100;
      return rounded;
    }

    // Conversión exacta decimal -> americana (sin redondeo a múltiplos de 5).
    // Se usa para el Kelly del parlay; devuelve 0 si la cuota no es válida.
    function decimalToAmerican(dec) {
      const d = Number(dec);
      if (!Number.isFinite(d) || d <= 1) return 0;
      const profit = d - 1;
      if (profit >= 1) {
        return Math.round(profit * 100); // +odds
      } else {
        return Math.round(-100 / profit); // -odds
      }
    }

    // --- Clasificación de parlays ---
    // VALUE: EV total positivo y probabilidad >= 30%.
    // SAFE: probabilidad >= 60% (aunque el EV no sea enorme).
    // ACTION: cualquier otro caso.
    function classifyParlay(prob, evUnits) {
      const p = Number(prob);
      const ev = Number(evUnits);
      if (!Number.isFinite(p)) return "ACTION";
      if (Number.isFinite(ev) && ev > 0 && p >= PARLAY_CATEGORY_MIN_VALUE_PROB) return "VALUE";
      if (p >= PARLAY_CATEGORY_MIN_SAFE_PROB) return "SAFE";
      return "ACTION";
    }

    // Pata más débil = la de menor probabilidad individual.
    function findWeakLeg(legs) {
      let weak = null;
      for (const leg of legs || []) {
        if (!leg) continue;
        if (!weak || Number(leg.prob) < Number(weak.prob)) weak = leg;
      }
      if (!weak) return null;
      return {
        gameId: weak.gameId ?? null,
        team: weak.team ?? null,
        spread: weak.spread ?? null,
        price: weak.price ?? null,
        probability: Number(weak.prob),
        matchup: weak.matchup ?? null
      };
    }

    // --- Stake sugerido para un parlay ---
    // Kelly del parlay multiplicado por un factor de seguridad y con tope de % bankroll.
    function parlayStakeFromKelly(prob, oddsDecimal) {
      const p = Number(prob);
      const dec = Number(oddsDecimal);
      if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(dec) || dec <= 1) {
        return { stakePct: 0, stakeUnits: 0, kellyFull: 0 };
      }
      const priceParlay = decimalToAmerican(dec);
      if (!priceParlay) return { stakePct: 0, stakeUnits: 0, kellyFull: 0 };
      const kellyFullParlay = calculateKelly(p, priceParlay); // ya es Kelly fraccional, en %
      const kAdj = kellyFullParlay * PARLAY_KELLY_FACTOR;
      const stakePct = clamp(kAdj, 0, PARLAY_MAX_STAKE_PCT);
      const bankroll = Math.max(0, Number(state.bankroll) || 0);
      return {
        stakePct,
        stakeUnits: (stakePct / 100) * bankroll,
        kellyFull: kellyFullParlay
      };
    }

    function estimateAltPrice(marketPrice, points) {
      const pts = Number(points);
      if (!Number.isFinite(pts) || pts <= 0) return Number(marketPrice);
      const dec = americanOddsToDecimal(marketPrice);
      if (!Number.isFinite(dec)) return null;
      return americanFromDecimal(Math.max(1.01, dec - pts * PARLAY_ALT_DECIMAL_COST));
    }

    function buildAltLines(margins, isHome, marketSpread, marketPrice) {
      if (!Array.isArray(margins) || !margins.length ||
          !Number.isFinite(marketSpread) || !Number.isFinite(marketPrice)) {
        return [];
      }
      return PARLAY_ALT_SPREAD_STEPS.map(points => {
        const spread = marketSpread + points;
        const probability = coverProbabilityFromMargins(margins, isHome, spread);
        const price = points === 0 ? marketPrice : estimateAltPrice(marketPrice, points);
        if (probability == null || !Number.isFinite(price)) return null;
        return {
          points,
          spread,
          price,
          probability,
          evUnits: calculateEVUnits(probability, price),
          estimatedPrice: points > 0
        };
      }).filter(Boolean);
    }

    function evaluateOfferForSide(offer, isHome, expectedHomeMargin, margins) {
      const spread = isHome ? offer.homeSpread : -offer.homeSpread;
      const price = isHome ? offer.homePrice : offer.awayPrice;
      if (!Number.isFinite(spread) || !Number.isFinite(price)) return null;
      const sideMean = isHome ? expectedHomeMargin : -expectedHomeMargin;
      const coverProb = coverProbabilityFromMargins(margins, isHome, spread);
      if (coverProb == null) return null;
      const { homeNoVig, awayNoVig } = removeVigTwoWay(offer.homePrice, offer.awayPrice);
      return {
        offerId: offer.id,
        provider: offer.provider,
        pickSpread: spread,
        price,
        lineEdge: sideMean + spread,
        coverProb,
        noVig: isHome ? homeNoVig : awayNoVig,
        evUnits: calculateEVUnits(coverProb, price),
        kelly: calculateKelly(coverProb, price)
      };
    }

    function mergeBookOffers(baseOffers, extraOffers) {
      const map = new Map();
      for (const offer of baseOffers || []) {
        if (!offer) continue;
        const key = normalizeBookKey(offer.provider);
        if (key && !map.has(key)) map.set(key, offer);
      }
      for (const offer of extraOffers || []) {
        if (!offer) continue;
        const key = normalizeBookKey(offer.provider);
        if (!key) continue;
        const existing = map.get(key);
        if (!existing || offer.lineValid) map.set(key, offer);
      }
      return Array.from(map.values());
    }

    // Núcleo Monte Carlo. Extraído de simulateGame sin cambios de lógica ni de
    // orden de consumo del RNG: primero el margen y después el total.
    function runSimulationLoop({
      SIMS, sportId, mlbMeans, expectedHomeMargin, simStdDev, nbaInputs,
      marketHomeSpread, totalLine, rng, totalRng
    }) {
      let homeWins = 0, homeCovers = 0, awayCovers = 0, pushes = 0;
      let homeMLWins = 0, awayMLWins = 0;
      let homeRL15Cover = 0, awayRL15Cover = 0;
      let totalOverHits = 0, totalUnderHits = 0, totalPushes = 0;
      const margins = [];
      const homeScores = [];
      const awayScores = [];
      let favWinNoCoverCount = 0;

      for (let i = 0; i < SIMS; i++) {
        let m = 0;
        let homeScoreSim = 0;
        let awayScoreSim = 0;
        let totalSim = null;

        if (sportId === "MLB") {
          homeScoreSim = samplePoisson(mlbMeans.home, rng);
          awayScoreSim = samplePoisson(mlbMeans.away, rng);
          m = homeScoreSim - awayScoreSim;
          totalSim = homeScoreSim + awayScoreSim;
        } else {
          m = expectedHomeMargin + randomNormal(rng) * simStdDev;
          // El total sigue una normal alrededor de la base del deporte; se
          // deriva cada puntaje del total y del margen simulado.
          const baseTotal = sportId === "NBA" && nbaInputs?.expectedTotal != null
            ? nbaInputs.expectedTotal
            : (TOTAL_BASE[sportId] ?? TOTAL_FALLBACK);
          const totalSd = TOTAL_SD[sportId] ?? baseTotal * 0.08;
          totalSim = Math.max(0, baseTotal + randomNormal(totalRng) * totalSd);
          homeScoreSim = (totalSim + m) / 2;
          awayScoreSim = totalSim - homeScoreSim;
        }

        if (m > 0) homeWins++;

        if (Number.isFinite(marketHomeSpread)) {
          const ats = m + marketHomeSpread;
          if (ats > 0.0001) homeCovers++;
          else if (ats < -0.0001) awayCovers++;
          else pushes++;
          const favoriteIsHome = marketHomeSpread < 0;
          if (favoriteIsHome) {
            if (m > 0 && ats <= 0.0001) favWinNoCoverCount++;
          } else if (marketHomeSpread > 0) {
            const marginVisitor = -m;
            const spreadVisitor = -marketHomeSpread;
            const atsFav = marginVisitor + spreadVisitor;
            if (marginVisitor > 0 && atsFav <= 0.0001) favWinNoCoverCount++;
          }
        }

        if (sportId === "MLB") {
          if (homeScoreSim > awayScoreSim) homeMLWins++;
          else if (awayScoreSim > homeScoreSim) awayMLWins++;
          const margin = homeScoreSim - awayScoreSim;
          if (margin - 1.5 > 0) homeRL15Cover++;
          if (margin + 1.5 < 0) awayRL15Cover++;
        }

        if (totalLine != null && totalSim != null) {
          if (totalSim > totalLine + 0.0001) totalOverHits++;
          else if (totalSim < totalLine - 0.0001) totalUnderHits++;
          else totalPushes++;
        }

        margins.push(m);
        homeScores.push(homeScoreSim);
        awayScores.push(awayScoreSim);
      }

      return {
        homeWins, homeCovers, awayCovers, pushes,
        homeMLWins, awayMLWins, homeRL15Cover, awayRL15Cover,
        totalOverHits, totalUnderHits, totalPushes,
        margins, homeScores, awayScores, favWinNoCoverCount
      };
    }

    // Probabilidades Over/Under a partir de los conteos, ignorando empates.
    function deriveTotalsMarket(totalLine, overHits, underHits) {
      const empty = {
        overProb: null, underProb: null,
        overPrice: null, underPrice: null,
        overEV: null, underEV: null
      };
      if (totalLine == null) return empty;
      const decisions = overHits + underHits;
      if (decisions <= 0) return empty;
      const overProb = overHits / decisions;
      const underProb = underHits / decisions;
      return {
        overProb,
        underProb,
        overPrice: TOTAL_MVP_PRICE,
        underPrice: TOTAL_MVP_PRICE,
        overEV: calculateEVUnits(overProb, TOTAL_MVP_PRICE),
        underEV: calculateEVUnits(underProb, TOTAL_MVP_PRICE)
      };
    }

    function isManualAmericanPrice(value) {
      const n = Number(value);
      return Number.isFinite(n) && Math.abs(n) >= 100 && Math.abs(n) <= 1000;
    }

    // P(Over)/P(Under) empíricas para el puntaje de un equipo. Los empates
    // exactos con la línea se excluyen del denominador, igual que en los
    // totales del partido.
    function teamScoreOverUnderProbabilities(samples, line) {
      if (!Array.isArray(samples) || !samples.length || !Number.isFinite(line)) {
        return { overProb: null, underProb: null };
      }
      let over = 0, under = 0;
      for (const value of samples) {
        const score = Number(value);
        if (!Number.isFinite(score)) continue;
        if (score > line + 0.0001) over++;
        else if (score < line - 0.0001) under++;
      }
      const decisions = over + under;
      if (decisions <= 0) return { overProb: null, underProb: null };
      return { overProb: over / decisions, underProb: under / decisions };
    }

    function normalizeManualTeamTotalSide(raw) {
      const rawLine = raw?.line;
      const line = rawLine == null || rawLine === "" ? null : Number(rawLine);
      return {
        line: Number.isFinite(line) ? line : null,
        priceOver: isManualAmericanPrice(raw?.priceOver) ? Number(raw.priceOver) : null,
        priceUnder: isManualAmericanPrice(raw?.priceUnder) ? Number(raw.priceUnder) : null
      };
    }

    // Estructura manual por partido. Solo línea y cuotas son entradas; las
    // probabilidades/EV se recalculan con las muestras de Monte Carlo.
    function computeTeamTotals(rawTeamTotals, samples) {
      const home = normalizeManualTeamTotalSide(rawTeamTotals?.home);
      const away = normalizeManualTeamTotalSide(rawTeamTotals?.away);
      const homeProbs = teamScoreOverUnderProbabilities(samples?.home, home.line);
      const awayProbs = teamScoreOverUnderProbabilities(samples?.away, away.line);
      return {
        home,
        away,
        homeProbOver: homeProbs.overProb,
        homeProbUnder: homeProbs.underProb,
        homeEVOver: homeProbs.overProb != null && home.priceOver != null
          ? calculateEVUnits(homeProbs.overProb, home.priceOver)
          : null,
        homeEVUnder: homeProbs.underProb != null && home.priceUnder != null
          ? calculateEVUnits(homeProbs.underProb, home.priceUnder)
          : null,
        awayProbOver: awayProbs.overProb,
        awayProbUnder: awayProbs.underProb,
        awayEVOver: awayProbs.overProb != null && away.priceOver != null
          ? calculateEVUnits(awayProbs.overProb, away.priceOver)
          : null,
        awayEVUnder: awayProbs.underProb != null && away.priceUnder != null
          ? calculateEVUnits(awayProbs.underProb, away.priceUnder)
          : null
      };
    }

    // Medias de carreras MLB (movida desde api.js para que el Worker tenga el
    // modelo completo sin cargar la capa de red).
    function computeMlbRunMeans(inputs, homeStrength, awayStrength, baseRuns) {
      if (!inputs) {
        return {
          home: Math.max(0.5, baseRuns + homeStrength * 0.08),
          away: Math.max(0.5, baseRuns + awayStrength * 0.08)
        };
      }
      const homePitcherQuality = inputs.homePitcher?.quality ?? 0;
      const awayPitcherQuality = inputs.awayPitcher?.quality ?? 0;
      let home = baseRuns + homeStrength * 0.08;
      let away = baseRuns + awayStrength * 0.08;
      home -= awayPitcherQuality * 0.35;
      away -= homePitcherQuality * 0.35;
      home += (inputs.homeOffAdj ?? 0) - (inputs.awayDefAdj ?? 0);
      away += (inputs.awayOffAdj ?? 0) - (inputs.homeDefAdj ?? 0);
      home -= (inputs.awayBullpenAdj ?? 0) * 0.15;
      away -= (inputs.homeBullpenAdj ?? 0) * 0.15;
      const park = inputs.park ?? 1;
      const weather = inputs.weatherFactor ?? 1;
      home *= park * weather;
      away *= park * weather;
      return { home: clamp(home, 1.5, 8), away: clamp(away, 1.5, 8) };
    }

    // Fuerza de equipo (movida aquí desde api.js para que el Worker tenga el
    // modelo completo sin cargar la capa de red).
    function calculateTeamStrength(team, standingsMap, sportConfig) {
      const rec = parseRecord(team.record);
      let stats = standingsMap.get(String(team.id)) ||
                  standingsMap.get(String(team.abbreviation).toUpperCase()) || {};
      const games = Math.max(stats.games || 0, rec.games || 0);
      const wp = Number.isFinite(stats.winPercentage) ? stats.winPercentage : rec.winPercentage;
      const regWeight = games / (games + (sportConfig.earlySeasonRegGames || 0));
      const regWP = 0.5 + (wp - 0.5) * regWeight;
      const scale = sportConfig.id === "MLB" ? 9.5 : 22;
      const recRating = (regWP - 0.5) * scale;
      if (Number.isFinite(stats.differential)) {
        const regDiff = stats.differential * regWeight;
        const diffScale = sportConfig.id === "MLB" ? 0.85 : 0.75;
        return clamp(regDiff * diffScale + recRating * (1 - diffScale), -14, 14);
      }
      return clamp(recRating, -10, 10);
    }

    function simulateGame(game, standingsMap, sportConfig, riskProfile, kellyContext = null, runtime = {}) {
      let awayStrength = calculateTeamStrength(game.away, standingsMap, sportConfig);
      let homeStrength = calculateTeamStrength(game.home, standingsMap, sportConfig);

      if (!Number.isFinite(homeStrength)) homeStrength = 0;
      if (!Number.isFinite(awayStrength)) awayStrength = 0;

      let expectedHomeMargin = homeStrength - awayStrength + sportConfig.homeAdvantageBase;
      if (sportConfig.id === "NBA") {
        if (game.homeB2B) expectedHomeMargin -= sportConfig.b2bPenalty;
        if (game.awayB2B) expectedHomeMargin += sportConfig.b2bPenalty;
      }
      expectedHomeMargin = clamp(expectedHomeMargin, -22, 22);
      const nbaInputs = sportConfig.id === "NBA" && game.modelInputs?.type === "NBA" ? game.modelInputs : null;
      if (nbaInputs) {
        expectedHomeMargin = clamp(
          expectedHomeMargin * 0.65 + nbaInputs.effMargin * 0.35 + nbaInputs.injuryAdjustment,
          -22,
          22
        );
      }
      const simStdDev = nbaInputs ? sportConfig.stdDev * nbaInputs.varianceFactor : sportConfig.stdDev;
      const fairHomeSpread = -expectedHomeMargin;

      const mlbInputs = sportConfig.id === "MLB" && game.modelInputs?.type === "MLB" ? game.modelInputs : null;
      const mlbMeans = sportConfig.id === "MLB"
        ? computeMlbRunMeans(mlbInputs, homeStrength, awayStrength, 4.5)
        : null;

      // `runtime` permite reutilizar la misma función dentro del Web Worker:
      //   dateKey       semilla estable (state.dateKey en el hilo principal)
      //   sims          nº de simulaciones (por defecto MONTE_CARLO.sims)
      //   minZOverride  override del filtro z (state.minZOverride en el hilo principal)
      const seedDateKey = runtime.dateKey ?? (typeof state !== "undefined" ? state.dateKey : "");
      const rng = createPRNG(hashString(`${sportConfig.id}-${seedDateKey}-${game.id}-${expectedHomeMargin.toFixed(4)}`));
      // RNG independiente para los totales: no altera la secuencia del margen.
      const totalRng = createPRNG(hashString(`${sportConfig.id}-${seedDateKey}-${game.id}-totals-${expectedHomeMargin.toFixed(4)}`));
      const SIMS = Number.isFinite(runtime.sims) && runtime.sims > 0
        ? Math.floor(runtime.sims)
        : (MONTE_CARLO.sims[sportConfig.id] ?? MONTE_CARLO.fallbackSims);
      const marketHomeSpread = game.market.homeSpread;
      const totalLine = Number.isFinite(game.market.total) ? game.market.total : null;
      const marketOffers = Array.isArray(game.market.offers) ? game.market.offers : [];
      const marketBlocked = game.market.dataValid === false ||
                            game.postponed === true ||
                            game.canceled === true ||
                            game.suspended === true;

      const { homeNoVig, awayNoVig } = removeVigTwoWay(game.market.homePrice, game.market.awayPrice);
      const marketHomeNoVig = homeNoVig;
      const marketAwayNoVig = awayNoVig;
      const totalNoVig = removeVigTwoWay(game.market.totalOverPrice, game.market.totalUnderPrice);
      const mlNoVig = removeVigTwoWay(game.market.mlHome, game.market.mlAway);

      const {
        homeWins, homeCovers, awayCovers, pushes,
        homeMLWins, awayMLWins, homeRL15Cover, awayRL15Cover,
        totalOverHits, totalUnderHits, totalPushes,
        margins, homeScores, awayScores, favWinNoCoverCount
      } = runSimulationLoop({
        SIMS,
        sportId: sportConfig.id,
        mlbMeans,
        expectedHomeMargin,
        simStdDev,
        nbaInputs,
        marketHomeSpread,
        totalLine,
        rng,
        totalRng
      });

      const homeWinProbability = homeWins / SIMS;

      let homeCoverProbability = null, awayCoverProbability = null, edge = null, edgeRelative = null;
      let selectedProbability = null, selectedPrice = null, recommendedTeam = null, recommendedSpread = null;
      let selectedNoVig = null, modelVsMarketPts = null;
      let consensusNoVig = null, consensusEdge = null, consensusBooks = 0;
      let zEdge = null;
      let kelly = 0, evUnits = 0, qualified = false, probTeaser4 = null, probTeaser7 = null, probFavWinNoCover = null;
      const minEdge = getEffectiveMinEdge(riskProfile, sportConfig);
      const minZ = getEffectiveMinZ(riskProfile, runtime.minZOverride);
      const kellyCap = kellyContext?.maxKelly ?? riskProfile.maxKelly;

      const consensusForSide = (isHomeSide, spread, prob) => {
        const byBook = new Map();
        for (const offer of marketOffers) {
          if (!offer?.lineValid) continue;
          const candidate = evaluateOfferForSide(offer, isHomeSide, expectedHomeMargin, margins);
          if (!candidate || !Number.isFinite(candidate.noVig)) continue;
          if (Math.abs(candidate.pickSpread - spread) > 0.011) continue;
          const key = normalizeBookKey(candidate.provider) || candidate.provider;
          if (!byBook.has(key)) byBook.set(key, candidate);
        }
        const list = [...byBook.values()];
        if (!list.length) return { noVig: null, edge: null, books: 0 };
        const avg = list.reduce((sum, c) => sum + c.noVig, 0) / list.length;
        return { noVig: avg, edge: Number.isFinite(prob) ? prob - avg : null, books: list.length };
      };

      if (Number.isFinite(marketHomeSpread) && game.market.lineValid) {
        const decisions = SIMS - pushes;
        homeCoverProbability = decisions > 0 ? homeCovers / decisions : 0.5;
        awayCoverProbability = decisions > 0 ? awayCovers / decisions : 0.5;
        const homeEdge = expectedHomeMargin + marketHomeSpread;
        const pickHome = homeEdge >= 0;
        edge = Math.abs(homeEdge);
        zEdge = edge / sportConfig.stdDev;
        const spreadAbs = Math.max(sportConfig.id === "MLB" ? 1.2 : 4, Math.abs(marketHomeSpread));
        edgeRelative = edge / spreadAbs;
        selectedProbability = pickHome ? homeCoverProbability : awayCoverProbability;
        selectedPrice = pickHome ? game.market.homePrice : game.market.awayPrice;
        selectedNoVig = pickHome ? homeNoVig : awayNoVig;
        modelVsMarketPts = selectedNoVig != null ? selectedProbability - selectedNoVig : null;
        recommendedTeam = pickHome ? game.home.abbreviation : game.away.abbreviation;
        recommendedSpread = pickHome ? marketHomeSpread : -marketHomeSpread;
        const consensus = consensusForSide(pickHome, recommendedSpread, selectedProbability);
        consensusNoVig = consensus.noVig;
        consensusEdge = consensus.edge;
        consensusBooks = consensus.books;
        const withinOdds = selectedPrice >= riskProfile.minOdds && selectedPrice <= riskProfile.maxOdds;
        kelly = withinOdds ? calculateKelly(selectedProbability, selectedPrice) : 0;
        kelly = clamp(kelly, 0, kellyCap);
        evUnits = withinOdds ? calculateEVUnits(selectedProbability, selectedPrice) : 0;
        qualified = !marketBlocked && withinOdds &&
          edge >= minEdge &&
          zEdge >= minZ &&
          edgeRelative >= riskProfile.minEdgeRelative &&
          selectedProbability >= riskProfile.minCoverProbability &&
          (consensusEdge == null || consensusEdge >= (riskProfile.minConsensusEdge ?? -1)) &&
          kelly >= riskProfile.minKelly;
        probFavWinNoCover = decisions > 0 ? favWinNoCoverCount / decisions : null;
      }

      // Comparación de casas: mejor oferta disponible para cada lado
      let bestLines = null;
      let bestLine = null;
      if (recommendedTeam && marketOffers.length) {
        const maxLineGap = sportConfig.id === "MLB" ? 0.5 : 1.5;
        const buildCandidates = (isHomeSide) => {
          const primarySideSpread = isHomeSide ? marketHomeSpread : -marketHomeSpread;
          return marketOffers
            .filter(o => o.lineValid)
            .map(o => evaluateOfferForSide(o, isHomeSide, expectedHomeMargin, margins))
            .filter(Boolean)
            .filter(c => Math.abs(c.pickSpread - primarySideSpread) <= maxLineGap + 1e-9)
            .sort((a, b) => {
              const aInRange = a.price >= riskProfile.minOdds && a.price <= riskProfile.maxOdds;
              const bInRange = b.price >= riskProfile.minOdds && b.price <= riskProfile.maxOdds;
              return (Number(bInRange) - Number(aInRange)) ||
                (b.evUnits - a.evUnits) ||
                (b.lineEdge - a.lineEdge) ||
                (b.price - a.price);
            });
        };
        bestLines = {
          home: buildCandidates(true)[0] || null,
          away: buildCandidates(false)[0] || null
        };
        const pickIsHome = recommendedTeam === game.home.abbreviation;
        const adopted = pickIsHome ? bestLines.home : bestLines.away;
        if (adopted) {
          const primaryPickPrice = pickIsHome ? game.market.homePrice : game.market.awayPrice;
          bestLine = {
            ...adopted,
            side: recommendedTeam,
            isHome: pickIsHome,
            primaryPrice: primaryPickPrice,
            primarySpread: recommendedSpread,
            priceDelta: adopted.price - primaryPickPrice,
            spreadDelta: adopted.pickSpread - recommendedSpread,
            improved: adopted.pickSpread > recommendedSpread + 1e-9 || adopted.price > primaryPickPrice
          };
          selectedProbability = adopted.coverProb;
          selectedPrice = adopted.price;
          selectedNoVig = adopted.noVig ?? null;
          modelVsMarketPts = selectedNoVig != null ? selectedProbability - selectedNoVig : null;
          recommendedSpread = adopted.pickSpread;
          edge = adopted.lineEdge;
          zEdge = edge / sportConfig.stdDev;
          edgeRelative = edge / Math.max(sportConfig.id === "MLB" ? 1.2 : 4, Math.abs(adopted.pickSpread));
          const consensus = consensusForSide(pickIsHome, recommendedSpread, selectedProbability);
          consensusNoVig = consensus.noVig;
          consensusEdge = consensus.edge;
          consensusBooks = consensus.books;
          const withinOdds = selectedPrice >= riskProfile.minOdds && selectedPrice <= riskProfile.maxOdds;
          kelly = clamp(withinOdds ? calculateKelly(selectedProbability, selectedPrice) : 0, 0, kellyCap);
          evUnits = withinOdds ? calculateEVUnits(selectedProbability, selectedPrice) : 0;
          qualified = !marketBlocked && withinOdds &&
            edge >= minEdge &&
            zEdge >= minZ &&
            edgeRelative >= riskProfile.minEdgeRelative &&
            selectedProbability >= riskProfile.minCoverProbability &&
            (consensusEdge == null || consensusEdge >= (riskProfile.minConsensusEdge ?? -1)) &&
            kelly >= riskProfile.minKelly;
        }
      }

      if (recommendedTeam && Number.isFinite(recommendedSpread)) {
        let coverT4 = 0, coverT7 = 0, usable = 0;
        for (const m of margins) {
          const marginPickTeam = recommendedTeam === game.home.abbreviation ? m : -m;
          const ats4 = marginPickTeam + (recommendedSpread + 4);
          const ats7 = marginPickTeam + (recommendedSpread + 7);
          if (ats4 > 0.0001) coverT4++;
          if (ats7 > 0.0001) coverT7++;
          usable++;
        }
        probTeaser4 = usable > 0 ? coverT4 / usable : null;
        probTeaser7 = usable > 0 ? coverT7 / usable : null;
      }

      margins.sort((a, b) => a - b);
      const p10 = percentile(margins, 0.10);
      const p50 = percentile(margins, 0.50);
      const p90 = percentile(margins, 0.90);
      const marginSamples = downsampleSortedSamples(margins);
      homeScores.sort((a, b) => a - b);
      awayScores.sort((a, b) => a - b);
      const teamScoreSamples = {
        home: downsampleSortedSamples(homeScores, TEAM_TOTAL_SAMPLES),
        away: downsampleSortedSamples(awayScores, TEAM_TOTAL_SAMPLES)
      };
      const teamTotals = computeTeamTotals(game.teamTotals, teamScoreSamples);
      const altLines = recommendedTeam && Number.isFinite(recommendedSpread) && Number.isFinite(selectedPrice)
        ? buildAltLines(margins, recommendedTeam === game.home.abbreviation, recommendedSpread, selectedPrice)
        : [];
      let pickResult = "PENDING";
      const isFinal = game.completed || 
                      (game.statusName || "").includes("FINAL") ||
                      (game.status || "").toLowerCase().includes("final");
      if (isFinal && Number.isFinite(game.homeScore) && Number.isFinite(game.awayScore)) {
        const finalMarginHome = game.homeScore - game.awayScore;
        if (recommendedTeam && Number.isFinite(recommendedSpread) && game.market.lineValid) {
          const pickMargin = recommendedTeam === game.home.abbreviation ? finalMarginHome : -finalMarginHome;
          const atsFinal = pickMargin + recommendedSpread;
          if (atsFinal > 0.05) pickResult = "WIN";
          else if (atsFinal < -0.05) pickResult = "LOSS";
          else pickResult = "PUSH";
        } else {
          const modelHome = expectedHomeMargin >= 0;
          const actualHomeWon = finalMarginHome > 0;
          const actualAwayWon = finalMarginHome < 0;
          if ((modelHome && actualHomeWon) || (!modelHome && actualAwayWon)) {
            pickResult = "WIN";
          } else if (finalMarginHome === 0) {
            pickResult = "PUSH";
          } else {
            pickResult = "LOSS";
          }
          if (!recommendedTeam) recommendedTeam = modelHome ? game.home.abbreviation : game.away.abbreviation;
        }
      }
      // Live status
      let liveStatus = null;
      let liveCoverProb = null;
      const statusStr = (game.statusName || "") + " " + (game.status || "");
      const isLive = !isFinal && Number.isFinite(game.homeScore) && Number.isFinite(game.awayScore) &&
                     (statusStr.toUpperCase().includes("IN_PROGRESS") || 
                      statusStr.toUpperCase().includes("HALFTIME") ||
                      statusStr.toUpperCase().includes("END OF") ||
                      (game.awayScore > 0 || game.homeScore > 0));
      if (isLive) {
        const currentMarginHome = game.homeScore - game.awayScore;
        let pickSide = recommendedTeam;
        let spreadToUse = recommendedSpread;
        if (!pickSide) {
          pickSide = expectedHomeMargin >= 0 ? game.home.abbreviation : game.away.abbreviation;
          spreadToUse = 0;
        }
        if (pickSide) {
          const currentMarginPick = pickSide === game.home.abbreviation ? currentMarginHome : -currentMarginHome;
          const currentATS = currentMarginPick + (Number.isFinite(spreadToUse) ? spreadToUse : 0);
          if (currentATS > 0.1) liveStatus = "COVERING";
          else if (currentATS < -0.1) liveStatus = "NOT_COVERING";
          else liveStatus = "PUSHING";
          const preProb = selectedProbability || (expectedHomeMargin >= 0 ? 0.55 : 0.45);
          const positionFactor = Math.max(0.1, Math.min(0.9, 0.5 + currentATS / (sportConfig.stdDev * 1.2)));
          liveCoverProb = clamp(preProb * 0.35 + positionFactor * 0.65, 0.05, 0.95);
        }
      }

      // Probabilidades MLB adicionales
      let mlHomeProb = null, mlAwayProb = null;
      let rlHomeMinus15Prob = null, rlAwayPlus15Prob = null;

      if (sportConfig.id === "MLB") {
        const mlTotal = homeMLWins + awayMLWins;
        if (mlTotal > 0) {
          mlHomeProb = homeMLWins / mlTotal;
          mlAwayProb = awayMLWins / mlTotal;
        }
        if (SIMS > 0) {
          rlHomeMinus15Prob = homeRL15Cover / SIMS;
          rlAwayPlus15Prob = awayRL15Cover / SIMS;
        }
      }

      const totals = deriveTotalsMarket(totalLine, totalOverHits, totalUnderHits);
      const overProb = totals.overProb;
      const underProb = totals.underProb;
      const overPrice = totals.overPrice;
      const underPrice = totals.underPrice;
      const overEV = totals.overEV;
      const underEV = totals.underEV;
      const totalOverProb = overProb;
      const totalUnderProb = underProb;

      return {
        ...game,
        awayStrength,
        homeStrength,
        expectedHomeMargin,
        simStdDev,
        modelExpectedTotal: mlbMeans
          ? mlbMeans.home + mlbMeans.away
          : (nbaInputs?.expectedTotal ?? null),
        fairHomeSpread,
        projectedWinner: expectedHomeMargin >= 0 ? game.home.abbreviation : game.away.abbreviation,
        projectedMargin: Math.abs(expectedHomeMargin),
        homeWinProbability,
        homeCoverProbability,
        awayCoverProbability,
        edge,
        edgeRelative,
        zEdge,
        selectedProbability,
        selectedPrice,
        recommendedTeam,
        recommendedSpread,
        altLines,
        bestLines,
        bestLine,
        kelly,
        kellyCap,
        evUnits,
        qualified,
        minZ,
        seasonProgress: kellyContext?.seasonProgress ?? null,
        drawdownUnits: kellyContext?.drawdownUnits ?? 0,
        marginP10: p10,
        marginP50: p50,
        marginP90: p90,
        marginSamples,
        teamScoreSamples,
        teamTotals,
        probTeaser4,
        probTeaser7,
        probFavWinNoCover,
        pickResult,
        liveStatus,
        liveCoverProb,
        marketHomeNoVig,
        marketAwayNoVig,
        selectedNoVig,
        modelVsMarketPts,
        consensusNoVig,
        consensusEdge,
        consensusBooks,
        totalOverNoVig: totalNoVig.homeNoVig,
        totalUnderNoVig: totalNoVig.awayNoVig,
        mlHomeNoVig: mlNoVig.homeNoVig,
        mlAwayNoVig: mlNoVig.awayNoVig,
        marketBlocked,
        mlHomeProb,
        mlAwayProb,
        rlHomeMinus15Prob,
        rlAwayPlus15Prob,
        totalOverProb,
        totalUnderProb,
        totalLine,
        overProb,
        underProb,
        overPrice,
        underPrice,
        overEV,
        underEV,
        totalPushes
      };
    }

    function combinationsOf(items, size) {
      const out = [];
      const build = (start, acc) => {
        if (acc.length === size) {
          out.push(acc.slice());
          return;
        }
        for (let i = start; i < items.length; i++) {
          acc.push(items[i]);
          build(i + 1, acc);
          acc.pop();
        }
      };
      build(0, []);
      return out;
    }

    function countCombinations(n, k) {
      if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0;
      const width = Math.min(k, n - k);
      let result = 1;
      for (let i = 1; i <= width; i++) {
        result = result * (n - width + i) / i;
      }
      return Math.round(result);
    }

    function buildParlayFromLegs(legs) {
      if (!Array.isArray(legs) || legs.length < 2) return null;
      let prob = 1;
      let oddsDecimal = 1;
      for (const leg of legs) {
        const p = Number(leg.prob);
        const dec = americanOddsToDecimal(leg.price);
        if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
        if (!Number.isFinite(dec) || dec <= 1) return null;
        prob *= p;
        oddsDecimal *= dec;
      }
      const evUnits = prob * (oddsDecimal - 1) - (1 - prob);
      const stake = parlayStakeFromKelly(prob, oddsDecimal);
      return {
        legs,
        prob,
        oddsDecimal,
        evUnits,
        category: classifyParlay(prob, evUnits),
        weakLeg: findWeakLeg(legs),
        stakePct: stake.stakePct,
        stakeUnits: stake.stakeUnits
      };
    }

    // Construye TODAS las opciones de leg para un partido explorando ambos
    // lados (local y visitante): línea base de mercado de cada lado, línea del
    // pick individual (si adoptó otra), dos spreads conservadores por base
    // generados con marginSamples (misma cuota base, MVP) y spreads alternativos
    // del proveedor con su cuota real por lado. Las probabilidades se estiman
    // con márgenes simulados sin repetir Monte Carlo.
    function buildParlayLegOptionsForGame(game) {
      if (!game?.home?.abbreviation || !game?.away?.abbreviation) return [];
      const homeAbbr = game.home.abbreviation;
      const awayAbbr = game.away.abbreviation;
      const market = game.market || {};
      const margins = Array.isArray(game.marginSamples) && game.marginSamples.length
        ? game.marginSamples
        : null;
      const marketHomeSpread = market.homeSpread == null ? null : toNumber(market.homeSpread);
      const marketHomePrice = market.homePrice == null ? null : toNumber(market.homePrice);
      const marketAwayPrice = market.awayPrice == null ? null : toNumber(market.awayPrice);
      const homeModelProb = game.homeCoverProbability == null ? null : toNumber(game.homeCoverProbability);
      const awayModelProb = game.awayCoverProbability == null ? null : toNumber(game.awayCoverProbability);
      const recommendedTeam = game.recommendedTeam === homeAbbr ? homeAbbr
        : game.recommendedTeam === awayAbbr ? awayAbbr
        : null;

      const altSpreads = Array.isArray(game.altMarkets?.altSpreads)
        ? game.altMarkets.altSpreads
        : [];
      const spreadKeys = { home: new Set(), away: new Set() };
      const options = [];
      const step = state.sport?.id === "MLB" ? 1 : 2;
      const safeSteps = 2;

      const estimateProb = (isHome, spread) => {
        if (margins) {
          const p = estimateCoverProbForSide(game, spread, isHome ? homeAbbr : awayAbbr);
          if (Number.isFinite(p)) return p;
        }
        return coverProbabilityFromModel(game, isHome, spread);
      };

      const addOption = (isHome, spread, price, prob, meta) => {
        const s = Number(spread);
        const pr = Number(price);
        const p = Number(prob);
        if (!Number.isFinite(s) || !Number.isFinite(pr) || pr === 0) return;
        if (!Number.isFinite(americanOddsToDecimal(pr))) return;
        if (!Number.isFinite(p) || p <= 0 || p >= 1) return;
        options.push({
          spread: s,
          price: pr,
          prob: p,
          source: meta.source,
          origin: meta.origin,
          priceEstimated: meta.priceEstimated === true,
          isAlt: meta.source === "ALT",
          team: isHome ? homeAbbr : awayAbbr,
          isHome,
          evUnits: calculateEVUnits(p, pr)
        });
        (isHome ? spreadKeys.home : spreadKeys.away).add(s.toFixed(3));
      };

      const buildSide = (isHome) => {
        const team = isHome ? homeAbbr : awayAbbr;
        const isRecommended = recommendedTeam === team;
        const marketSpread = Number.isFinite(marketHomeSpread)
          ? (isHome ? marketHomeSpread : -marketHomeSpread)
          : null;
        const marketPrice = isHome ? marketHomePrice : marketAwayPrice;
        const sideModelProb = isHome ? homeModelProb : awayModelProb;
        const keys = isHome ? spreadKeys.home : spreadKeys.away;
        const bases = [];

        // 1) Línea base de mercado del lado, siempre para local y visitante.
        if (Number.isFinite(marketSpread) && Number.isFinite(marketPrice) && marketPrice !== 0) {
          let marketProb = estimateProb(isHome, marketSpread);
          if (!Number.isFinite(marketProb)) marketProb = sideModelProb;
          addOption(isHome, marketSpread, marketPrice, marketProb, { source: "BASE", origin: "MARKET" });
          bases.push({ spread: marketSpread, price: marketPrice });
        }

        // 2) Línea del pick individual, si adoptó otra línea o cuota. Se
        // conserva como opción adicional para no perder mejoras de singles.
        if (isRecommended && game.recommendedSpread != null) {
          const pickSpread = toNumber(game.recommendedSpread);
          let pickPrice = game.selectedPrice == null ? null : toNumber(game.selectedPrice);
          if (!Number.isFinite(pickPrice) || pickPrice === 0) pickPrice = marketPrice;
          let pickProb = game.selectedProbability == null ? null : toNumber(game.selectedProbability);
          if (!Number.isFinite(pickProb) || pickProb <= 0 || pickProb >= 1) {
            pickProb = estimateProb(isHome, pickSpread);
          }
          if (!Number.isFinite(pickProb)) pickProb = sideModelProb;
          const sameAsMarket = bases.some(base =>
            Math.abs(base.spread - pickSpread) < 0.001 && base.price === pickPrice);
          if (Number.isFinite(pickSpread) && Number.isFinite(pickPrice) && !sameAsMarket) {
            addOption(isHome, pickSpread, pickPrice, pickProb, { source: "BASE", origin: "PICK" });
            bases.push({ spread: pickSpread, price: pickPrice });
          }
        }

        // 3) Spreads alternativos del proveedor, con cuota real para cada lado.
        for (const line of altSpreads) {
          const altHomeSpread = line?.spread == null ? null : toNumber(line.spread);
          if (!Number.isFinite(altHomeSpread)) continue;
          const sideSpread = isHome ? altHomeSpread : -altHomeSpread;
          const altPrice = isHome
            ? (line?.homePrice == null ? null : toNumber(line.homePrice))
            : (line?.awayPrice == null ? null : toNumber(line.awayPrice));
          if (!Number.isFinite(sideSpread) || !Number.isFinite(altPrice) || altPrice === 0) continue;
          if (!Number.isFinite(americanOddsToDecimal(altPrice))) continue;
          const altProb = estimateProb(isHome, sideSpread);
          if (!Number.isFinite(altProb) || altProb <= 0 || altProb >= 1) continue;
          addOption(isHome, sideSpread, altPrice, altProb, { source: "ALT", origin: "PROVIDER" });
        }

        // 4) Dos líneas conservadoras por base (spread + paso, +2 pasos) con la
        // misma cuota base (MVP). Si el proveedor ya ofrece esa línea, se
        // conserva su cuota real en lugar de duplicarla.
        if (!margins) return;
        for (const base of bases) {
          for (let i = 1; i <= safeSteps; i++) {
            const spreadAlt = base.spread + step * i;
            if (!Number.isFinite(spreadAlt)) continue;
            const key = spreadAlt.toFixed(3);
            if (keys.has(key)) continue;
            const probAlt = estimateCoverProbForSide(game, spreadAlt, team);
            if (!Number.isFinite(probAlt) || probAlt <= 0 || probAlt >= 1) continue;
            addOption(isHome, spreadAlt, base.price, probAlt, {
              source: "ALT",
              origin: "MODEL",
              priceEstimated: true
            });
          }
        }
      };

      buildSide(true);
      buildSide(false);

      return options;
    }

    // Elige la línea del parlay. Primero toma las opciones "seguras"
    // (prob >= 60%) con EV >= PARLAY_LEG_MIN_EV y devuelve la de mayor
    // probabilidad; si no hay ninguna, devuelve la de mayor EV. Puede ser
    // local o visitante, con spread + o -.
    function pickBestLegForParlay(options) {
      if (!Array.isArray(options) || !options.length) return null;
      const valid = options
        .map(option => {
          const spread = option?.spread == null ? null : toNumber(option.spread);
          const price = option?.price == null ? null : toNumber(option.price);
          const prob = option?.prob == null ? null : toNumber(option.prob);
          if (!Number.isFinite(spread) || !Number.isFinite(price) || price === 0) return null;
          if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
          if (!Number.isFinite(americanOddsToDecimal(price))) return null;
          return {
            ...option,
            spread,
            price,
            prob,
            evUnits: calculateEVUnits(prob, price)
          };
        })
        .filter(Boolean);
      if (!valid.length) return null;

      const safe = valid.filter(option =>
        option.prob >= PARLAY_LEG_SAFE_PROB && option.evUnits >= PARLAY_LEG_MIN_EV);
      const pool = safe.length ? safe : valid;
      pool.sort(safe.length
        ? (a, b) => (b.prob - a.prob) || (b.evUnits - a.evUnits) || (b.price - a.price)
        : (a, b) => (b.evUnits - a.evUnits) || (b.prob - a.prob) || (b.price - a.price)
      );
      return pool[0];
    }

    // Elige el mejor leg del partido para un parlay. No usa recommendedTeam:
    // puede devolver el lado opuesto o un spread distinto si mejora P + cuota.
    function pickBestParlayLegForGame(game) {
      if (!game?.home?.abbreviation || !game?.away?.abbreviation) return null;
      const options = buildParlayLegOptionsForGame(game);
      const best = pickBestLegForParlay(options);
      if (!best) return null;
      const recommendedTeam = game.recommendedTeam === game.home.abbreviation
        ? game.home.abbreviation
        : game.recommendedTeam === game.away.abbreviation
          ? game.away.abbreviation
          : null;
      return {
        gameId: game.id,
        team: best.team,
        isHome: best.isHome,
        spread: best.spread,
        price: best.price,
        prob: best.prob,
        isAlt: best.source === "ALT",
        origin: best.origin || (best.source === "ALT" ? "PROVIDER" : "BASE"),
        priceEstimated: best.priceEstimated === true,
        oppositeSide: !!(recommendedTeam && best.team !== recommendedTeam),
        matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`
      };
    }

    // Filtro de calidad por pata: probabilidad individual y EV mínimos.
    function passesParlayQualityFilter(game) {
      if (!game) return false;
      return (game.selectedProbability ?? 0) >= PARLAY_MIN_PROB_PER_LEG &&
        (game.evUnits ?? 0) >= PARLAY_MIN_EV_PER_LEG;
    }

    // Construye la base de parlays aplicando, en orden:
    // 1) fuente PLAYS/ALL, 2) filtro de calidad, 3) orden por EV/kelly y
    // 4) recorte a los PARLAY_BASE_MAX_PLAYS mejores partidos.
    function getParlayCandidatePool(baseSet = state.parlayConfig.baseSet) {
      const games = Array.isArray(state.games) ? state.games : [];
      const pool = baseSet === "ALL"
        ? games.filter(game =>
            game?.market?.available === true &&
            game.market?.lineValid === true &&
            game.marketBlocked !== true)
        : games.filter(game => game?.qualified === true);

      const quality = pool.filter(passesParlayQualityFilter);
      const candidates = quality
        .map(game => ({ game, leg: pickBestParlayLegForGame(game) }))
        .filter(candidate => candidate.leg)
        .sort((a, b) => {
          const evA = a.game.evUnits ?? 0;
          const evB = b.game.evUnits ?? 0;
          return (evB - evA) ||
            ((b.game.kelly ?? 0) - (a.game.kelly ?? 0)) ||
            (b.leg.prob - a.leg.prob) ||
            (calculateEVUnits(b.leg.prob, b.leg.price) - calculateEVUnits(a.leg.prob, a.leg.price));
        });

      const capped = candidates.slice(0, PARLAY_BASE_MAX_PLAYS);
      return {
        candidates: capped,
        stats: {
          basePool: pool.length,
          qualityPassed: candidates.length,
          used: capped.length,
          capped: candidates.length > capped.length
        }
      };
    }

    function getParlayCandidates(baseSet = state.parlayConfig.baseSet) {
      return getParlayCandidatePool(baseSet).candidates;
    }

    function generateParlays() {
      const baseSet = state.parlayConfig.baseSet === "ALL" ? "ALL" : "PLAYS";
      state.parlayConfig.baseSet = baseSet;
      const poolInfo = getParlayCandidatePool(baseSet);
      const candidates = poolInfo.candidates;
      const totalGames = candidates.length;

      let size = Math.round(Number(state.parlayConfig.size));
      if (!Number.isFinite(size)) size = 2;
      size = totalGames >= 2 ? clamp(size, 2, totalGames) : 2;
      state.parlayConfig.size = size;

      const totalCombinations = countCombinations(totalGames, size);
      const meta = {
        baseSet,
        size,
        eligibleGames: totalGames,
        poolSize: totalGames,
        totalCombinations,
        generated: 0,
        truncated: false,
        limit: PARLAY_MAX_COMBINATIONS,
        basePool: poolInfo.stats.basePool,
        qualityPassed: poolInfo.stats.qualityPassed,
        capped: poolInfo.stats.capped,
        usedForCombos: poolInfo.stats.used
      };

      if (totalGames < 2 || size > totalGames) {
        state.parlays = [];
        state.parlayMeta = meta;
        return;
      }

      let pool = candidates;
      if (totalCombinations > PARLAY_MAX_COMBINATIONS) {
        let poolSize = totalGames;
        while (poolSize > size && countCombinations(poolSize, size) > PARLAY_MAX_COMBINATIONS) {
          poolSize--;
        }
        pool = candidates.slice(0, poolSize);
        meta.poolSize = pool.length;
        meta.truncated = true;
      }

      const allParlays = [];
      for (const combo of combinationsOf(pool, size)) {
        const parlay = buildParlayFromLegs(combo.map(candidate => candidate.leg));
        if (parlay) allParlays.push(parlay);
      }
      allParlays.sort((a, b) => (b.evUnits - a.evUnits) || (b.prob - a.prob) || (b.oddsDecimal - a.oddsDecimal));

      state.parlays = allParlays;
      meta.generated = allParlays.length;
      state.parlayMeta = meta;
    }

    // -----------------------------------------------------------------------
    // Player Props (fase 1: entrada manual, modelo normal)
    // -----------------------------------------------------------------------
    // P(Over) = 1 - Φ((línea - media) / sd). Fase 1 asume una distribución
    // continua: los empates (línea entera) no se modelan por separado.
    function normalCdf(z) {
      const sign = z < 0 ? -1 : 1;
      const ax = Math.abs(z) / Math.SQRT2;
      const t = 1 / (1 + 0.3275911 * ax);
      const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
      return 0.5 * (1 + sign * erf);
    }
    function createPlayerPropId() {
      return `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    function computePlayerProp({ mean, sd, line, priceOver, priceUnder }) {
      const z = (line - mean) / sd;
      const probOver = clamp(1 - normalCdf(z), 0, 1);
      const probUnder = clamp(1 - probOver, 0, 1);
      const overOk = isValidAmericanPrice(priceOver);
      const underOk = isValidAmericanPrice(priceUnder);
      const evOver = overOk ? calculateEVUnits(probOver, priceOver) : null;
      const evUnder = underOk ? calculateEVUnits(probUnder, priceUnder) : null;
      const stakeOver = overOk
        ? recommendedStakeUnits(calculateKelly(probOver, priceOver), state.bankroll, state.maxStakePerBetPct)
        : 0;
      const stakeUnder = underOk
        ? recommendedStakeUnits(calculateKelly(probUnder, priceUnder), state.bankroll, state.maxStakePerBetPct)
        : 0;
      return { probOver, probUnder, evOver, evUnder, stakeOver, stakeUnder };
    }
    function propsForCurrentSport() {
      return state.playerProps
        .filter(prop => prop.sportId === state.sport.id)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
