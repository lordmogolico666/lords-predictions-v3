/**
 * Lord's Predictions — store.js
 * Persistencia local (caché, picks, snapshots, alertas, props) e inteligencia de línea/CLV.
 */
"use strict";

    // Caché y picks
    function getCacheKey(dateKey) {
      return `lords_predictions_v2_${state.sport.id}_${dateKey}`;
    }
    function saveCache(dateKey, games) {
      try {
        localStorage.setItem(getCacheKey(dateKey), JSON.stringify({ savedAt: Date.now(), games }));
      } catch (e) { console.warn("Cache write failed", e); }
    }
    function loadCache(dateKey) {
      try {
        const raw = localStorage.getItem(getCacheKey(dateKey));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.games) ? parsed : null;
      } catch { return null; }
    }

    // Team Totals manuales: se guardan por deporte/fecha/partido para que las
    // líneas y cuotas sobrevivan a una recarga o a un refresco de ESPN.
    function getManualTeamTotalsKey(sportId, dateKey) {
      return `${sportId}:${dateKey}`;
    }
    function getManualTeamTotals(sportId, dateKey) {
      const all = safeLoadJSON(TEAM_TOTALS_STORAGE_KEY, {});
      if (!all || typeof all !== "object" || Array.isArray(all)) return {};
      const forDate = all[getManualTeamTotalsKey(sportId, dateKey)];
      return forDate && typeof forDate === "object" && !Array.isArray(forDate) ? forDate : {};
    }
    function saveManualTeamTotal(sportId, dateKey, gameId, entry) {
      const all = safeLoadJSON(TEAM_TOTALS_STORAGE_KEY, {});
      const store = all && typeof all === "object" && !Array.isArray(all) ? all : {};
      const key = getManualTeamTotalsKey(sportId, dateKey);
      const forDate = store[key] && typeof store[key] === "object" && !Array.isArray(store[key])
        ? store[key]
        : {};
      const hasValues = ["home", "away"].some(side => {
        const s = entry?.[side];
        return s && [s.line, s.priceOver, s.priceUnder].some(v => Number.isFinite(Number(v)));
      });
      if (hasValues) forDate[gameId] = entry;
      else delete forDate[gameId];
      if (Object.keys(forDate).length) store[key] = forDate;
      else delete store[key];
      safeSaveJSON(TEAM_TOTALS_STORAGE_KEY, store);
    }
    function loadOfficialPicks() {
      try {
        const raw = localStorage.getItem(PICKS_STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    }
    function saveOfficialPicks(picks) {
      try {
        localStorage.setItem(PICKS_STORAGE_KEY, JSON.stringify(picks));
      } catch (e) {
        console.warn("No se pudo guardar picks oficiales:", e);
      }
    }

    // --- Cuaderno de apuestas manual ---
    // Registro personal de lo que el usuario realmente juega. No alimenta al
    // modelo ni se mezcla con state.officialPicks.
    function loadBetJournal() {
      const data = safeLoadJSON(BET_JOURNAL_STORAGE_KEY, []);
      if (!Array.isArray(data)) return [];
      return data.filter(b => b && typeof b === "object" && b.id && b.dateKey);
    }
    function saveBetJournal() {
      state.betJournal = Array.isArray(state.betJournal) ? state.betJournal : [];
      safeSaveJSON(BET_JOURNAL_STORAGE_KEY, state.betJournal);
    }
    function createJournalBetId() {
      return String(Date.now()) + "_" + Math.random().toString(16).slice(2);
    }
    function buildJournalBet(input) {
      const stake = Number(input?.stake);
      const price = Number(input?.price);
      const description = String(input?.description || "").trim();
      if (!description) return null;
      if (!Number.isFinite(stake) || stake <= 0) return null;
      if (!Number.isFinite(price) || price === 0) return null;
      const type = BET_JOURNAL_TYPES.includes(input?.type) ? input.type : "OTRO";
      return {
        id: createJournalBetId(),
        dateKey: input?.dateKey || state.dateKey,
        sportId: input?.sportId || state.sport.id,
        type,
        description,
        stake,
        price,
        result: "PENDING",
        units: 0,
        sourceId: input?.sourceId || null,
        createdAt: Date.now()
      };
    }
    function computeJournalAtsSettlement(bet, game) {
      const homeAbbr = game?.home?.abbreviation;
      const awayAbbr = game?.away?.abbreviation;
      if (!homeAbbr || !awayAbbr) return null;
      if (!Number.isFinite(game.homeScore) || !Number.isFinite(game.awayScore)) return null;
      const description = String(bet.description || "");
      let sideAbbr = null;
      if (description.includes(homeAbbr)) sideAbbr = homeAbbr;
      else if (description.includes(awayAbbr)) sideAbbr = awayAbbr;
      else if (game.recommendedTeam) sideAbbr = game.recommendedTeam;
      if (!sideAbbr) return null;
      let spread = Number(game.recommendedSpread);
      const m = description.match(/([+-]\d+(?:\.\d+)?)/);
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) spread = parsed;
      }
      if (!Number.isFinite(spread)) return null;
      const finalMarginHome = game.homeScore - game.awayScore;
      let marginForSide;
      if (sideAbbr === homeAbbr) marginForSide = finalMarginHome;
      else if (sideAbbr === awayAbbr) marginForSide = -finalMarginHome;
      else return null;
      const atsFinal = marginForSide + spread;
      const result = atsFinal > 0.05 ? "WIN" : atsFinal < -0.05 ? "LOSS" : "PUSH";
      return { result, units: calculateBetUnits(result, bet.stake, bet.price) };
    }
    function settleBetJournalWithGames() {
      if (!Array.isArray(state.betJournal) || !state.betJournal.length) return false;
      if (!Array.isArray(state.games) || !state.games.length) return false;
      const gamesById = new Map(state.games.map(g => [g.id, g]));
      let changed = false;
      state.betJournal = state.betJournal.map(bet => {
        if (bet.result !== "PENDING" || bet.type !== "ATS" || !bet.sourceId) return bet;
        const game = gamesById.get(bet.sourceId);
        if (!game || !game.completed) return bet;
        const settlement = computeJournalAtsSettlement(bet, game);
        if (!settlement) return bet;
        changed = true;
        return { ...bet, result: settlement.result, units: settlement.units, settledAt: Date.now() };
      });
      if (changed) saveBetJournal();
      return changed;
    }
    function getJournalDailySummary(bets) {
      const list = Array.isArray(bets) ? bets : [];
      const settled = list.filter(b => b.result === "WIN" || b.result === "LOSS" || b.result === "PUSH");
      const wins = settled.filter(b => b.result === "WIN").length;
      const losses = settled.filter(b => b.result === "LOSS").length;
      const pushes = settled.filter(b => b.result === "PUSH").length;
      const units = settled.reduce((sum, b) => sum + (Number(b.units) || 0), 0);
      const totalBets = settled.length;
      return { wins, losses, pushes, units, totalBets, roi: totalBets > 0 ? units / totalBets : 0 };
    }

    // Snapshots de línea, CLV, validación y alertas
    function safeLoadJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }
    function safeSaveJSON(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn(`No se pudo guardar ${key}:`, e);
      }
    }
    function loadLineSnapshots() {
      const data = safeLoadJSON(LINE_SNAPSHOT_KEY, {});
      if (!data || typeof data !== "object" || Array.isArray(data)) return {};
      const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000;
      const filtered = {};
      for (const [key, value] of Object.entries(data)) {
        const t = value?.updatedAt ? new Date(value.updatedAt).getTime() : 0;
        if (t >= cutoff) filtered[key] = value;
      }
      return filtered;
    }
    function saveLineSnapshots() {
      const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000;
      const entries = Object.entries(state.lineSnapshots || {})
        .filter(([, value]) => {
          const t = value?.updatedAt ? new Date(value.updatedAt).getTime() : 0;
          return t >= cutoff;
        })
        .sort((a, b) => String(b[1].updatedAt || "").localeCompare(String(a[1].updatedAt || "")));
      state.lineSnapshots = Object.fromEntries(entries.slice(0, 600));
      safeSaveJSON(LINE_SNAPSHOT_KEY, state.lineSnapshots);
    }
    function loadAlerts() {
      const data = safeLoadJSON(ALERTS_STORAGE_KEY, []);
      if (!Array.isArray(data)) return [];
      const cutoff = Date.now() - ALERTS_RETENTION_DAYS * 86400000;
      return data.filter(a => a && Number.isFinite(a.createdAt) && a.createdAt >= cutoff).slice(0, 100);
    }
    function saveAlerts() {
      const cutoff = Date.now() - ALERTS_RETENTION_DAYS * 86400000;
      state.alerts = (state.alerts || [])
        .filter(a => a && Number.isFinite(a.createdAt) && a.createdAt >= cutoff)
        .slice(0, 100);
      safeSaveJSON(ALERTS_STORAGE_KEY, state.alerts);
    }
    function loadTrackedPicks() {
      const data = safeLoadJSON(TRACKED_PICKS_KEY, []);
      return Array.isArray(data) ? data.filter(p => p && p.id) : [];
    }
    function saveTrackedPicks() {
      state.trackedPicks = (state.trackedPicks || []).slice(-1000);
      safeSaveJSON(TRACKED_PICKS_KEY, state.trackedPicks);
    }
    function loadAutoTrack() {
      try { return localStorage.getItem("lords_autotrack_v1") !== "0"; } catch { return true; }
    }
    function saveAutoTrack() {
      try { localStorage.setItem("lords_autotrack_v1", state.autoTrack ? "1" : "0"); } catch {}
    }

    function getSnapshotKey(game) {
      return `${state.sport.id}_${game.id}`;
    }
    function marketSnapshotFields(market) {
      const m = market || {};
      const num = value => Number.isFinite(value) ? value : null;
      return {
        homeSpread: num(m.homeSpread),
        homePrice: num(m.homePrice),
        awayPrice: num(m.awayPrice),
        total: num(m.total),
        totalOverPrice: num(m.totalOverPrice),
        totalUnderPrice: num(m.totalUnderPrice),
        mlHome: num(m.mlHome),
        mlAway: num(m.mlAway),
        provider: m.provider || "—"
      };
    }
    function openSnapshotFromMarket(market) {
      const current = marketSnapshotFields(market);
      const o = market?.open || {};
      const pick = (value, fallback) => Number.isFinite(value) ? value : fallback;
      return {
        homeSpread: pick(o.homeSpread, current.homeSpread),
        homePrice: pick(o.homePrice, current.homePrice),
        awayPrice: pick(o.awayPrice, current.awayPrice),
        total: pick(o.total, current.total),
        totalOverPrice: pick(o.totalOverPrice, current.totalOverPrice),
        totalUnderPrice: pick(o.totalUnderPrice, current.totalUnderPrice),
        mlHome: pick(o.mlHome, current.mlHome),
        mlAway: pick(o.mlAway, current.mlAway),
        provider: o.provider || current.provider
      };
    }
    function withinRiskRange(price, profile) {
      return Number.isFinite(price) && price >= profile.minOdds && price <= profile.maxOdds;
    }
    function pickSideSpread(snapshot, isHome) {
      if (!snapshot || !Number.isFinite(snapshot.homeSpread)) return null;
      return isHome ? snapshot.homeSpread : -snapshot.homeSpread;
    }
    function pickSidePrice(snapshot, isHome) {
      if (!snapshot) return null;
      return isHome ? snapshot.homePrice : snapshot.awayPrice;
    }
    function pickSideNoVig(snapshot, isHome) {
      if (!snapshot) return null;
      const { homeNoVig, awayNoVig } = removeVigTwoWay(snapshot.homePrice, snapshot.awayPrice);
      return isHome ? homeNoVig : awayNoVig;
    }

    function buildValidationIssues(game, snapshot) {
      const issues = [];
      const seen = new Set();
      const pregame = game.statusState === "pre";
      const add = (code, severity, message) => {
        const dedupe = `${code}|${message}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        issues.push({ code, severity, message });
      };
      for (const issue of game.market?.issues || []) {
        add(issue.code, issue.severity === "block" && !pregame ? "warn" : issue.severity, issue.message);
      }
      if (game.postponed) add("POSTPONED", pregame ? "block" : "warn", "Partido pospuesto.");
      if (game.canceled) add("CANCELED", pregame ? "block" : "warn", "Partido cancelado.");
      if (game.suspended) add("SUSPENDED", pregame ? "block" : "warn", "Partido suspendido.");
      if (!game.market?.available) add("NO_MARKET", pregame ? "block" : "warn", "Sin línea de mercado utilizable.");
      else if (!game.market?.lineValid) add("LINE_INVALID", pregame ? "block" : "warn", "Spread o cuotas inválidas.");
      if (game.statusState === "in") add("GAME_STARTED", "closed", "El partido ya inició; la línea ya no es pre-partido.");
      if (game.statusState === "post") add("GAME_FINAL", "closed", "Partido finalizado; solo lectura.");
      if (snapshot) {
        const venue = game.venue?.name || "";
        if (snapshot.venue && venue && snapshot.venue !== venue) {
          add("VENUE_CHANGED", pregame ? "block" : "warn", `Cambió la sede: ${snapshot.venue} → ${venue}.`);
        }
        const prevTime = snapshot.eventDate ? new Date(snapshot.eventDate).getTime() : NaN;
        const currTime = game.eventDate ? new Date(game.eventDate).getTime() : NaN;
        if (Number.isFinite(prevTime) && Number.isFinite(currTime) && Math.abs(prevTime - currTime) > 3600000) {
          add("DATE_CHANGED", pregame ? "block" : "warn", "Cambió la fecha u hora del partido.");
        }
        if (state.sport.id === "MLB") {
          for (const side of ["home", "away"]) {
            const prevPitcher = snapshot.probablePitchers?.[side];
            const currPitcher = game.probablePitchers?.[side];
            if (prevPitcher && currPitcher && prevPitcher !== currPitcher) {
              add(
                `PITCHER_CHANGED_${side}`,
                "warn",
                `Cambió el abridor ${side === "home" ? "local" : "visitante"}: ${prevPitcher} → ${currPitcher}.`
              );
            }
          }
        }
      }
      return issues;
    }

    function buildLineMovement(snapshot) {
      if (!snapshot) return null;
      const open = snapshot.open || {};
      const current = snapshot.current || {};
      const closing = snapshot.closing || null;
      const spreadDelta = Number.isFinite(open.homeSpread) && Number.isFinite(current.homeSpread)
        ? current.homeSpread - open.homeSpread
        : null;
      const totalDelta = Number.isFinite(open.total) && Number.isFinite(current.total)
        ? current.total - open.total
        : null;
      const openProb = americanOddsToProb(open.homePrice);
      const currentProb = americanOddsToProb(current.homePrice);
      const impliedDelta = openProb != null && currentProb != null ? currentProb - openProb : null;
      return { open, current, closing, spreadDelta, totalDelta, impliedDelta };
    }

    function computePickClv(pick, snapshot) {
      if (!snapshot?.closing) return null;
      const closing = snapshot.closing;
      let isHome = pick.pickIsHome;
      if (isHome == null) {
        if (pick.homeTeam) isHome = pick.pickTeam === pick.homeTeam;
        else if (pick.matchup?.includes("@")) isHome = pick.matchup.split("@")[1].trim().startsWith(pick.pickTeam);
        else isHome = false;
      }
      const closingSpread = pickSideSpread(closing, isHome);
      const closingPrice = pickSidePrice(closing, isHome);
      const closingNoVig = pickSideNoVig(closing, isHome);
      const entryNoVig = pick.entryNoVig ?? pick.modelNoVig ?? null;
      const clvPts = entryNoVig != null && closingNoVig != null ? closingNoVig - entryNoVig : null;
      return {
        side: pick.pickTeam,
        isHome,
        entrySpread: pick.pickSpread,
        entryPrice: pick.price,
        entryNoVig,
        closingSpread,
        closingPrice,
        closingNoVig,
        clvPts,
        spreadChanged: Number.isFinite(closingSpread) && Number.isFinite(pick.pickSpread)
          ? Math.abs(closingSpread - pick.pickSpread) > 0.001
          : false,
        beatClose: clvPts != null ? clvPts > 0.002 : null,
        closingAt: snapshot.closingAt
      };
    }

    function computeModelClv(game, snapshot) {
      if (!snapshot?.closing || !snapshot.modelEntry) return null;
      const entry = snapshot.modelEntry;
      const isHome = entry.isHome;
      const closing = snapshot.closing;
      const closingSpread = pickSideSpread(closing, isHome);
      const closingPrice = pickSidePrice(closing, isHome);
      const closingNoVig = pickSideNoVig(closing, isHome);
      const clvPts = entry.noVig != null && closingNoVig != null ? closingNoVig - entry.noVig : null;
      return {
        side: entry.side,
        isHome,
        entrySpread: entry.spread,
        entryPrice: entry.price,
        entryNoVig: entry.noVig,
        closingSpread,
        closingPrice,
        closingNoVig,
        clvPts,
        spreadChanged: Number.isFinite(closingSpread) && Number.isFinite(entry.spread)
          ? Math.abs(closingSpread - entry.spread) > 0.001
          : false,
        beatClose: clvPts != null ? clvPts > 0.002 : null,
        closingAt: snapshot.closingAt,
        currentPickChanged: game.recommendedTeam !== entry.side
      };
    }

    function pushAlert(type, severity, game, text, detail = "") {
      const key = `${type}|${state.sport.id}|${game.id}|${detail}`;
      const now = Date.now();
      const duplicate = state.alerts.some(a => a.key === key && now - a.createdAt < 12 * 3600000);
      if (duplicate) return;
      state.alerts.unshift({
        id: `${now}_${Math.random().toString(36).slice(2, 7)}`,
        key,
        type,
        severity,
        text,
        gameId: game.id,
        sportId: state.sport.id,
        dateKey: state.dateKey,
        matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
        createdAt: now
      });
      if (state.alerts.length > 100) state.alerts.length = 100;
    }

    function recordTrackedPicks(games) {
      if (!state.autoTrack) return;
      const now = Date.now();
      const known = new Set(state.trackedPicks.map(p => p.id));
      for (const game of games) {
        if (!game.qualified || !game.bettingOpen || !game.recommendedTeam) continue;
        if (!Number.isFinite(game.recommendedSpread) || !Number.isFinite(game.selectedPrice)) continue;
        const id = getSnapshotKey(game);
        if (known.has(id)) continue;
        const snapshot = state.lineSnapshots[id];
        state.trackedPicks.push({
          id,
          gameId: game.id,
          sportId: state.sport.id,
          dateKey: state.dateKey,
          season: inferSeason(state.dateKey),
          month: state.dateKey.slice(0, 6),
          createdAt: now,
          matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
          homeTeam: game.home.abbreviation,
          awayTeam: game.away.abbreviation,
          pickTeam: game.recommendedTeam,
          pickIsHome: game.recommendedTeam === game.home.abbreviation,
          pickSpread: game.recommendedSpread,
          price: game.selectedPrice,
          provider: game.bestLine?.provider || game.market?.provider || "",
          profileId: state.riskProfile.id,
          modelProb: game.selectedProbability,
          modelEdge: game.edge,
          zEdge: game.zEdge ?? null,
          modelNoVig: game.selectedNoVig,
          consensusNoVig: game.consensusNoVig ?? null,
          consensusEdge: game.consensusEdge ?? null,
          consensusBooks: game.consensusBooks ?? 0,
          evUnits: game.evUnits,
          kelly: game.kelly,
          kellyCap: game.kellyCap ?? null,
          pickType: "ATS",
          source: "MODEL",
          entryOpen: snapshot?.open || null,
          entryCurrent: snapshot?.current || null,
          entryNoVig: game.selectedNoVig ?? null,
          result: "PENDING",
          units: 0,
          suResult: null,
          clv: null
        });
        known.add(id);
      }
    }

    function settleTrackedPicks(games) {
      if (!state.trackedPicks.length) return;
      const byKey = new Map(games.map(g => [getSnapshotKey(g), g]));
      for (const pick of state.trackedPicks) {
        const game = byKey.get(pick.id);
        if (!game) continue;
        const snapshot = state.lineSnapshots[pick.id];
        if (snapshot?.closing && !pick.clv) pick.clv = computePickClv(pick, snapshot);
        if (pick.result !== "PENDING") continue;
        if (!game.completed || !Number.isFinite(game.homeScore) || !Number.isFinite(game.awayScore)) continue;
        const settled = settlePickWithGame(pick, game);
        Object.assign(pick, settled);
        pick.settledAt = Date.now();
        if (snapshot?.closing) pick.clv = computePickClv(pick, snapshot);
      }
    }

    function updateLineIntelligence(games) {
      if (!Array.isArray(games) || !games.length) return;
      const now = Date.now();
      const sportId = state.sport.id;
      for (const game of games) {
        if (!game?.id) continue;
        const key = getSnapshotKey(game);
        const prev = state.lineSnapshots[key] || null;
        const current = marketSnapshotFields(game.market);
        const pregame = game.statusState === "pre" && !game.postponed && !game.canceled && !game.suspended;
        const open = prev?.open || openSnapshotFromMarket(game.market);
        const snapshot = prev ? { ...prev } : {
          key,
          sportId,
          gameId: game.id,
          dateKey: state.dateKey,
          matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
          eventDate: game.eventDate,
          venue: game.venue?.name || "",
          neutralSite: game.neutralSite === true,
          probablePitchers: { ...(game.probablePitchers || {}) },
          open,
          current,
          firstSeenAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          lastPregame: pregame ? current : null,
          closing: pregame ? null : current,
          closingAt: pregame ? null : new Date(now).toISOString(),
          closingSource: pregame ? null : "primer avistamiento",
          modelEntry: null,
          lastPick: null,
          lastQualified: false,
          validationIssues: []
        };

        const issues = buildValidationIssues(game, prev || snapshot);
        const hasBlock = issues.some(i => i.severity === "block");
        const finalQualified = game.qualified && !hasBlock;
        const bettingOpen = pregame && !hasBlock;

        if (state.dayOffset >= 0) {
          if (!prev) {
            if (pregame && Number.isFinite(current.homeSpread)) {
              pushAlert(
                "NEW_LINE",
                "info",
                game,
                `Línea nueva: ${game.away.abbreviation} ${formatSpread(-current.homeSpread)} (${formatAmericanPrice(current.awayPrice)}) / ` +
                `${game.home.abbreviation} ${formatSpread(current.homeSpread)} (${formatAmericanPrice(current.homePrice)})` +
                `${Number.isFinite(current.total) ? ` · Total ${formatNumber(current.total, 1)}` : ""}`,
                "first"
              );
            }
          } else {
            const prevCur = prev.current || {};
            const spreadMoved = Number.isFinite(prevCur.homeSpread) && Number.isFinite(current.homeSpread) &&
              Math.abs(current.homeSpread - prevCur.homeSpread) >= (sportId === "MLB" ? 0.5 : 1) - 1e-9;
            const totalMoved = Number.isFinite(prevCur.total) && Number.isFinite(current.total) &&
              Math.abs(current.total - prevCur.total) >= 0.5 - 1e-9;
            const prevProb = americanOddsToProb(prevCur.homePrice);
            const currProb = americanOddsToProb(current.homePrice);
            const priceMoved = prevProb != null && currProb != null && Math.abs(currProb - prevProb) >= 0.015;
            if (pregame && (spreadMoved || totalMoved || priceMoved)) {
              const parts = [];
              if (spreadMoved) {
                parts.push(`spread ${formatSpread(prevCur.homeSpread)} → ${formatSpread(current.homeSpread)} (${formatAmericanPrice(prevCur.homePrice)} → ${formatAmericanPrice(current.homePrice)})`);
              } else if (priceMoved) {
                parts.push(`cuota local ${formatAmericanPrice(prevCur.homePrice)} → ${formatAmericanPrice(current.homePrice)}`);
              }
              if (totalMoved) parts.push(`total ${formatNumber(prevCur.total, 1)} → ${formatNumber(current.total, 1)}`);
              pushAlert(
                "LINE_MOVE",
                spreadMoved || totalMoved ? "warn" : "info",
                game,
                `${game.away.abbreviation} @ ${game.home.abbreviation}: ${parts.join(" · ")}`,
                `${prevCur.homeSpread}|${current.homeSpread}|${prevCur.homePrice}|${current.homePrice}|${prevCur.total}|${current.total}`
              );
            }
            if (prev.lastPick && game.recommendedTeam &&
                (prev.lastPick.side !== game.recommendedTeam ||
                 Math.abs((prev.lastPick.spread ?? 0) - (game.recommendedSpread ?? 0)) > 0.001)) {
              pushAlert(
                "PICK_CHANGE",
                "warn",
                game,
                `Cambió el pick: ${prev.lastPick.side} ${formatSpread(prev.lastPick.spread)} → ` +
                `${game.recommendedTeam} ${formatSpread(game.recommendedSpread)}`,
                `${prev.lastPick.side}|${prev.lastPick.spread}|${game.recommendedTeam}|${game.recommendedSpread}`
              );
            }
            if (prev.lastPick && Number.isFinite(game.selectedPrice)) {
              const wasInRange = withinRiskRange(prev.lastPick.price, state.riskProfile);
              const isInRange = withinRiskRange(game.selectedPrice, state.riskProfile);
              if (wasInRange && !isInRange) {
                pushAlert(
                  "OUT_OF_RANGE",
                  "warn",
                  game,
                  `La cuota ${formatAmericanPrice(game.selectedPrice)} salió del rango del perfil (${state.riskProfile.minOdds} a +${state.riskProfile.maxOdds}).`,
                  `${game.selectedPrice}|${state.riskProfile.id}`
                );
              }
            }
            if (prev.lastQualified && !finalQualified) {
              pushAlert(
                "VALUE_LOST",
                "danger",
                game,
                hasBlock
                  ? `Se eliminó el valor de ${prev.lastPick?.side || game.recommendedTeam}: datos dudosos en la línea.`
                  : `El movimiento de línea eliminó el valor de ${prev.lastPick?.side || game.recommendedTeam} ${formatSpread(prev.lastPick?.spread)}.`,
                `${prevCur.homeSpread}|${current.homeSpread}|${hasBlock ? "block" : "line"}`
              );
            }
            if (prev.venue && game.venue?.name && prev.venue !== game.venue.name) {
              pushAlert("VENUE", "danger", game, `Cambió la sede: ${prev.venue} → ${game.venue.name}.`, `${prev.venue}|${game.venue.name}`);
            }
            const prevTime = prev.eventDate ? new Date(prev.eventDate).getTime() : NaN;
            const currTime = game.eventDate ? new Date(game.eventDate).getTime() : NaN;
            if (Number.isFinite(prevTime) && Number.isFinite(currTime) && Math.abs(prevTime - currTime) > 3600000) {
              pushAlert("SCHEDULE", "danger", game, "Cambió la fecha u hora del partido.", `${prev.eventDate}|${game.eventDate}`);
            }
            if (sportId === "MLB") {
              for (const side of ["home", "away"]) {
                const prevPitcher = prev.probablePitchers?.[side];
                const currPitcher = game.probablePitchers?.[side];
                if (prevPitcher && currPitcher && prevPitcher !== currPitcher) {
                  pushAlert(
                    "PITCHER",
                    "warn",
                    game,
                    `Cambió el abridor ${side === "home" ? "local" : "visitante"}: ${prevPitcher} → ${currPitcher}.`,
                    `${side}|${prevPitcher}|${currPitcher}`
                  );
                }
              }
            }
          }
        }

        snapshot.current = current;
        snapshot.updatedAt = new Date(now).toISOString();
        snapshot.eventDate = game.eventDate || snapshot.eventDate;
        snapshot.venue = game.venue?.name || snapshot.venue;
        snapshot.neutralSite = game.neutralSite === true;
        snapshot.probablePitchers = { ...(game.probablePitchers || snapshot.probablePitchers || {}) };
        if (pregame) snapshot.lastPregame = current;
        if (!pregame && !snapshot.closing) {
          snapshot.closing = snapshot.lastPregame || current;
          snapshot.closingAt = new Date(now).toISOString();
          snapshot.closingSource = snapshot.lastPregame ? "último pre-partido" : "cierre ESPN";
        }
        if (pregame && !snapshot.modelEntry && game.recommendedTeam) {
          snapshot.modelEntry = {
            side: game.recommendedTeam,
            spread: game.recommendedSpread,
            price: game.selectedPrice,
            noVig: game.selectedNoVig ?? null,
            isHome: game.recommendedTeam === game.home.abbreviation,
            at: new Date(now).toISOString()
          };
        }
        if (game.recommendedTeam) {
          snapshot.lastPick = {
            side: game.recommendedTeam,
            spread: game.recommendedSpread,
            price: game.selectedPrice,
            at: new Date(now).toISOString()
          };
        }
        snapshot.lastQualified = finalQualified;
        snapshot.validationIssues = issues.map(i => ({ code: i.code, severity: i.severity }));
        state.lineSnapshots[key] = snapshot;

        game.validationIssues = issues;
        game.hasBlockingIssue = hasBlock;
        game.bettingOpen = bettingOpen;
        game.lineMovement = buildLineMovement(snapshot);
        game.clv = computeModelClv(game, snapshot);
        game.qualified = finalQualified;
      }
      recordTrackedPicks(games);
      settleTrackedPicks(games);
      updateOfficialPicksClv();
      saveLineSnapshots();
      saveAlerts();
      saveTrackedPicks();
    }

    function getOfficialPickSnapshot(pick) {
      const sportId = pick.sportId || state.sport.id;
      let gameId = pick.gameId;
      if (!gameId && typeof pick.id === "string") {
        const parts = pick.id.split("_");
        if (parts.length >= 3) gameId = parts.slice(2).join("_");
      }
      if (!gameId) return null;
      return state.lineSnapshots[`${sportId}_${gameId}`] || null;
    }
    function getOfficialPickClv(pick) {
      if (pick.clv) return pick.clv;
      if (pick.entryNoVig == null) return null;
      const snapshot = getOfficialPickSnapshot(pick);
      return snapshot?.closing ? computePickClv(pick, snapshot) : null;
    }
    function updateOfficialPicksClv() {
      let changed = false;
      for (const pick of state.officialPicks) {
        if (pick.clv || pick.entryNoVig == null) continue;
        const snapshot = getOfficialPickSnapshot(pick);
        if (!snapshot?.closing) continue;
        const clv = computePickClv(pick, snapshot);
        if (!clv) continue;
        pick.clv = clv;
        changed = true;
      }
      if (changed) saveOfficialPicks(state.officialPicks);
    }

    function annotateGamesFromSnapshots(games) {
      if (!Array.isArray(games)) return;
      for (const game of games) {
        const snapshot = state.lineSnapshots[getSnapshotKey(game)];
        if (!snapshot) continue;
        const issues = buildValidationIssues(game, snapshot);
        const hasBlock = issues.some(i => i.severity === "block");
        game.validationIssues = issues;
        game.hasBlockingIssue = hasBlock;
        game.bettingOpen = game.statusState === "pre" && !hasBlock && !game.postponed && !game.canceled && !game.suspended;
        game.lineMovement = buildLineMovement(snapshot);
        game.clv = computeModelClv(game, snapshot);
        if (hasBlock) game.qualified = false;
      }
    }

    function markAlertsSeen() {
      state.alerts = [];
      saveAlerts();
      render();
    }

    function setAutoTrack(value) {
      state.autoTrack = !!value;
      saveAutoTrack();
      render();
    }

    function inferSeason(dateKey) {
      const y = Number(dateKey.slice(0, 4));
      const m = Number(dateKey.slice(4, 6));
      return m >= 7 ? y + 1 : y;
    }
    // NFL se identifica por el año en que arranca la temporada (sep–feb).
    function inferSeasonForSport(dateKey, sportConfig) {
      if (sportConfig?.id !== "NFL") return inferSeason(dateKey);
      const y = Number(dateKey.slice(0, 4));
      const m = Number(dateKey.slice(4, 6));
      return m <= 2 ? y - 1 : y;
    }

    function getGameKey(game) {
      return `${state.sport.id}_${state.dateKey}_${game.id}`;
    }
    function findExistingPick(game) {
      const key = getGameKey(game);
      return state.officialPicks.find(p => p.id === key);
    }

    function settlePickWithGame(pick, game) {
      if (!Number.isFinite(game.homeScore) || !Number.isFinite(game.awayScore)) {
        return pick;
      }
      const finalMarginHome = game.homeScore - game.awayScore;
      const spread = pick.pickSpread;
      let marginForPickTeam;
      if (pick.pickTeam === game.home.abbreviation) {
        marginForPickTeam = finalMarginHome;
      } else if (pick.pickTeam === game.away.abbreviation) {
        marginForPickTeam = -finalMarginHome;
      } else {
        marginForPickTeam = 0;
      }
      const ats = marginForPickTeam + spread;
      let result;
      if (ats > 0.05)      result = "WIN";
      else if (ats < -0.05) result = "LOSS";
      else                  result = "PUSH";
      const price = pick.price;
      let units = 0;
      const risk = 1;
      if (result === "WIN") {
        if (price > 0) units = (price / 100) * risk;
        else units = (100 / Math.abs(price)) * risk;
      } else if (result === "LOSS") {
        units = -risk;
      } else {
        units = 0;
      }
      const suResult = marginForPickTeam > 0 ? "WIN" : marginForPickTeam < 0 ? "LOSS" : "PUSH";
      return { ...pick, result, units, suResult };
    }

    function loadPlayerProps() {
      const data = safeLoadJSON(PLAYER_PROPS_KEY, []);
      if (!Array.isArray(data)) return [];
      return data.filter(prop => prop && typeof prop === "object" && prop.id && prop.sportId);
    }
    function savePlayerProps() {
      safeSaveJSON(PLAYER_PROPS_KEY, state.playerProps);
    }
