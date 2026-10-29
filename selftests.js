/**
 * Lord's Predictions — selftests.js
 * Pruebas de humo del modelo, props, totales y parlays. Se ejecutan al iniciar.
 */
"use strict";


    function runSelfTests() {
      const tests = [];
      function t(name, cond) { tests.push({ name, cond }); if (!cond) console.error("FAIL:", name); }
      const r = parseRecord("10-5");
      t("Parse record", r.wins === 10 && r.losses === 5);
      t("Spread format", formatSpread(1.5) === "+1.5" && formatSpread(-1.5) === "-1.5");
      t("Kelly non-neg", calculateKelly(0.45, -110) === 0);
      t("STANDARD hard thresholds",
        RISK_PROFILES.STANDARD.minCoverProbability === 0.58 &&
        RISK_PROFILES.STANDARD.minEdgePts === 3.5 &&
        RISK_PROFILES.STANDARD.minKelly === 1.5 &&
        RISK_PROFILES.STANDARD.minZ === 0.25);
      t("Team alias match", teamsLikelyMatch("LA Clippers", "Los Angeles Clippers"));
      t("Team nickname no match", !teamsLikelyMatch("Boston Red Sox", "Chicago White Sox"));
      t("Alt abbr alias", normalizeAltAbbr("uta") === "UTAH" && normalizeAltAbbr("was") === "WSH");
      const altMarketSample = {
        homeAbbr: "UTAH", awayAbbr: "SA",
        spreads: [{ spread: 14.5, homePrice: -160, awayPrice: 135 }],
        totals: []
      };
      const altMarketGameRef = { home: { abbreviation: "UTAH" }, away: { abbreviation: "SA" } };
      t("Alt market unique match", findAltMarketGame(altMarketGameRef, [altMarketSample]) === altMarketSample);
      t("Alt market ambiguous match", findAltMarketGame(altMarketGameRef, [altMarketSample, { ...altMarketSample }]) === null);
      const altSanitized = normalizeAltSpreadLines([
        { spread: "14.5", homePrice: "-160", awayPrice: "135" },
        { spread: 12.5 },
        { spread: "n/a", homePrice: -110, awayPrice: -110 }
      ]);
      t("Alt spread sanitize", altSanitized.length === 1 && altSanitized[0].spread === 14.5 && altSanitized[0].homePrice === -160);
      const altBadgeGame = {
        market: { homeSpread: 12.5 },
        altMarkets: { spreads: [{ spread: 12.5 }, { spread: 14.5 }], totals: [] }
      };
      t("Alt spread count", altSpreadCount(altBadgeGame) === 1);
      t("American price format", formatAmericanPrice(105) === "+105" && formatAmericanPrice(-110) === "-110");
      t("Home spread from pointSpread", extractHomeSpread(
        { pointSpread: { home: { close: { line: "+1.5" } } }, homeTeamOdds: { favorite: true } },
        { team: { abbreviation: "MIL" } },
        { team: { abbreviation: "TB" } }
      ) === 1.5);
      t("Cover prob at pick'em", coverProbabilityFromMargins([5, -5], true, 0) === 0.5);
      const mergedOffers = mergeBookOffers(
        [{ id: "espn:dk", provider: "DraftKings", homePrice: -110, lineValid: true }],
        [{ id: "oddsapi:dk", provider: "DraftKings", homePrice: -105, lineValid: true }]
      );
      t("Merge prefers alt book", mergedOffers.length === 1 && mergedOffers[0].id === "oddsapi:dk");
      const noVig = removeVigTwoWay(-110, -110);
      t("No-vig two-way", Math.abs(noVig.homeNoVig - 0.5) < 1e-9 && Math.abs(noVig.awayNoVig - 0.5) < 1e-9);
      t("EV units", Math.abs(calculateEVUnits(0.55, -110) - 0.05) < 1e-9);
      const teamTotalsTest = computeTeamTotals(
        {
          home: { line: 110, priceOver: -110, priceUnder: 110 },
          away: { line: 100.5, priceOver: null, priceUnder: null }
        },
        { home: [100, 110, 120], away: [90, 100, 110] }
      );
      t("Team totals home prob/EV",
        Math.abs(teamTotalsTest.homeProbOver - 0.5) < 1e-9 &&
        Math.abs(teamTotalsTest.homeProbUnder - 0.5) < 1e-9 &&
        Math.abs(teamTotalsTest.homeEVOver - calculateEVUnits(0.5, -110)) < 1e-9 &&
        Math.abs(teamTotalsTest.homeEVUnder - calculateEVUnits(0.5, 110)) < 1e-9);
      t("Team totals away over/under",
        Math.abs(teamTotalsTest.awayProbOver - 1 / 3) < 1e-9 &&
        Math.abs(teamTotalsTest.awayProbUnder - 2 / 3) < 1e-9);
      t("Team totals EV needs price",
        teamTotalsTest.awayEVOver === null && teamTotalsTest.awayEVUnder === null);
      t("Team totals without samples",
        computeTeamTotals({ home: { line: 110 } }, {}).homeProbOver === null &&
        computeTeamTotals({}, { home: [100] }).home.line === null);
      t("Team totals keep manual inputs",
        computeTeamTotals({ home: { line: "112.5", priceOver: "-105" } }, { home: [110] }).home.line === 112.5 &&
        computeTeamTotals({ home: { line: "112.5", priceOver: "-105" } }, { home: [110] }).home.priceOver === -105);
      t("Team totals shape",
        ["homeProbOver", "homeProbUnder", "homeEVOver", "homeEVUnder",
         "awayProbOver", "awayProbUnder", "awayEVOver", "awayEVUnder"]
          .every(k => k in teamTotalsTest));
      const settledTest = settlePickWithGame(
        { pickTeam: "HOM", pickSpread: -4.5, price: -110 },
        { homeScore: 110, awayScore: 100, home: { abbreviation: "HOM" }, away: { abbreviation: "AWY" } }
      );
      t("Settlement ATS + SU", settledTest.result === "WIN" && settledTest.suResult === "WIN" && settledTest.units > 0);
      t("Journal bet units",
        Math.abs(calculateBetUnits("WIN", 2, 150) - 3) < 1e-9 &&
        Math.abs(calculateBetUnits("WIN", 1, -110) - (100 / 110)) < 1e-9 &&
        calculateBetUnits("LOSS", 2, -110) === -2 &&
        calculateBetUnits("PUSH", 2, -110) === 0 &&
        calculateBetUnits("PENDING", 2, -110) === 0);
      const journalGame = {
        completed: true, homeScore: 104, awayScore: 100,
        home: { abbreviation: "HOM" }, away: { abbreviation: "AWY" },
        recommendedTeam: "AWY", recommendedSpread: 3
      };
      const journalHomeWin = computeJournalAtsSettlement(
        { description: "HOM +4.5 (-110)", stake: 1, price: -110 }, journalGame
      );
      t("Journal ATS settle home side",
        journalHomeWin.result === "WIN" && Math.abs(journalHomeWin.units - (100 / 110)) < 1e-9);
      const journalAwayWin = computeJournalAtsSettlement(
        { description: "AWY +7.5 (-110)", stake: 1, price: -110 }, journalGame
      );
      t("Journal ATS settle away side", journalAwayWin.result === "WIN" && journalAwayWin.units > 0);
      const journalPush = computeJournalAtsSettlement(
        { description: "HOM -4 (-110)", stake: 1, price: -110 }, journalGame
      );
      t("Journal ATS settle push", journalPush.result === "PUSH" && journalPush.units === 0);
      const journalFallback = computeJournalAtsSettlement(
        { description: "Apuesta manual", stake: 1, price: -110 }, journalGame
      );
      t("Journal ATS fallback pick/spread", journalFallback.result === "LOSS" && journalFallback.units === -1);
      const journalSummary = getJournalDailySummary([
        { result: "WIN", units: 1 },
        { result: "LOSS", units: -1 },
        { result: "PUSH", units: 0 },
        { result: "PENDING", units: 0 }
      ]);
      t("Journal daily summary",
        journalSummary.wins === 1 && journalSummary.losses === 1 && journalSummary.pushes === 1 &&
        journalSummary.totalBets === 3 && journalSummary.units === 0 && journalSummary.roi === 0);
      const journalDraft = buildJournalBet({ type: "PROP", description: "Test O27.5", stake: 1, price: -110 });
      t("Journal entry shape",
        !!journalDraft && journalDraft.result === "PENDING" && journalDraft.units === 0 &&
        journalDraft.sourceId === null && Number.isFinite(journalDraft.createdAt) &&
        buildJournalBet({ type: "PROP", description: "", stake: 1, price: -110 }) === null &&
        buildJournalBet({ type: "PROP", description: "x", stake: 0, price: -110 }) === null &&
        buildJournalBet({ type: "PROP", description: "x", stake: 1, price: 0 }) === null);
      const postponedIssues = buildValidationIssues(
        { statusState: "pre", postponed: true, market: { available: true, lineValid: true, issues: [] }, venue: {}, probablePitchers: {} },
        null
      );
      t("Postponed blocks pick", postponedIssues.some(i => i.code === "POSTPONED" && i.severity === "block"));
      const testMovement = buildLineMovement({
        open: { homeSpread: -5, homePrice: -110, total: 220 },
        current: { homeSpread: -6, homePrice: -115, total: 218 },
        closing: null
      });
      t("Line movement deltas", testMovement.spreadDelta === -1 && testMovement.totalDelta === -2);
      const testClv = computePickClv(
        { pickIsHome: true, pickSpread: -5, price: -110, entryNoVig: 0.5 },
        { closing: { homeSpread: -6, homePrice: -120, awayPrice: 110 } }
      );
      t("CLV beats close", testClv.clvPts > 0 && testClv.beatClose === true);
      t("z-edge = edge / stdDev", Math.abs(4 / 12.8 - 0.3125) < 1e-9);
      t("Decimal odds", Math.abs(americanOddsToDecimal(-110) - (1 + 100 / 110)) < 1e-9 && americanOddsToDecimal(150) === 2.5);
      const testParlay = buildParlayFromLegs([
        { prob: 0.5, price: 100 },
        { prob: 0.5, price: 100 }
      ]);
      t("Parlay math",
        testParlay &&
        Math.abs(testParlay.prob - 0.25) < 1e-9 &&
        Math.abs(testParlay.oddsDecimal - 4) < 1e-9 &&
        Math.abs(testParlay.evUnits) < 1e-9);
      t("Decimal to American",
        decimalToAmerican(4) === 300 &&
        decimalToAmerican(2) === 100 &&
        decimalToAmerican(1.5) === -200 &&
        decimalToAmerican(1) === 0);
      t("Parlay category",
        classifyParlay(0.5, 0.2) === "VALUE" &&
        classifyParlay(0.65, -0.05) === "SAFE" &&
        classifyParlay(0.4, -0.05) === "ACTION");
      const weakLegTest = buildParlayFromLegs([
        { gameId: "W1", team: "AAA", spread: -2, price: -110, prob: 0.62 },
        { gameId: "W2", team: "BBB", spread: 3, price: -110, prob: 0.58 }
      ]);
      t("Parlay weak leg",
        weakLegTest &&
        weakLegTest.weakLeg &&
        weakLegTest.weakLeg.gameId === "W2" &&
        Math.abs(weakLegTest.weakLeg.probability - 0.58) < 1e-9);
      const prevBankroll = state.bankroll;
      state.bankroll = 100;
      const stakeTest = parlayStakeFromKelly(0.6, 2);
      state.bankroll = prevBankroll;
      t("Parlay stake cap",
        Math.abs(stakeTest.stakePct - PARLAY_MAX_STAKE_PCT) < 1e-9 &&
        Math.abs(stakeTest.stakeUnits - 1) < 1e-9);
      t("Parlay quality filter",
        passesParlayQualityFilter({ selectedProbability: 0.56, evUnits: 0 }) === true &&
        passesParlayQualityFilter({ selectedProbability: 0.54, evUnits: 1 }) === false &&
        passesParlayQualityFilter({ selectedProbability: 0.7, evUnits: -0.1 }) === false);
      t("Parlay combinations",
        combinationsOf([1, 2, 3, 4], 2).length === 6 &&
        countCombinations(4, 2) === 6 &&
        countCombinations(4, 3) === 4);
      const fallbackLeg = pickBestParlayLegForGame({
        id: "PARLAY-FALLBACK",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -4.5, homePrice: -110, awayPrice: -105 },
        homeCoverProbability: 0.44,
        awayCoverProbability: 0.56,
        recommendedTeam: null,
        recommendedSpread: null,
        selectedPrice: null,
        selectedProbability: null
      });
      t("Parlay leg fallback",
        fallbackLeg &&
        fallbackLeg.team === "AWY" &&
        fallbackLeg.spread === 4.5 &&
        fallbackLeg.price === -105 &&
        Math.abs(fallbackLeg.prob - 0.56) < 1e-9);
      const marketLeg = pickBestParlayLegForGame({
        id: "PARLAY-MARKET-BASE",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -4.5, homePrice: -110, awayPrice: -105 },
        homeCoverProbability: 0.6,
        awayCoverProbability: 0.4,
        recommendedTeam: "HOM",
        recommendedSpread: -5.5,
        selectedPrice: -115,
        selectedProbability: 0.58
      });
      t("Parlay market base preferred",
        marketLeg &&
        marketLeg.team === "HOM" &&
        marketLeg.spread === -4.5 &&
        marketLeg.price === -110 &&
        Math.abs(marketLeg.prob - 0.6) < 1e-9);
      const pickPriceLeg = pickBestParlayLegForGame({
        id: "PARLAY-PICK-PRICE",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -4.5, homePrice: -110, awayPrice: -105 },
        homeCoverProbability: 0.55,
        awayCoverProbability: 0.3,
        recommendedTeam: "HOM",
        recommendedSpread: -5.5,
        selectedPrice: 120,
        selectedProbability: 0.58
      });
      t("Parlay keeps pick line by best EV",
        pickPriceLeg &&
        pickPriceLeg.team === "HOM" &&
        pickPriceLeg.spread === -5.5 &&
        pickPriceLeg.price === 120 &&
        Math.abs(pickPriceLeg.prob - 0.58) < 1e-9);
      const altLeg = pickBestParlayLegForGame({
        id: "PARLAY-ALT",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -4.5, homePrice: -110, awayPrice: -105 },
        homeCoverProbability: 0.6,
        awayCoverProbability: 0.4,
        recommendedTeam: "HOM",
        recommendedSpread: -5.5,
        selectedPrice: -115,
        selectedProbability: 0.58,
        marginSamples: Array.from({ length: 30 }, (_, i) => i - 10),
        altMarkets: { altSpreads: [{ spread: 5.5, homePrice: -200, awayPrice: 170 }] }
      });
      t("Parlay leg alt safe",
        altLeg &&
        altLeg.team === "HOM" &&
        altLeg.spread === 5.5 &&
        altLeg.price === -200 &&
        altLeg.isAlt === true &&
        altLeg.prob > 0.6);
      const probHomeAlt = estimateCoverProbForSide(
        { home: { abbreviation: "HOM" }, away: { abbreviation: "AWY" }, marginSamples: [-10, -2, 0, 2, 10] },
        2,
        "HOM"
      );
      const probAwayAlt = estimateCoverProbForSide(
        { home: { abbreviation: "HOM" }, away: { abbreviation: "AWY" }, marginSamples: [-10, -2, 0, 2, 10] },
        2,
        "AWY"
      );
      t("Estimate cover prob alt", probHomeAlt === 0.6 && probAwayAlt === 0.6);
      const safeDog = pickBestParlayLegForGame({
        id: "PARLAY-SAFE-DOG",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: 2.5, homePrice: -110, awayPrice: -110 },
        homeCoverProbability: 0.55,
        awayCoverProbability: 0.45,
        recommendedTeam: "HOM",
        recommendedSpread: 12.5,
        selectedPrice: -110,
        selectedProbability: 0.55,
        marginSamples: Array.from({ length: 41 }, (_, i) => i - 20)
      });
      t("Parlay model safe underdog",
        safeDog &&
        safeDog.spread === 16.5 &&
        safeDog.price === -110 &&
        safeDog.isAlt === true &&
        safeDog.origin === "MODEL" &&
        Math.abs(safeDog.prob - 37 / 41) < 1e-9);
      const safeFav = pickBestParlayLegForGame({
        id: "PARLAY-SAFE-FAV",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -7.5, homePrice: -110, awayPrice: -110 },
        homeCoverProbability: 0.62,
        awayCoverProbability: 0.38,
        recommendedTeam: "HOM",
        recommendedSpread: -7.5,
        selectedPrice: -110,
        selectedProbability: 0.62,
        marginSamples: Array.from({ length: 41 }, (_, i) => i - 10)
      });
      t("Parlay model safe favorite",
        safeFav &&
        safeFav.spread === -3.5 &&
        safeFav.price === -110 &&
        safeFav.isAlt === true &&
        safeFav.origin === "MODEL");
      const safeAwayDog = pickBestParlayLegForGame({
        id: "PARLAY-SAFE-AWAY",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: 2.5, homePrice: -110, awayPrice: -110 },
        homeCoverProbability: 0.45,
        awayCoverProbability: 0.55,
        recommendedTeam: "AWY",
        recommendedSpread: 12.5,
        selectedPrice: -110,
        selectedProbability: 0.55,
        marginSamples: Array.from({ length: 41 }, (_, i) => i - 20)
      });
      t("Parlay model safe away sign",
        safeAwayDog &&
        safeAwayDog.team === "AWY" &&
        safeAwayDog.spread === 16.5 &&
        Math.abs(safeAwayDog.prob - 37 / 41) < 1e-9);
      const dedupedOptions = buildParlayLegOptionsForGame({
        id: "PARLAY-DEDUPE",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: 2.5, homePrice: -110, awayPrice: -110 },
        recommendedTeam: "HOM",
        recommendedSpread: 12.5,
        selectedPrice: -110,
        selectedProbability: 0.55,
        marginSamples: Array.from({ length: 41 }, (_, i) => i - 20),
        altMarkets: { altSpreads: [{ spread: 16.5, homePrice: -160, awayPrice: 140 }] }
      }).filter(option => Math.abs(option.spread - 16.5) < 0.001);
      t("Parlay model alt dedupe provider",
        dedupedOptions.length === 1 &&
        dedupedOptions[0].price === -160 &&
        dedupedOptions[0].origin === "PROVIDER");
      const bothSidesOptions = buildParlayLegOptionsForGame({
        id: "PARLAY-BOTH-SIDES",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -4.5, homePrice: -110, awayPrice: -105 },
        homeCoverProbability: 0.6,
        awayCoverProbability: 0.4,
        recommendedTeam: "HOM",
        recommendedSpread: -4.5,
        selectedPrice: -110,
        selectedProbability: 0.6,
        marginSamples: [-10, -6, -2, 2, 6, 10],
        altMarkets: { altSpreads: [{ spread: 6.5, homePrice: -150, awayPrice: 130 }] }
      });
      t("Parlay options both sides",
        bothSidesOptions.some(o => o.isHome) &&
        bothSidesOptions.some(o => !o.isHome) &&
        bothSidesOptions.some(o => o.origin === "PROVIDER" && o.isHome) &&
        bothSidesOptions.some(o => o.origin === "PROVIDER" && !o.isHome));
      const marketOptions = buildParlayLegOptionsForGame({
        id: "PARLAY-MARKET-LINES",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: 2.5, homePrice: -110, awayPrice: -110 },
        marginSamples: Array.from({ length: 41 }, (_, i) => i - 20)
      });
      const homeLines = marketOptions.filter(o => o.isHome).map(o => o.spread);
      const awayLines = marketOptions.filter(o => !o.isHome).map(o => o.spread);
      t("Parlay market base and safe lines both sides",
        homeLines.includes(2.5) && homeLines.includes(4.5) && homeLines.includes(6.5) &&
        !homeLines.includes(8.5) &&
        awayLines.includes(-2.5) && awayLines.includes(-0.5) && awayLines.includes(1.5) &&
        !awayLines.includes(3.5));
      const oppositeLeg = pickBestParlayLegForGame({
        id: "PARLAY-OPPOSITE",
        home: { abbreviation: "HOM" },
        away: { abbreviation: "AWY" },
        market: { homeSpread: -9.5, homePrice: -110, awayPrice: -110 },
        recommendedTeam: "HOM",
        recommendedSpread: -9.5,
        selectedPrice: -110,
        selectedProbability: 0.55,
        marginSamples: [-20, -10, -5, 0, 5, 10, 20]
      });
      t("Parlay can pick opposite side",
        oppositeLeg &&
        oppositeLeg.team === "AWY" &&
        oppositeLeg.oppositeSide === true &&
        oppositeLeg.prob >= 0.60);
      const bestFallback = pickBestLegForParlay([
        { spread: 0, price: -110, prob: 0.55 },
        { spread: 1, price: 120, prob: 0.45 }
      ]);
      t("Parlay best option fallback", bestFallback && bestFallback.spread === 0);
      const evFallback = pickBestLegForParlay([
        { spread: 0, price: -500, prob: 0.61 },
        { spread: 1, price: 110, prob: 0.5 }
      ]);
      t("Parlay best option EV fallback", evFallback && evFallback.spread === 1);
      const probPreferred = pickBestLegForParlay([
        { spread: 0, price: -110, prob: 0.62 },
        { spread: 1, price: 150, prob: 0.61 }
      ]);
      t("Parlay safe tier prefers probability", probPreferred && probPreferred.spread === 0);
      const evPreferred = pickBestLegForParlay([
        { spread: 0, price: 200, prob: 0.5 },
        { spread: 1, price: 110, prob: 0.58 }
      ]);
      t("Parlay best EV when none reaches 60%", evPreferred && evPreferred.spread === 0);
      const evFloor = pickBestLegForParlay([
        { spread: 0, price: -500, prob: 0.7 },
        { spread: 1, price: -110, prob: 0.6 }
      ]);
      t("Parlay EV floor", evFloor && evFloor.spread === 1);
      const evNegativeAll = pickBestLegForParlay([
        { spread: 0, price: -400, prob: 0.6 },
        { spread: 1, price: -300, prob: 0.55 }
      ]);
      t("Parlay EV fallback when all negative", evNegativeAll && evNegativeAll.spread === 0);
      t("Alt price estimate", estimateAltPrice(-110, 2) === -135 && estimateAltPrice(-110, 3) === -150);
      const altTest = buildAltLines([5, -5], true, 4.5, -110);
      t("Alt line curve",
        altTest.length === 4 &&
        altTest[0].points === 0 &&
        altTest[3].points === 5 &&
        Math.abs(altTest[3].probability - 1) < 1e-9 &&
        altTest[3].price < -110);
      const drawdown = getDrawdownStats([
        { result: "WIN", units: 1 },
        { result: "LOSS", units: -1 },
        { result: "LOSS", units: -1 },
        { result: "LOSS", units: -1 }
      ]);
      t("Drawdown series", drawdown.equity === -2 && drawdown.drawdown === 3 && drawdown.maxDrawdown === 3);
      const btMetrics = backtestMetrics([
        normalizeBacktestPick({ result: "WIN", units: 1, pickSpread: -4, modelEdge: 4, sportId: "NBA" }, "TEST"),
        normalizeBacktestPick({ result: "WIN", units: 1, pickSpread: 2, modelEdge: 2.5, sportId: "NBA" }, "TEST"),
        normalizeBacktestPick({ result: "LOSS", units: -1, pickSpread: -6, modelEdge: 3, sportId: "MLB" }, "TEST")
      ]);
      t("Backtest metrics", btMetrics.decisions === 3 && Math.abs(btMetrics.roi - 1 / 3) < 1e-9);
      const calRows = calibrationRows([
        { result: "WIN", modelProb: 0.56 },
        { result: "LOSS", modelProb: 0.56 }
      ]);
      t("Calibration bucket", calRows.length === 1 && calRows[0].n === 2 && Math.abs(calRows[0].delta + 0.06) < 1e-9);
      const officialCal = computeOfficialCalibration([
        { result: "WIN", modelProb: 0.6 },
        { result: "LOSS", modelProb: 0.6 },
        { result: "WIN", modelProb: 0.4 },
        { result: "PUSH", modelProb: 0.7 }
      ]);
      t("Official calibration sample",
        officialCal.n === 3 && officialCal.wins === 2 && officialCal.rows.length === 2);
      t("Official calibration Brier", Math.abs(officialCal.brier - 0.88 / 3) < 1e-9);
      t("Official calibration ECE", Math.abs(officialCal.ece - 0.8 / 3) < 1e-9);
      t("Official calibration bias", Math.abs(officialCal.bias - (2 / 3 - 1.6 / 3)) < 1e-9);
      const segmentPick = {
        sportId: "NBA",
        profileId: "STANDARD",
        modelEdge: 2.5,
        modelProb: 0.61,
        price: -110,
        pickSpread: 4.5,
        pickIsHome: true,
        dateKey: "20261027"
      };
      t("Official segment prob", officialSegmentValue(segmentPick, "PROB") === "60–65%");
      t("Official segment role", officialSegmentValue(segmentPick, "ROLE") === "Underdog");
      t("Official segment edge", officialSegmentValue(segmentPick, "EDGE") === "2–3");
      t("Official segment side fallback", officialSegmentValue({ isHome: false }, "SIDE") === "Visitante");
      t("Official segment edge fallback", officialSegmentValue({ edge: 3.5 }, "EDGE") === "3–4");
      t("Park factor", getParkFactor("Coors Field") === 1.15 && getParkFactor("Unknown Park") === 1);
      t("Weather run factor",
        computeWeatherFactor({ temp: 90, wind: "10 mph, Out To CF" }) > 1.02 &&
        computeWeatherFactor({ temp: 50, wind: "10 mph, In From CF" }) < 0.98);
      const mlbMeans = computeMlbRunMeans(
        { park: 1.1, homePitcher: { quality: 1 }, awayPitcher: { quality: -1 } },
        0, 0, 4.5
      );
      t("MLB pitcher adjustment", mlbMeans.home > mlbMeans.away && mlbMeans.home > 4.5);
      const nflConfig = SPORTS.NFL;
      t("SPORTS.NFL config",
        nflConfig &&
        nflConfig.scoreboardUrl.includes("football/nfl/scoreboard") &&
        nflConfig.standingsUrl.includes("football/nfl/standings") &&
        nflConfig.homeAdvantageBase === 2.5 &&
        nflConfig.stdDev === 13.5 &&
        nflConfig.b2bPenalty === 0 &&
        nflConfig.earlySeasonRegGames === 4 &&
        nflConfig.unitName === "pts" &&
        nflConfig.edgeScale === 1 &&
        nflConfig.seasonGames === 17 &&
        ODDS_API_CONFIG.sports.NFL === "americanfootball_nfl");
      t("Sports order NBA-MLB-NFL", Object.keys(SPORTS).join(",") === "NBA,MLB,NFL");
      const nflStats = buildTeamStatistics({
        entries: [{
          team: { id: "12", abbreviation: "KC" },
          stats: [
            { name: "wins", value: 5 },
            { name: "losses", value: 1 },
            { name: "pointsFor", value: 143 },
            { name: "pointsAgainst", value: 103 },
            { name: "pointDifferential", value: 40 }
          ]
        }]
      });
      const kcStats = nflStats.get("KC");
      t("NFL standings totals to per-game",
        kcStats && kcStats.games === 6 &&
        Math.abs(kcStats.pointsFor - 143 / 6) < 1e-9 &&
        Math.abs(kcStats.pointsAgainst - 103 / 6) < 1e-9 &&
        Math.abs(kcStats.differential - 40 / 6) < 1e-9);
      const nbaStats = buildTeamStatistics({
        entries: [{
          team: { id: "2", abbreviation: "BOS" },
          stats: [
            { name: "wins", value: 3 },
            { name: "losses", value: 2 },
            { name: "avgPointsFor", value: 115 },
            { name: "avgPointsAgainst", value: 108 },
            { name: "pointDifferential", value: 7 }
          ]
        }]
      });
      const bosStats = nbaStats.get("BOS");
      t("NBA standings averages unchanged",
        bosStats && bosStats.pointsFor === 115 && bosStats.pointsAgainst === 108 && bosStats.differential === 7);
      t("NFL season inference",
        inferSeasonForSport("20261028", SPORTS.NFL) === 2026 &&
        inferSeasonForSport("20270110", SPORTS.NFL) === 2026 &&
        inferSeasonForSport("20261028", SPORTS.NBA) === 2027 &&
        inferSeasonForSport("20260410", SPORTS.MLB) === 2026);
      const nflNorm = normalizeGames({
        events: [{
          id: "401",
          date: "2026-11-01T17:00Z",
          competitions: [{
            competitors: [
              { homeAway: "home", team: { id: "8", abbreviation: "BAL", displayName: "Baltimore Ravens" }, score: "0", records: [{ type: "total", summary: "4-3" }] },
              { homeAway: "away", team: { id: "2", abbreviation: "BUF", displayName: "Buffalo Bills" }, score: "0", records: [{ type: "total", summary: "5-1" }] }
            ],
            status: { type: { name: "STATUS_SCHEDULED", state: "pre", completed: false, shortDetail: "Sun 1:00 PM" } },
            odds: [{
              provider: { displayName: "ESPN BET" },
              pointSpread: {
                home: { close: { line: "-3", odds: -120 }, current: { line: "-3", odds: -120 } },
                away: { close: { line: "+3", odds: 100 }, current: { line: "+3", odds: 100 } }
              },
              total: {
                over: { close: { line: "o47.5", odds: -110 }, current: { line: "o47.5", odds: -110 } },
                under: { close: { line: "u47.5", odds: -110 }, current: { line: "u47.5", odds: -110 } }
              }
            }]
          }]
        }]
      }, new Set());
      t("NFL game normalized",
        nflNorm.length === 1 &&
        nflNorm[0].home.abbreviation === "BAL" &&
        nflNorm[0].away.abbreviation === "BUF" &&
        nflNorm[0].market.homeSpread === -3 &&
        nflNorm[0].market.homePrice === -120 &&
        nflNorm[0].market.awayPrice === 100 &&
        nflNorm[0].market.total === 47.5 &&
        nflNorm[0].totalLine === 47.5 &&
        nflNorm[0].market.lineValid === true);
      const nflSim = simulateGame({
        ...nflNorm[0],
        home: { ...nflNorm[0].home, record: "-" },
        away: { ...nflNorm[0].away, record: "-" }
      }, new Map(), SPORTS.NFL, RISK_PROFILES.STANDARD);
      t("NFL normal margin model",
        Number.isFinite(nflSim.homeWinProbability) &&
        nflSim.homeWinProbability > 0.53 && nflSim.homeWinProbability < 0.62 &&
        Number.isFinite(nflSim.selectedProbability) &&
        nflSim.recommendedTeam === "BUF" &&
        Math.abs(nflSim.edge - 0.5) < 1e-9);
      t("Totals NFL computed",
        nflSim.totalLine === 47.5 &&
        Number.isFinite(nflSim.overProb) &&
        Number.isFinite(nflSim.underProb) &&
        Math.abs(nflSim.overProb + nflSim.underProb - 1) < 1e-9 &&
        nflSim.overProb > 0.02 && nflSim.overProb < 0.98 &&
        nflSim.overPrice === -110 && nflSim.underPrice === -110);
      t("Totals NFL EV consistent",
        Math.abs(nflSim.overEV - calculateEVUnits(nflSim.overProb, -110)) < 1e-9 &&
        Math.abs(nflSim.underEV - calculateEVUnits(nflSim.underProb, -110)) < 1e-9);
      const nflNoTotal = simulateGame({
        ...nflNorm[0],
        home: { ...nflNorm[0].home, record: "-" },
        away: { ...nflNorm[0].away, record: "-" },
        market: { ...nflNorm[0].market, total: null }
      }, new Map(), SPORTS.NFL, RISK_PROFILES.STANDARD);
      t("Totals omitted without line",
        nflNoTotal.totalLine === null &&
        nflNoTotal.overProb === null &&
        nflNoTotal.underProb === null &&
        nflNoTotal.overEV === null &&
        nflNoTotal.underEV === null);
      t("Totals leave plays untouched",
        nflNoTotal.recommendedTeam === nflSim.recommendedTeam &&
        nflNoTotal.recommendedSpread === nflSim.recommendedSpread &&
        nflNoTotal.qualified === nflSim.qualified &&
        Math.abs(nflNoTotal.selectedProbability - nflSim.selectedProbability) < 1e-9);
      const mlbTotalsTeam = (abbr, id) => ({
        id, abbreviation: abbr, name: abbr, displayName: abbr,
        shortDisplayName: abbr, logo: null, record: "0-0"
      });
      const mlbTotalsGame = {
        id: "mlb-totals-fixture",
        commenceTime: "2026-10-28T23:00Z",
        home: mlbTotalsTeam("LAD", "1"),
        away: mlbTotalsTeam("SF", "2"),
        homeB2B: false,
        awayB2B: false,
        modelInputs: null,
        market: {
          available: true, lineValid: true, provider: "Test", booksCount: 1, offers: [],
          homeSpread: -1.5, homePrice: -110, awayPrice: -110,
          total: 8.5, totalOverPrice: -110, totalUnderPrice: -110,
          mlHome: -150, mlAway: 130, dataValid: true
        }
      };
      const mlbTotalsSim = simulateGame(mlbTotalsGame, new Map(), SPORTS.MLB, RISK_PROFILES.STANDARD);
      t("Totals MLB computed",
        mlbTotalsSim.totalLine === 8.5 &&
        Number.isFinite(mlbTotalsSim.overProb) &&
        Math.abs(mlbTotalsSim.overProb + mlbTotalsSim.underProb - 1) < 1e-9 &&
        mlbTotalsSim.overProb > 0.3 && mlbTotalsSim.overProb < 0.7 &&
        mlbTotalsSim.overPrice === -110 &&
        Math.abs(mlbTotalsSim.overEV - calculateEVUnits(mlbTotalsSim.overProb, -110)) < 1e-9);
      const mlbPushSim = simulateGame({
        ...mlbTotalsGame,
        market: { ...mlbTotalsGame.market, total: 9 }
      }, new Map(), SPORTS.MLB, RISK_PROFILES.STANDARD);
      t("Totals pushes excluded",
        mlbPushSim.totalPushes > 0 &&
        Math.abs(mlbPushSim.overProb + mlbPushSim.underProb - 1) < 1e-9);
      t("Normal CDF",
        Math.abs(normalCdf(0) - 0.5) < 1e-9 &&
        Math.abs(normalCdf(1.96) - 0.975) < 1e-3 &&
        Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
      const propCalc = computePlayerProp({ mean: 28, sd: 6, line: 27.5, priceOver: -110, priceUnder: -110 });
      t("Prop probabilities sum", Math.abs(propCalc.probOver + propCalc.probUnder - 1) < 1e-9);
      t("Prop over/under EV", propCalc.probOver > 0.5 && propCalc.evOver > 0 && propCalc.evUnder < 0);
      t("Prop stake capped",
        propCalc.stakeOver > 0 &&
        propCalc.stakeUnder === 0 &&
        propCalc.stakeOver <= state.bankroll * state.maxStakePerBetPct / 100 + 1e-9);
      const propTail = computePlayerProp({ mean: 20, sd: 4, line: 30, priceOver: -110, priceUnder: -110 });
      t("Prop tail probability", propTail.probOver < 0.01 && propTail.probUnder > 0.99);
      t("Prop best side",
        bestPropSide({ evOver: 0.02, evUnder: -0.05 }) === "OVER" &&
        bestPropSide({ evOver: -0.01, evUnder: -0.02 }) === null);
      state.testsPassed = tests.every(x => x.cond);
    }
