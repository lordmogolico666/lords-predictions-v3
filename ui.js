/**
 * Lord's Predictions — ui.js
 * Render completo de la interfaz, paneles, tarjetas, exportaciones y handlers de eventos.
 */
"use strict";

    function renderAltMarketsBadge(game, compact = false) {
      const count = altSpreadCount(game);
      const totalLines = altTotalCount(game);
      if (!count && !totalLines) return "";
      const sizeClass = compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]";
      return `<span class="${sizeClass} rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-200 font-bold"
                    title="Alt. líneas disponibles: ${count} spreads alternativos · ${totalLines} totals">ALT. LÍNEAS ${count || totalLines}</span>`;
    }

    function renderAltMarketsNote(game) {
      const count = altSpreadCount(game);
      const totalLines = altTotalCount(game);
      if (!count && !totalLines) return "";
      const detail = [
        count ? `${count} spreads` : "",
        totalLines ? `${totalLines} totals` : ""
      ].filter(Boolean).join(" · ");
      return `<div class="mt-2 text-[10px] text-indigo-300">
        Líneas alternativas disponibles${detail ? ` <span class="text-indigo-400/70">· ${detail}</span>` : ""}
      </div>`;
    }


    function selectDay(offset) {
      state.dayOffset = offset;
      state.tab = "ALL";
      loadGames();
    }
    function setTab(tab) { state.tab = tab; render(); }

    // --- Cuaderno de apuestas (registro manual, ajeno al modelo) ---
    function promptAndAddJournalBet({ type, sourceId, defaultDesc, defaultPrice }) {
      const description = window.prompt("Descripción de la apuesta (ej: UTA +7.5 -110)", defaultDesc || "");
      if (description == null) return;
      const stakeStr = window.prompt("Stake (unidades apostadas)", "1");
      if (stakeStr == null) return;
      const stake = Number(stakeStr);
      if (!Number.isFinite(stake) || stake <= 0) {
        alert("Stake inválido: usa un número mayor que 0.");
        return;
      }
      const priceStr = window.prompt("Cuota americana (ej: -110, +120)", String(defaultPrice ?? "-110"));
      if (priceStr == null) return;
      const price = Number(priceStr);
      if (!Number.isFinite(price) || price === 0) {
        alert("Cuota inválida: usa una cuota americana distinta de 0 (ej: -110, +120).");
        return;
      }
      const bet = buildJournalBet({
        type,
        sourceId,
        description,
        stake,
        price,
        dateKey: state.dateKey,
        sportId: state.sport.id
      });
      if (!bet) {
        alert("No se pudo crear la apuesta: revisa la descripción.");
        return;
      }
      state.betJournal.push(bet);
      saveBetJournal();
      alert(`Apuesta añadida al cuaderno: ${bet.description}`);
      render();
    }
    function openAddBetFromGame(gameId) {
      const game = state.games.find(g => g.id === gameId);
      if (!game) return;
      const priceLabel = formatAmericanPrice(game.selectedPrice);
      const defaultDesc = game.recommendedTeam
        ? `${game.recommendedTeam} ${formatSpread(game.recommendedSpread)}${priceLabel === "—" ? "" : ` (${priceLabel})`}`
        : `${game.away.abbreviation} @ ${game.home.abbreviation}`;
      promptAndAddJournalBet({
        type: "ATS",
        sourceId: game.id,
        defaultDesc,
        defaultPrice: game.selectedPrice || -110
      });
    }
    function openAddBetManual(type, sourceId, defaultDesc, defaultPrice) {
      promptAndAddJournalBet({
        type: BET_JOURNAL_TYPES.includes(type) ? type : "OTRO",
        sourceId: sourceId || null,
        defaultDesc,
        defaultPrice
      });
    }
    function openAddBetFromProp(propId) {
      const prop = propsForCurrentSport().find(p => p.id === propId);
      if (!prop) return;
      const best = bestPropSide(prop);
      const over = best !== "UNDER";
      const desc = `${prop.playerName} ${prop.marketType} ${over ? "O" : "U"}${formatNumber(prop.line, 1)}`;
      openAddBetManual("PROP", prop.id, desc, over ? prop.priceOver : prop.priceUnder);
    }
    function openAddBetFromParlay(index) {
      const parlay = state.parlays[Number(index)];
      if (!parlay) return;
      const desc = parlay.legs
        .map(leg => `${leg.team} ${formatSpread(leg.spread)}`)
        .join(" + ");
      const price = decimalToAmerican(parlay.oddsDecimal);
      openAddBetManual("PARLAY", null, desc, price > 0 ? `+${price}` : price);
    }
    function setJournalResult(id, result) {
      if (!BET_JOURNAL_RESULTS.includes(result)) return;
      const bet = state.betJournal.find(b => b.id === id);
      if (!bet) return;
      bet.result = result;
      bet.units = calculateBetUnits(result, bet.stake, bet.price);
      bet.settledAt = result === "PENDING" ? null : Date.now();
      saveBetJournal();
      render();
    }
    function removeJournalBet(id) {
      const bet = state.betJournal.find(b => b.id === id);
      if (!bet) return;
      if (!window.confirm(`¿Eliminar la apuesta "${bet.description}" del cuaderno?`)) return;
      state.betJournal = state.betJournal.filter(b => b.id !== id);
      saveBetJournal();
      render();
    }

    function setParlaySize(value) {
      const eligible = getParlayCandidates(state.parlayConfig.baseSet).length;
      const maxSize = Math.max(2, eligible);
      const size = Math.round(Number(value));
      state.parlayConfig.size = Number.isFinite(size) ? clamp(size, 2, maxSize) : 2;
      generateParlays();
      render();
    }
    function setParlayBaseSet(value) {
      state.parlayConfig.baseSet = value === "ALL" ? "ALL" : "PLAYS";
      generateParlays();
      render();
    }
    function setParlayCategoryFilter(value) {
      state.parlayCategoryFilter = PARLAY_CATEGORIES[value] ? value : "ALL";
      render();
    }
    function manualRefresh() { loadGames(); }

    async function setRiskProfile(profileId) {
      const pf = RISK_PROFILES[profileId];
      if (!pf) return;
      state.riskProfile = pf;
      if (state.standingsMap && state.standingsMap.size && state.games.length) {
        const sportId = state.sport.id;
        state.games = await runModel(state.games, state.standingsMap, state.sport, pf);
        // Si el deporte o el perfil cambiaron mientras simulaba, el resultado
        // ya no aplica; la carga vigente se encarga de reemplazarlo.
        if (state.sport.id !== sportId || state.riskProfile !== pf) return;
      } else {
        const kellyContext = getKellyContext(pf, state.sport);
        state.kellyContext = kellyContext;
        state.games = state.games.map(g => {
          if (!Number.isFinite(g.edge) || !Number.isFinite(g.edgeRelative) || !g.selectedPrice) {
            return { ...g, qualified: false, kelly: 0, kellyCap: kellyContext.maxKelly };
          }
          const minEdge = getEffectiveMinEdge(pf, state.sport);
          const minZ = getEffectiveMinZ(pf);
          const zEdge = g.zEdge ?? (g.edge / state.sport.stdDev);
          const withinOdds = g.selectedPrice >= pf.minOdds && g.selectedPrice <= pf.maxOdds;
          let kelly = withinOdds ? calculateKelly(g.selectedProbability, g.selectedPrice) : 0;
          kelly = clamp(kelly, 0, kellyContext.maxKelly);
          const qualified = withinOdds &&
            g.edge >= minEdge &&
            zEdge >= minZ &&
            g.edgeRelative >= pf.minEdgeRelative &&
            g.selectedProbability >= pf.minCoverProbability &&
            (g.consensusEdge == null || g.consensusEdge >= (pf.minConsensusEdge ?? -1)) &&
            kelly >= pf.minKelly;
          return { ...g, kelly, kellyCap: kellyContext.maxKelly, zEdge, qualified };
        });
      }
      annotateGamesFromSnapshots(state.games);
      generateParlays();
      render();
    }

    function setSport(sportId) {
      const sp = SPORTS[sportId];
      if (!sp || sp.id === state.sport.id) return;
      const keepPropsTab = state.tab === "PROPS";
      const keepJournalTab = state.tab === "JOURNAL";
      state.sport = sp;
      state.games = [];
      state.parlays = [];
      state.parlayMeta = null;
      state.tab = keepPropsTab ? "PROPS" : keepJournalTab ? "JOURNAL" : "ALL";
      state.error = "";
      state.warning = "";
      state.lastUpdated = null;
      loadGames();
    }

    function toggleOfficialPickById(gameId) {
      const game = state.games.find(g => g.id === gameId);
      if (!game) return;
      const key = getGameKey(game);
      const existing = state.officialPicks.find(p => p.id === key);
      if (existing) {
        state.officialPicks = state.officialPicks.filter(p => p.id !== key);
        saveOfficialPicks(state.officialPicks);
        render();
        return;
      }
      if (!game.recommendedTeam ||
          !Number.isFinite(game.recommendedSpread) ||
          !game.market.available ||
          !game.market.lineValid) {
        alert("Este partido no tiene una línea válida para marcar pick oficial (spread/cuotas incompletas o inválidas).");
        return;
      }
      if (game.bettingOpen === false || game.hasBlockingIssue || game.statusState === "in" || game.statusState === "post") {
        alert("No se puede marcar un pick oficial: el partido ya inició, terminó o la línea tiene datos dudosos.");
        return;
      }
      const pick = {
        id: key,
        gameId: game.id,
        sportId: state.sport.id,
        dateKey: state.dateKey,
        season: inferSeason(state.dateKey),
        month: state.dateKey.slice(0, 6),
        createdAt: Date.now(),
        matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
        homeTeam: game.home.abbreviation,
        awayTeam: game.away.abbreviation,
        pickTeam: game.recommendedTeam,
        pickIsHome: game.recommendedTeam === game.home.abbreviation,
        pickType: "ATS",
        pickSpread: game.recommendedSpread,
        price: game.selectedPrice,
        provider: game.bestLine?.provider || game.market.provider || "",
        profileId: state.riskProfile.id,
        modelEdge: game.edge ?? null,
        modelProb: game.selectedProbability ?? null,
        zEdge: game.zEdge ?? null,
        modelNoVig: game.selectedNoVig ?? null,
        entryNoVig: game.selectedNoVig ?? null,
        consensusNoVig: game.consensusNoVig ?? null,
        consensusEdge: game.consensusEdge ?? null,
        consensusBooks: game.consensusBooks ?? 0,
        evUnits: game.evUnits ?? null,
        kelly: game.kelly ?? null,
        kellyCap: game.kellyCap ?? null,
        result: "PENDING",
        units: 0,
        suResult: null
      };
      state.officialPicks = [...state.officialPicks, pick];
      saveOfficialPicks(state.officialPicks);
      render();
    }

    function setViewMode(mode) {
      state.viewMode = mode === "COMPACT" ? "COMPACT" : "DETAILED";
      render();
    }

    function setBankroll(val) {
      const n = Number(val);
      state.bankroll = Number.isFinite(n) && n >= 0 ? n : 0;
      generateParlays();
      render();
    }
    function setMaxStakePerBetPct(val) {
      const n = Number(val);
      state.maxStakePerBetPct = Number.isFinite(n) && n >= 0 ? n : 0;
      render();
    }
    function setMaxDailyRiskPct(val) {
      const n = Number(val);
      state.maxDailyRiskPct = Number.isFinite(n) && n >= 0 ? n : 0;
      render();
    }
    function addPlayerProp() {
      const field = id => document.getElementById(id)?.value ?? "";
      const playerName = field("propPlayer").trim();
      const teamAbbr = field("propTeam").trim().toUpperCase();
      const marketType = field("propMarket").trim();
      const statName = field("propStat").trim();
      const lineRaw = field("propLine").trim();
      const meanRaw = field("propMean").trim();
      const sdRaw = field("propSd").trim();
      const line = lineRaw === "" ? null : toNumber(lineRaw);
      const mean = meanRaw === "" ? null : toNumber(meanRaw);
      const sd = sdRaw === "" ? null : toNumber(sdRaw);
      const rawOver = toNumber(field("propPriceOver").trim());
      const rawUnder = toNumber(field("propPriceUnder").trim());
      const priceOver = isValidAmericanPrice(rawOver) ? rawOver : null;
      const priceUnder = isValidAmericanPrice(rawUnder) ? rawUnder : null;
      const missing = [];
      if (!playerName) missing.push("jugador");
      if (!marketType) missing.push("mercado");
      if (line === null) missing.push("línea");
      if (mean === null) missing.push("media");
      if (sd === null || sd <= 0) missing.push("desviación estándar (> 0)");
      if (priceOver === null && priceUnder === null) missing.push("cuota Over o Under válida (±100 a ±1000)");
      if (missing.length) {
        state.propsError = `Revisa: ${missing.join(", ")}.`;
        state.propsNotice = "";
        render();
        return;
      }
      const prop = {
        id: createPlayerPropId(),
        sportId: state.sport.id,
        playerName,
        teamAbbr,
        marketType,
        statName,
        line,
        priceOver,
        priceUnder,
        mean,
        sd,
        ...computePlayerProp({ mean, sd, line, priceOver, priceUnder }),
        createdAt: Date.now()
      };
      state.playerProps = [prop, ...state.playerProps];
      savePlayerProps();
      state.propsError = "";
      state.propsNotice = `${playerName}: ${marketType} ${formatNumber(line, 2)} agregado.`;
      render();
    }
    function removePlayerProp(id) {
      state.playerProps = state.playerProps.filter(prop => prop.id !== id);
      savePlayerProps();
      state.propsError = "";
      state.propsNotice = "Prop eliminada.";
      render();
    }
    function clearPlayerProps() {
      const current = propsForCurrentSport();
      if (!current.length) return;
      if (!confirm(`¿Borrar las ${current.length} props de ${state.sport.label}?`)) return;
      state.playerProps = state.playerProps.filter(prop => prop.sportId !== state.sport.id);
      savePlayerProps();
      state.propsError = "";
      state.propsNotice = `Props de ${state.sport.label} eliminadas.`;
      render();
    }
    function formatPropEV(ev) {
      if (!Number.isFinite(ev)) return "—";
      return `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
    }
    function bestPropSide(prop) {
      const over = Number.isFinite(prop.evOver) ? prop.evOver : -Infinity;
      const under = Number.isFinite(prop.evUnder) ? prop.evUnder : -Infinity;
      const best = Math.max(over, under);
      if (!Number.isFinite(best) || best <= 0) return null;
      return over >= under ? "OVER" : "UNDER";
    }
    // Filtros / orden
    function applyFiltersAndSort(baseGames) {
      let filtered = baseGames.slice();

      if (state.filters.onlyWithLine) {
        filtered = filtered.filter(g => g.market?.available && g.market?.lineValid);
      }
      if (state.filters.onlyQualified) {
        filtered = filtered.filter(g => g.qualified);
      }
      if (state.filters.status === "PENDING") {
        filtered = filtered.filter(g => !g.completed);
      } else if (state.filters.status === "FINAL") {
        filtered = filtered.filter(g => g.completed);
      } else if (state.filters.status === "LIVE") {
        filtered = filtered.filter(g => g.liveStatus);
      }
      if (state.filters.minEdge > 0) {
        filtered = filtered.filter(g => (g.edge ?? 0) >= state.filters.minEdge);
      }
      if (state.filters.minProbability > 0) {
        filtered = filtered.filter(g => (g.selectedProbability ?? 0) >= state.filters.minProbability);
      }
      if (state.filters.onlyClean) {
        filtered = filtered.filter(g => !(g.validationIssues || []).some(i => i.severity === "block" || i.severity === "warn"));
      }
      if (state.filters.sideType === "FAVORITES") {
        filtered = filtered.filter(g => g.market?.homeSpread != null && (
          (g.recommendedTeam === g.home.abbreviation && g.recommendedSpread < 0) ||
          (g.recommendedTeam === g.away.abbreviation && g.recommendedSpread < 0)
        ));
      } else if (state.filters.sideType === "DOGS") {
        filtered = filtered.filter(g => g.market?.homeSpread != null && (
          (g.recommendedTeam === g.home.abbreviation && g.recommendedSpread > 0) ||
          (g.recommendedTeam === g.away.abbreviation && g.recommendedSpread > 0)
        ));
      }

      const dir = state.sort.direction === "ASC" ? 1 : -1;
      filtered.sort((a, b) => {
        switch (state.sort.field) {
          case "EDGE": {
            const va = a.edge ?? 0, vb = b.edge ?? 0;
            return (va - vb) * dir;
          }
          case "KELLY": {
            const va = a.kelly ?? 0, vb = b.kelly ?? 0;
            return (va - vb) * dir;
          }
          case "EV": {
            const va = a.evUnits ?? 0, vb = b.evUnits ?? 0;
            return (va - vb) * dir;
          }
          case "PROB": {
            const va = a.selectedProbability ?? 0, vb = b.selectedProbability ?? 0;
            return (va - vb) * dir;
          }
          case "TIME":
          default: {
            const ta = a.eventDate ? new Date(a.eventDate).getTime() : 0;
            const tb = b.eventDate ? new Date(b.eventDate).getTime() : 0;
            return (ta - tb) * dir;
          }
        }
      });

      return filtered;
    }

    function toggleFilter(key, val) {
      state.filters[key] = !!val;
      render();
    }
    function setStatusFilter(val) {
      state.filters.status = val;
      render();
    }
    function setMinEdgeFilter(val) {
      const n = Number(val);
      state.filters.minEdge = Number.isFinite(n) && n >= 0 ? n : 0;
      render();
    }
    function setMinProbabilityFilter(val) {
      const n = Number(val);
      state.filters.minProbability = Number.isFinite(n) && n > 0 ? clamp(n, 0, 100) / 100 : 0;
      render();
    }
    function setMinZ(value) {
      const raw = String(value ?? "").trim();
      const n = Number(raw);
      state.minZOverride = raw !== "" && Number.isFinite(n) && n >= 0 ? n : null;
      setRiskProfile(state.riskProfile.id);
    }
    function setSideTypeFilter(val) {
      state.filters.sideType = val;
      render();
    }
    function setSortField(field) {
      state.sort.field = field;
      render();
    }
    function toggleSortDirection() {
      state.sort.direction = state.sort.direction === "DESC" ? "ASC" : "DESC";
      render();
    }

    // Render helpers UI
    function renderLogo(team) {
      if (!team.logo) {
        return `<div class="w-11 h-11 rounded-full bg-slate-800 flex items-center justify-center font-black text-xs text-slate-300">${escapeHTML(team.abbreviation)}</div>`;
      }
      return `<img src="${escapeHTML(team.logo)}" alt="${escapeHTML(team.name)}" class="w-11 h-11 object-contain" loading="lazy">`;
    }
    function renderB2BBadge(isB2B) {
      if (!isB2B) return "";
      return `<span class="inline-flex px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[9px] font-bold text-amber-300">B2B</span>`;
    }
    function renderMarketLine(game) {
      if (!game.market.available) {
        return `<span class="text-slate-500">Línea aún no publicada</span>`;
      }
      if (!game.market.lineValid) {
        return `<span class="text-amber-300">Línea inválida / incompleta</span>`;
      }
      return `
        <span>${escapeHTML(game.away.abbreviation)} ${formatSpread(-game.market.homeSpread)}</span>
        <span class="text-slate-600">/</span>
        <span>${escapeHTML(game.home.abbreviation)} ${formatSpread(game.market.homeSpread)}</span>
      `;
    }
    function renderTotalsBlock(game) {
      if (game.totalLine == null || game.overProb == null || game.underProb == null) return "";
      const line = formatNumber(game.totalLine, 1);
      const evClass = (ev) => (ev != null && ev > 0 ? "text-emerald-300 font-bold" : "text-slate-300");
      const side = (label, prob, ev, price) => `
        <div class="rounded-lg bg-slate-900/70 p-2">
          <div class="uppercase text-slate-500">${label} ${line}</div>
          <div class="mt-0.5">
            P: <span class="font-bold">${formatPercentage(prob)}</span>
            · EV: <span class="${evClass(ev)}">${formatNumber(ev, 2)} u</span>
            <span class="text-slate-500">(${formatAmericanPrice(price)})</span>
          </div>
        </div>
      `;
      return `
        <div class="pt-2 mt-2 border-t border-slate-800/80">
          <div class="flex justify-between gap-3">
            <span class="text-slate-500">Totales O/U</span>
            <span class="font-bold">${line}</span>
          </div>
          <div class="mt-1 grid grid-cols-2 gap-2 text-[10px]">
            ${side("Over", game.overProb, game.overEV, game.overPrice)}
            ${side("Under", game.underProb, game.underEV, game.underPrice)}
          </div>
          <div class="text-[9px] text-slate-500 mt-1">Monte Carlo · cuota de referencia ${formatAmericanPrice(game.overPrice)} · informativo</div>
        </div>
      `;
    }
    function setTeamTotal(gameId, side, field, value) {
      const game = (state.games || []).find(g => String(g.id) === String(gameId));
      if (!game) return;
      const sideKey = side === "away" ? "away" : "home";
      const fieldKey = field === "priceOver" || field === "priceUnder" ? field : "line";
      const raw = String(value ?? "").trim().replace(",", ".");
      const parsed = raw === "" ? null : Number(raw);
      let next = null;
      if (Number.isFinite(parsed)) {
        if (fieldKey === "line") next = parsed;
        else if (Math.abs(parsed) >= 100 && Math.abs(parsed) <= 1000) next = parsed;
      }
      const manual = {
        home: { ...(game.teamTotals?.home || {}) },
        away: { ...(game.teamTotals?.away || {}) }
      };
      manual[sideKey][fieldKey] = next;
      game.teamTotals = computeTeamTotals(manual, game.teamScoreSamples);
      saveManualTeamTotal(state.sport.id, state.dateKey, game.id, manual);
      render();
    }
    function renderTeamTotalsBlock(game) {
      const tt = game.teamTotals || {};
      const samples = game.teamScoreSamples || {};
      const hasSamples = ["home", "away"].some(s => Array.isArray(samples[s]) && samples[s].length > 0);
      const evClass = (ev) => (ev != null && ev > 0 ? "text-emerald-300 font-bold" : "text-slate-300");
      const inputClass = "w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-right text-slate-200";
      const valueAttr = (v) => (v == null ? "" : String(v));
      const sideCard = (sideKey, team) => {
        const side = tt[sideKey] || {};
        const probOver = tt[`${sideKey}ProbOver`];
        const probUnder = tt[`${sideKey}ProbUnder`];
        const evOver = tt[`${sideKey}EVOver`];
        const evUnder = tt[`${sideKey}EVUnder`];
        const onChange = (field) => `onchange="setTeamTotal('${game.id}','${sideKey}','${field}',this.value)"`;
        return `
          <div class="rounded-lg bg-slate-900/70 p-2">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold">${escapeHTML(team.abbreviation)}</span>
              <label class="flex items-center gap-1 text-slate-500">
                Línea
                <input type="number" step="0.5" inputmode="decimal" class="${inputClass}"
                  value="${valueAttr(side.line)}" placeholder="—" ${onChange("line")}>
              </label>
            </div>
            <div class="mt-1 grid grid-cols-2 gap-1 text-[10px]">
              <label class="flex items-center gap-1 text-slate-500">
                O
                <input type="number" step="5" inputmode="numeric" class="${inputClass}"
                  value="${valueAttr(side.priceOver)}" placeholder="-110" ${onChange("priceOver")}>
              </label>
              <label class="flex items-center gap-1 text-slate-500">
                U
                <input type="number" step="5" inputmode="numeric" class="${inputClass}"
                  value="${valueAttr(side.priceUnder)}" placeholder="-110" ${onChange("priceUnder")}>
              </label>
            </div>
            <div class="mt-1 grid grid-cols-2 gap-1">
              <div>
                <div class="uppercase text-slate-500">Over${side.line != null ? ` ${formatNumber(side.line, 1)}` : ""}</div>
                <div>P: <span class="font-bold">${probOver != null ? formatPercentage(probOver) : "—"}</span></div>
                <div>EV: <span class="${evClass(evOver)}">${evOver != null ? `${formatNumber(evOver, 3)} u` : "—"}</span></div>
              </div>
              <div>
                <div class="uppercase text-slate-500">Under${side.line != null ? ` ${formatNumber(side.line, 1)}` : ""}</div>
                <div>P: <span class="font-bold">${probUnder != null ? formatPercentage(probUnder) : "—"}</span></div>
                <div>EV: <span class="${evClass(evUnder)}">${evUnder != null ? `${formatNumber(evUnder, 3)} u` : "—"}</span></div>
              </div>
            </div>
          </div>
        `;
      };
      return `
        <div class="pt-2 mt-2 border-t border-slate-800/80">
          <div class="flex justify-between gap-3">
            <span class="text-slate-500">Team Totals (manual)</span>
            <span class="text-slate-500">${hasSamples ? "Monte Carlo" : "sin muestras"}</span>
          </div>
          <div class="mt-1 grid grid-cols-2 gap-2 text-[10px]">
            ${sideCard("away", game.away)}
            ${sideCard("home", game.home)}
          </div>
          <div class="text-[9px] text-slate-500 mt-1">Las cuotas alimentan el EV; los empujes se excluyen. Informativo.</div>
        </div>
      `;
    }
    function renderTotalsSummary(games) {
      if (!Array.isArray(games) || games.length === 0) return "";
      const withTotals = games.filter(g => g.totalLine != null && g.overProb != null && g.underProb != null);
      let bestOver = null;
      let bestUnder = null;
      for (const g of withTotals) {
        if (g.overEV != null && (bestOver == null || g.overEV > bestOver.overEV)) bestOver = g;
        if (g.underEV != null && (bestUnder == null || g.underEV > bestUnder.underEV)) bestUnder = g;
      }
      const evClass = (ev) => (ev != null && ev > 0 ? "text-emerald-300 font-bold" : "text-slate-300");
      const row = (label, game, prob, ev) => {
        if (!game) {
          return `<div class="flex justify-between gap-3 mt-1">
            <span class="text-slate-500">${label}</span>
            <span class="text-slate-500">Sin ${label} calculable.</span>
          </div>`;
        }
        return `<div class="flex justify-between gap-3 mt-1">
          <span class="text-slate-500">${label}</span>
          <span class="text-right text-slate-200">
            ${escapeHTML(game.away.abbreviation)} @ ${escapeHTML(game.home.abbreviation)}
            · O/U ${formatNumber(game.totalLine, 1)}
            · EV: <span class="${evClass(ev)}">${formatNumber(ev, 2)} u</span>
            · P: ${formatPercentage(prob)}
          </span>
        </div>`;
      };
      return `
        <section class="mt-5 mb-4 rounded-2xl bg-[#111524] border border-slate-800 p-3 text-[10px] font-mono">
          <h2 class="font-bold text-xs text-slate-200 mb-1">Mejores Totales del día</h2>
          <div class="text-slate-500 mb-1">${withTotals.length} de ${games.length} partidos con línea · informativo, no genera PLAY</div>
          ${withTotals.length === 0
            ? `<div class="text-slate-500">No hay partidos con línea de totales o aún no se pudo calcular.</div>`
            : `${row("Over", bestOver, bestOver?.overProb, bestOver?.overEV)}
               ${row("Under", bestUnder, bestUnder?.underProb, bestUnder?.underEV)}`}
        </section>
      `;
    }
    function renderLiveBadge(game) {
      if (!game.liveStatus) return "";
      const map = {
        "COVERING": { text: "VAN GANANDO", style: "bg-emerald-500/20 text-emerald-300 border-emerald-500/50" },
        "NOT_COVERING": { text: "VAN PERDIENDO", style: "bg-red-500/20 text-red-300 border-red-500/50" },
        "PUSHING": { text: "EN EL LÍMITE", style: "bg-amber-500/20 text-amber-300 border-amber-500/50" }
      };
      const info = map[game.liveStatus] || { text: game.liveStatus, style: "bg-slate-700 text-slate-300" };
      const probText = game.liveCoverProb != null ? ` · ${formatPercentage(game.liveCoverProb)}` : "";
      return `<span class="px-2.5 py-1 rounded-full ${info.style} border text-[11px] font-black">${info.text}${probText}</span>`;
    }
    function renderPickResultBadge(game) {
      const r = game.pickResult;
      if (!r || r === "PENDING") {
        if (!game.recommendedTeam) return "";
        return `<span class="px-2 py-1 rounded-full bg-slate-800 text-slate-300 text-[10px] font-bold">PENDIENTE</span>`;
      }
      const labels = { "WIN": "GANÓ", "LOSS": "PERDIÓ", "PUSH": "PUSH", "NO BET": "SIN LÍNEA" };
      const styles = {
        "WIN": "bg-emerald-500 text-slate-950 border-emerald-400",
        "LOSS": "bg-red-500 text-white border-red-400",
        "PUSH": "bg-slate-500 text-white border-slate-400",
        "NO BET": "bg-slate-700 text-slate-300"
      };
      const label = labels[r] || r;
      const style = styles[r] || "bg-slate-800 text-slate-300";
      return `<span class="px-2.5 py-1 rounded-full ${style} border text-[11px] font-black tracking-wide">${label}</span>`;
    }
    const ISSUE_LABELS = {
      SPREAD_MISSING: "Spread incompleto",
      PRICE_INVALID: "Cuota inválida",
      PRICE_ESTIMATED: "Cuota estimada",
      PRICE_INCONSISTENT: "Cuotas inconsistentes",
      VIG_HIGH: "Vig alto",
      TOTAL_PRICE_MISSING: "Total sin precio",
      TOTAL_INCOMPLETE: "Total incompleto",
      ML_INCOMPLETE: "Moneyline incompleto",
      LINE_MISSING: "Sin línea",
      OPEN_LINE_MISSING: "Sin apertura",
      POSTPONED: "Pospuesto",
      CANCELED: "Cancelado",
      SUSPENDED: "Suspendido",
      NO_MARKET: "Sin mercado",
      LINE_INVALID: "Línea inválida",
      GAME_STARTED: "Partido iniciado",
      GAME_FINAL: "Finalizado",
      VENUE_CHANGED: "Sede cambiada",
      DATE_CHANGED: "Horario cambiado",
      PITCHER_CHANGED_HOME: "Cambió abridor local",
      PITCHER_CHANGED_AWAY: "Cambió abridor visitante"
    };
    const ALERT_LABELS = {
      NEW_LINE: "Línea nueva",
      LINE_MOVE: "Movimiento de línea",
      PICK_CHANGE: "Cambio de pick",
      OUT_OF_RANGE: "Cuota fuera de rango",
      VALUE_LOST: "Valor eliminado",
      VENUE: "Cambio de sede",
      SCHEDULE: "Cambio de horario",
      PITCHER: "Cambio de abridor"
    };
    const ALERT_STYLES = {
      info: "border-sky-500/25 bg-sky-500/5 text-sky-200",
      warn: "border-amber-500/30 bg-amber-500/5 text-amber-200",
      danger: "border-red-500/30 bg-red-500/5 text-red-200"
    };

    function renderValidationIssues(game) {
      const active = (game.validationIssues || []).filter(i => i.severity !== "closed");
      if (!active.length) return "";
      const hasBlock = active.some(i => i.severity === "block");
      const style = hasBlock
        ? "border-red-500/30 bg-red-500/10 text-red-200"
        : "border-amber-500/25 bg-amber-500/10 text-amber-200";
      return `
        <div class="mt-3 rounded-xl border ${style} p-2.5 text-[10px] leading-relaxed">
          <div class="font-black uppercase tracking-wider text-[9px]">
            ${hasBlock ? "Pick bloqueado · datos dudosos" : "Avisos de línea"}
          </div>
          <ul class="mt-1 space-y-0.5">
            ${active.slice(0, 4).map(i => `<li>· ${escapeHTML(i.message)}</li>`).join("")}
          </ul>
        </div>
      `;
    }

    function renderValidationBadges(game) {
      const active = (game.validationIssues || []).filter(i => i.severity === "block" || i.severity === "warn");
      if (!active.length) return "";
      const hasBlock = active.some(i => i.severity === "block");
      return `<span class="px-1.5 py-0.5 rounded ${hasBlock
        ? "bg-red-500/15 text-red-300 border-red-500/30"
        : "bg-amber-500/15 text-amber-300 border-amber-500/30"} border text-[9px] font-bold"
        title="${escapeHTML(active.map(i => i.message).join(" · "))}">
        ${hasBlock ? "DATOS DUDOSOS" : `${active.length} AVISO${active.length === 1 ? "" : "S"}`}
      </span>`;
    }

    function formatSnapshotLine(snapshot) {
      if (!snapshot || !Number.isFinite(snapshot.homeSpread)) return "—";
      const price = Number.isFinite(snapshot.homePrice) ? ` (${formatAmericanPrice(snapshot.homePrice)})` : "";
      return `${formatSpread(-snapshot.homeSpread)} / ${formatSpread(snapshot.homeSpread)}${price}`;
    }

    function renderLineMovementRows(game) {
      const lm = game.lineMovement;
      if (!lm || !lm.current || !Number.isFinite(lm.current.homeSpread)) return "";
      const o = lm.open || {};
      const c = lm.current || {};
      const closing = lm.closing;
      const spreadDelta = lm.spreadDelta;
      const totalDelta = lm.totalDelta;
      const arrow = delta => !Number.isFinite(delta) || Math.abs(delta) < 0.001
        ? `<span class="text-slate-500">=</span>`
        : delta > 0
          ? `<span class="text-orange-300">▲ ${formatNumber(Math.abs(delta), 1)}</span>`
          : `<span class="text-sky-300">▼ ${formatNumber(Math.abs(delta), 1)}</span>`;
      return `
        <div class="pt-2 mt-2 border-t border-slate-800/80 text-[10px] space-y-1">
          <div class="flex justify-between gap-2">
            <span class="text-slate-500">Movimiento (loc.)</span>
            <span class="text-right">
              ${Number.isFinite(o.homeSpread) || Number.isFinite(c.homeSpread)
                ? `${formatSpread(o.homeSpread)} → ${formatSpread(c.homeSpread)} ${arrow(spreadDelta)}`
                : "—"}
              ${Number.isFinite(o.total) || Number.isFinite(c.total)
                ? `<span class="text-slate-500"> · Total</span> ${formatNumber(o.total, 1)} → ${formatNumber(c.total, 1)} ${arrow(totalDelta)}`
                : ""}
            </span>
          </div>
          <div class="flex justify-between gap-2">
            <span class="text-slate-500">Línea de cierre</span>
            <span class="text-right ${closing ? "text-slate-300" : "text-slate-500"}">
              ${closing ? formatSnapshotLine(closing) : "Pendiente de cierre"}
            </span>
          </div>
        </div>
      `;
    }

    function renderClvPill(clv, compact = false) {
      if (!clv || clv.clvPts == null) return "";
      const positive = clv.clvPts > 0.002;
      const negative = clv.clvPts < -0.002;
      const style = positive
        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
        : negative
          ? "bg-red-500/15 text-red-300 border-red-500/30"
          : "bg-slate-800 text-slate-300 border-slate-700";
      const label = positive ? "Batió el cierre" : negative ? "Perdió vs cierre" : "Sin CLV";
      return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${style} border ${compact ? "text-[9px]" : "text-[10px]"} font-bold"
        title="${escapeHTML(label)} · cierre ${formatAmericanPrice(clv.closingPrice)} · no-vig ${formatPercentage(clv.closingNoVig)}">
        CLV ${formatSignedPctPoints(clv.clvPts)}
      </span>`;
    }

    function renderAlertsPanel() {
      const sportAlerts = state.alerts.filter(a => a.sportId === state.sport.id);
      const alerts = sportAlerts.slice(0, 8);
      const tracked = state.trackedPicks.filter(p => p.sportId === state.sport.id);
      const settledClv = tracked.filter(p => p.clv?.clvPts != null);
      const avgClv = settledClv.length
        ? settledClv.reduce((sum, p) => sum + p.clv.clvPts, 0) / settledClv.length
        : null;
      return `
        <section class="mb-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <h2 class="font-bold text-sm">Alertas de línea</h2>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-mono ${sportAlerts.length
                ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
                : "bg-slate-800 text-slate-400 border border-slate-700"}">
                ${sportAlerts.length}
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-3 text-[10px] font-mono">
              <label class="inline-flex items-center gap-1 cursor-pointer">
                <input type="checkbox" onchange="setAutoTrack(this.checked)" ${state.autoTrack ? "checked" : ""}
                       class="w-3 h-3 text-orange-500 bg-slate-900 border-slate-700 rounded">
                <span class="text-slate-400">Auto-registrar picks para backtesting</span>
              </label>
              <span class="text-slate-500">
                ${tracked.length} registrados${avgClv != null ? ` · CLV medio ${formatSignedPctPoints(avgClv)}` : ""}
              </span>
              <button onclick="markAlertsSeen()" ${sportAlerts.length ? "" : "disabled"}
                      class="px-2 py-1 rounded border border-slate-700 text-slate-300 bg-slate-900 hover:bg-slate-800 disabled:opacity-40">
                Limpiar
              </button>
            </div>
          </div>
          ${alerts.length ? `
            <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
              ${alerts.map(a => `
                <div class="rounded-xl border ${ALERT_STYLES[a.severity] || ALERT_STYLES.info} p-2.5 text-[10px] leading-relaxed">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-black uppercase tracking-wider text-[9px]">
                      ${escapeHTML(ALERT_LABELS[a.type] || a.type)} · ${escapeHTML(a.matchup || "")}
                    </span>
                    <span class="text-[9px] opacity-60 font-mono">
                      ${escapeHTML(new Date(a.createdAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }))}
                    </span>
                  </div>
                  <div class="mt-1 opacity-90">${escapeHTML(a.text)}</div>
                </div>
              `).join("")}
            </div>
          ` : `
            <div class="mt-2 text-[11px] text-slate-500 font-mono">
              Sin alertas recientes. Se avisará de líneas nuevas, movimientos, cambios de pick, cuotas fuera de rango y valor eliminado.
            </div>
          `}
        </section>
      `;
    }

    function renderRiskButtons() {
      return `
        <div class="inline-flex rounded-2xl bg-slate-900/80 border border-slate-800 overflow-hidden text-[11px]">
          ${Object.values(RISK_PROFILES).map(p => `
            <button onclick="setRiskProfile('${p.id}')"
                    class="px-3 py-1.5 ${p.id === state.riskProfile.id ? "bg-orange-500 text-white" : "text-slate-300 hover:bg-slate-800"} font-bold border-r border-slate-800 last:border-r-0">
              ${escapeHTML(p.label)}
            </button>
          `).join("")}
        </div>
      `;
    }
    function renderSportButtons() {
      return `
        <div class="inline-flex rounded-2xl bg-slate-900/80 border border-slate-800 overflow-hidden text-[11px]">
          ${Object.values(SPORTS).map(sp => `
            <button onclick="setSport('${sp.id}')"
                    class="px-3 py-1.5 ${sp.id === state.sport.id ? "bg-emerald-500 text-slate-950" : "text-slate-300 hover:bg-slate-800"} font-bold border-r border-slate-800 last:border-r-0">
              ${escapeHTML(sp.label)}
            </button>
          `).join("")}
        </div>
      `;
    }

    function setOddsKeyDraft(value) {
      state.oddsKeyDraft = String(value ?? "");
    }
    function getTrackedBookNames() {
      const names = new Set();
      for (const game of state.games) {
        for (const offer of game.market?.offers || []) {
          if (offer.lineValid) names.add(offer.provider);
        }
      }
      return names;
    }
    function renderOddsProviderPanel() {
      const alt = state.altOdds;
      const hasKey = !!state.oddsApiKey;
      const books = getTrackedBookNames();
      const matched = state.games.filter(g => g.market?.hasAltBooks).length;
      const autoRefreshMinutes = Math.round(ODDS_API_CONFIG.cacheTtlMs / 60000);
      const statusChips = hasKey ? `
        <div class="mt-2 flex flex-wrap gap-1.5 text-[9px] font-mono text-slate-400">
          <span class="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">The Odds API</span>
          <span class="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">${books.size} casas</span>
          <span class="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">${matched}/${state.games.length} partidos cruzados</span>
          ${alt.updatedAt ? `<span class="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">Actualizado: ${escapeHTML(formatUpdatedTime(alt.updatedAt))}${alt.fromCache ? " · caché" : ""}</span>` : ""}
          ${alt.requestsRemaining != null ? `<span class="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">Créditos restantes: ${alt.requestsRemaining}</span>` : ""}
        </div>
      ` : "";
      return `
        <section class="mb-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
            <div class="max-w-xl">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="font-bold text-sm">Proveedor alternativo de cuotas</h2>
                <span class="px-2 py-0.5 rounded-full bg-orange-500/10 border border-orange-500/20 text-[9px] font-black text-orange-300">MULTI-CASA</span>
              </div>
              <p class="text-[10px] text-slate-500 mt-1 leading-relaxed">
                ESPN solo publica la línea de DraftKings. Conecta The Odds API para comparar varias casas,
                ver la mejor cuota de cada lado y usar la mejor línea disponible en edge/Kelly.
              </p>
              ${statusChips}
              ${alt.error ? `<div class="mt-2 text-[10px] text-red-300">${escapeHTML(alt.error)}</div>` : ""}
              ${state.altMarkets.error
                ? `<div class="mt-2 text-[10px] text-amber-300/90">${escapeHTML(state.altMarkets.error)}</div>`
                : state.altMarkets.loading
                  ? `<div class="mt-2 text-[10px] text-slate-500">Consultando líneas alternativas…</div>`
                  : ""}
            </div>
            <div class="flex flex-col items-stretch lg:items-end gap-2 min-w-[290px]">
              <div class="flex gap-1.5">
                <input id="oddsApiKeyInput" type="password" autocomplete="off" spellcheck="false"
                       placeholder="${hasKey ? "Pega otra key para reemplazarla" : "API key de The Odds API"}"
                       value="${escapeHTML(state.oddsKeyDraft)}"
                       oninput="setOddsKeyDraft(this.value)"
                       class="flex-1 min-w-0 bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 text-[10px]">
                <button onclick="saveOddsApiKeyFromInput()"
                        class="px-2.5 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-slate-950 text-[10px] font-black whitespace-nowrap">
                  Guardar
                </button>
              </div>
              <div class="flex flex-wrap gap-1.5 justify-end">
                <button onclick="refreshAltOdds({ force: true })"
                        ${!hasKey || alt.loading || state.loading ? "disabled" : ""}
                        class="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold">
                  ${alt.loading ? "Actualizando..." : "Actualizar cuotas"}
                </button>
                ${hasKey ? `
                  <button onclick="clearOddsApiKey()"
                          class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold">
                    Quitar key
                  </button>
                ` : ""}
                <a href="https://the-odds-api.com" target="_blank" rel="noopener noreferrer"
                   class="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-[10px] font-bold hover:bg-slate-800">
                  Obtener key gratis
                </a>
              </div>
              <div class="text-[9px] text-slate-600 text-right max-w-[330px] leading-relaxed">
                La key se guarda solo en este navegador. Cada actualización consume 1 crédito;
                el modo automático reutiliza el caché durante ${autoRefreshMinutes} min.
              </div>
            </div>
          </div>
        </section>
      `;
    }

    function renderBooksComparison(game) {
      const offers = (game.market?.offers || []).filter(o => o.lineValid);
      if (offers.length < 2) return "";
      const bestHome = game.bestLines?.home || null;
      const bestAway = game.bestLines?.away || null;
      const adoptedId = game.bestLine?.offerId || "";
      const pickIsHome = game.recommendedTeam === game.home.abbreviation;
      const pickIsAway = game.recommendedTeam === game.away.abbreviation;
      const pickPrice = o => pickIsHome ? o.homePrice : pickIsAway ? o.awayPrice : 0;
      const sorted = offers.slice().sort((a, b) => {
        if (a.id === adoptedId) return -1;
        if (b.id === adoptedId) return 1;
        return (pickPrice(b) - pickPrice(a)) || String(a.provider).localeCompare(String(b.provider));
      });
      const renderCell = (offer, isHome) => {
        const spread = isHome ? offer.homeSpread : -offer.homeSpread;
        const price = isHome ? offer.homePrice : offer.awayPrice;
        const best = isHome ? bestHome : bestAway;
        const isBest = !!best && best.offerId === offer.id;
        const isPick = (isHome && pickIsHome) || (isHome === false && pickIsAway);
        const team = isHome ? game.home.abbreviation : game.away.abbreviation;
        return `
          <td class="py-1.5 px-2 text-right whitespace-nowrap ${isBest ? "text-emerald-300 font-bold" : "text-slate-300"}">
            ${isPick ? `<span class="text-orange-400 mr-0.5">&#9670;</span>` : ""}
            ${escapeHTML(team)} ${formatSpread(spread)}
            <span class="${isBest ? "text-emerald-200" : "text-slate-500"}">${formatAmericanPrice(price)}</span>
            ${isBest ? `<span class="ml-1 px-1 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[8px] font-black text-emerald-300">MEJOR</span>` : ""}
          </td>
        `;
      };
      const summary = game.bestLine
        ? `${escapeHTML(game.bestLine.provider)} · ${escapeHTML(game.bestLine.side)} ${formatSpread(game.bestLine.pickSpread)} (${formatAmericanPrice(game.bestLine.price)})`
        : "—";
      const maxGap = state.sport.id === "MLB" ? "0.5" : "1.5";
      return `
        <details class="mt-3 rounded-xl border border-slate-800 bg-[#090d18] p-3">
          <summary class="flex items-center justify-between gap-2 cursor-pointer select-none [&::-webkit-details-marker]:hidden">
            <span class="text-[10px] uppercase tracking-wider text-slate-500">
              Comparar ${offers.length} casas
            </span>
            <span class="text-[10px] font-mono text-emerald-300 font-bold text-right">
              Mejor: ${summary}
            </span>
          </summary>
          <div class="mt-2 overflow-x-auto">
            <table class="min-w-full text-[10px] font-mono">
              <thead>
                <tr class="text-slate-500">
                  <th class="text-left py-1 px-1 font-normal">Casa</th>
                  <th class="text-right py-1 px-2 font-normal">${escapeHTML(game.away.abbreviation)}</th>
                  <th class="text-right py-1 px-2 font-normal">${escapeHTML(game.home.abbreviation)}</th>
                </tr>
              </thead>
              <tbody>
                ${sorted.map(o => `
                  <tr class="border-t border-slate-800/70 ${o.id === adoptedId ? "bg-emerald-500/5" : ""}">
                    <td class="py-1.5 px-1 text-slate-400 whitespace-nowrap">
                      ${escapeHTML(o.provider)}${o.estimatedPrice ? `<span class="text-slate-600" title="Precio estimado">~</span>` : ""}
                    </td>
                    ${renderCell(o, false)}
                    ${renderCell(o, true)}
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
          <div class="mt-2 text-[9px] text-slate-500 leading-relaxed">
            &#9670; = lado recomendado. La mejor línea se elige por EV del modelo sobre ese lado,
            priorizando cuotas dentro del rango del perfil (máx. ${maxGap} pts de diferencia vs. la línea principal).
          </div>
        </details>
      `;
    }

    // Sparkline de distribución del margen
    function renderMarginSparkline(game) {
      const w = 120, h = 26;
      if (game.marginP10 == null || game.marginP50 == null || game.marginP90 == null) return "";
      const mkt = game.market?.homeSpread;
      const minX = Math.min(game.marginP10, mkt != null ? -mkt - 5 : game.marginP10 - 5, -5);
      const maxX = Math.max(game.marginP90, mkt != null ? -mkt + 5 : game.marginP90 + 5, 5);
      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || minX === maxX) return "";
      const scaleX = x => ((x - minX) / (maxX - minX)) * w;

      const zeroX = scaleX(0);
      const mktX = Number.isFinite(mkt) ? scaleX(-mkt) : null;
      const p10X = scaleX(game.marginP10);
      const p50X = scaleX(game.marginP50);
      const p90X = scaleX(game.marginP90);

      return `
        <svg viewBox="0 0 ${w} ${h}" class="w-full h-[26px]">
          <line x1="${zeroX}" y1="0" x2="${zeroX}" y2="${h}" stroke="#64748b" stroke-width="0.5" />
          ${mktX != null ? `<line x1="${mktX}" y1="0" x2="${mktX}" y2="${h}" stroke="#fb923c" stroke-width="0.7" stroke-dasharray="2,2" />` : ""}
          <line x1="${p10X}" y1="${h/2}" x2="${p90X}" y2="${h/2}" stroke="#22c55e" stroke-width="1.4" />
          <line x1="${p50X}" y1="${h/2 - 5}" x2="${p50X}" y2="${h/2 + 5}" stroke="#22c55e" stroke-width="1.4" />
        </svg>
      `;
    }

    function renderModelInputs(game) {
      const inputs = game.modelInputs;
      if (!inputs) return "";
      if (inputs.type === "NBA") {
        const teamRow = (team, side) => {
          const injuries = (team.injuries || [])
            .map(inj => `${escapeHTML((inj.comment || inj.status || "Baja").slice(0, 70))}`)
            .join(" · ");
          return `
            <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-0.5 border-t border-slate-900/70">
              <span class="text-slate-300">${escapeHTML(side)} ${escapeHTML(team.abbreviation)}</span>
              <span class="text-slate-400">
                ORtg ${team.ortg != null ? formatNumber(team.ortg, 1) : "—"} /
                DRtg ${team.drtg != null ? formatNumber(team.drtg, 1) : "—"}
                (net ${team.netRating != null ? (team.netRating > 0 ? "+" : "") + formatNumber(team.netRating, 1) : "—"})
                · eFG ${team.efg != null ? formatPercentage(team.efg, 1) : "—"}
                · 3P% ${team.threePct != null ? formatPercentage(team.threePct, 1) : "—"}
                · FT% ${team.ftPct != null ? formatPercentage(team.ftPct, 1) : "—"}
                · TO% ${team.tovPct != null ? formatPercentage(team.tovPct, 1) : "—"}
                · OREB ${team.oreb != null ? formatNumber(team.oreb, 1) : "—"}
                · REB ${team.reb != null ? formatNumber(team.reb, 1) : "—"}
              </span>
              ${injuries ? `<span class="text-amber-300/90 w-full">Lesiones: ${injuries}</span>` : ""}
            </div>
          `;
        };
        return `
          <details class="mt-2 rounded-xl bg-[#0b0f1c] border border-slate-800 p-2 text-[10px] font-mono">
            <summary class="cursor-pointer text-slate-400">
              Modelo enriquecido NBA:
              Pace ${formatNumber(inputs.expectedPoss, 1)} ·
              Total ${inputs.expectedTotal != null ? formatNumber(inputs.expectedTotal, 1) : "—"} ·
              Ajuste lesiones ${inputs.injuryAdjustment > 0 ? "+" : ""}${formatNumber(inputs.injuryAdjustment, 2)} ·
              Var ×${formatNumber(inputs.varianceFactor, 2)}
            </summary>
            <div class="mt-1.5">
              ${teamRow(inputs.home, "LOC")}
              ${teamRow(inputs.away, "VIS")}
            </div>
          </details>
        `;
      }
      if (inputs.type === "MLB") {
        const pitcherRow = (pitcher, side) => {
          if (!pitcher) return `<div class="text-slate-500">${side}: abridor sin estadísticas disponibles.</div>`;
          return `
            <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-0.5 border-t border-slate-900/70">
              <span class="text-slate-300">${escapeHTML(side)} ${escapeHTML(pitcher.name)} ${pitcher.hand ? `(${escapeHTML(pitcher.hand)})` : ""}</span>
              <span class="text-slate-400">
                ERA ${pitcher.era != null ? formatNumber(pitcher.era, 2) : "—"} ·
                FIP ${pitcher.fip != null ? formatNumber(pitcher.fip, 2) : "—"} ·
                K% ${pitcher.kPct != null ? formatPercentage(pitcher.kPct, 1) : "—"} ·
                BB% ${pitcher.bbPct != null ? formatPercentage(pitcher.bbPct, 1) : "—"} ·
                GB% ${pitcher.gbPct != null ? formatPercentage(pitcher.gbPct, 1) : "—"}
                ${Number.isFinite(pitcher.ip) ? ` · ${formatNumber(pitcher.ip, 1)} IP` : ""}
              </span>
            </div>
          `;
        };
        const teamRow = (team, side) => {
          if (!team) return "";
          return `
            <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-0.5 border-t border-slate-900/70">
              <span class="text-slate-300">${escapeHTML(side)} ${escapeHTML(team.abbreviation)}</span>
              <span class="text-slate-400">
                ${team.runsPerGame != null ? formatNumber(team.runsPerGame, 2) : "—"} R/G ·
                ${team.runsAllowedPerGame != null ? formatNumber(team.runsAllowedPerGame, 2) : "—"} RA/G ·
                ERA equipo ${team.era != null ? formatNumber(team.era, 2) : "—"}
              </span>
            </div>
          `;
        };
        const bullpenRow = (team, side) => {
          if (!team) return "";
          const bp = team.bullpen;
          if (bp) {
            return `
              <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-0.5 border-t border-slate-900/70">
                <span class="text-slate-300">${escapeHTML(side)} Bullpen (relevistas)</span>
                <span class="text-slate-400">
                  ERA ${bp.era != null ? formatNumber(bp.era, 2) : "—"} ·
                  FIP ${bp.fip != null ? formatNumber(bp.fip, 2) : "—"} ·
                  K% ${bp.kPct != null ? formatPercentage(bp.kPct, 1) : "—"} ·
                  BB% ${bp.bbPct != null ? formatPercentage(bp.bbPct, 1) : "—"}
                  ${Number.isFinite(bp.ip) ? ` · ${formatNumber(bp.ip, 0)} IP` : ""}
                </span>
              </div>
            `;
          }
          if (team.era != null) {
            return `
              <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-0.5 border-t border-slate-900/70">
                <span class="text-slate-300">${escapeHTML(side)} Bullpen</span>
                <span class="text-slate-500">proxy ERA equipo ${formatNumber(team.era, 2)} (sin split de relevistas)</span>
              </div>
            `;
          }
          return "";
        };
        return `
          <details class="mt-2 rounded-xl bg-[#0b0f1c] border border-slate-800 p-2 text-[10px] font-mono">
            <summary class="cursor-pointer text-slate-400">
              Modelo enriquecido MLB:
              Park ×${formatNumber(inputs.park, 2)} ·
              Clima ×${formatNumber(inputs.weatherFactor ?? 1, 2)} ·
              Total ${game.modelExpectedTotal != null ? formatNumber(game.modelExpectedTotal, 2) : "—"}
            </summary>
            <div class="mt-1.5">
              <div class="text-slate-500 py-0.5">
                Clima: ${inputs.weather
                  ? `${inputs.weather.temp != null ? `${formatNumber(inputs.weather.temp, 0)}°F` : "—"}
                     ${inputs.weather.condition ? `· ${escapeHTML(inputs.weather.condition)}` : ""}
                     ${inputs.weather.wind ? `· ${escapeHTML(inputs.weather.wind)}` : ""}`
                  : "no disponible (domo o sin reporte)"}
              </div>
              ${pitcherRow(inputs.homePitcher, "LOC")}
              ${pitcherRow(inputs.awayPitcher, "VIS")}
              ${teamRow(inputs.homeTeam, "LOC")}
              ${teamRow(inputs.awayTeam, "VIS")}
              ${bullpenRow(inputs.homeTeam, "LOC")}
              ${bullpenRow(inputs.awayTeam, "VIS")}
            </div>
          </details>
        `;
      }
      return "";
    }

    function renderGameCardDetailed(game) {
      const border = game.qualified ? "border-emerald-500/50 card-glow" : "border-slate-800";
      const statusBadge = game.qualified
        ? `<span class="px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[10px] font-black">PLAY</span>`
        : `<span class="px-2 py-1 rounded-full bg-slate-800 text-slate-400 text-[10px] font-black">SIN APUESTA</span>`;
      const scoreVisible = game.awayScore !== null && game.homeScore !== null &&
        (game.statusName !== "STATUS_SCHEDULED" || game.awayScore > 0 || game.homeScore > 0);
      const unit = state.sport.unitName;
      const existingPick = findExistingPick(game);
      const minZ = getEffectiveMinZ(state.riskProfile);
      const zWeak = game.zEdge != null && game.zEdge < minZ;

      const rawStake = recommendedStakeUnits(game.kelly ?? 0, state.bankroll, state.maxStakePerBetPct);
      const stake = plannedStakeFor(game, rawStake);

      return `
        <article class="rounded-2xl border ${border} bg-[#121624]/95 overflow-hidden">
          <div class="p-4 border-b border-slate-800/80">
            <div class="flex justify-between items-start gap-3">
              <div>
                <div class="text-xs font-mono text-slate-400">${escapeHTML(game.time)}</div>
                <div class="text-[10px] text-slate-500 mt-1">${escapeHTML(game.status)}</div>
              </div>
              <div class="flex flex-col items-end gap-1">
                ${statusBadge}
                ${renderLiveBadge(game)}
                ${renderPickResultBadge(game)}
                ${renderClvPill(game.clv)}
                ${renderAltMarketsBadge(game)}
                ${renderValidationBadges(game)}
              </div>
            </div>
          </div>
          <div class="p-4">
            <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div>
                <div class="flex items-center gap-2">
                  ${renderLogo(game.away)}
                  <div>
                    <div class="font-black text-lg">${escapeHTML(game.away.abbreviation)}</div>
                    <div class="text-[10px] text-slate-500">${escapeHTML(game.away.record)}</div>
                  </div>
                </div>
                <div class="mt-2">${renderB2BBadge(game.awayB2B)}</div>
              </div>
              <div class="text-center">
                ${scoreVisible
                  ? `<div class="font-black text-xl">${game.awayScore}<span class="text-slate-600 mx-1">-</span>${game.homeScore}</div>`
                  : `<div class="text-slate-600 font-black">@</div>`}
              </div>
              <div class="text-right">
                <div class="flex justify-end items-center gap-2">
                  <div>
                    <div class="font-black text-lg">${escapeHTML(game.home.abbreviation)}</div>
                    <div class="text-[10px] text-slate-500">${escapeHTML(game.home.record)}</div>
                  </div>
                  ${renderLogo(game.home)}
                </div>
                <div class="mt-2">${renderB2BBadge(game.homeB2B)}</div>
              </div>
            </div>

            <div class="mt-4 rounded-xl bg-[#090d18] border border-slate-800 p-3 font-mono text-xs space-y-2">
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">Línea</span>
                <span class="flex flex-wrap justify-end gap-1">${renderMarketLine(game)}</span>
              </div>
              ${renderAltMarketsNote(game)}
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">Casas</span>
                <span>${(game.market.booksCount || game.market.offers?.length || 0) > 1
                  ? `${game.market.booksCount} comparadas`
                  : escapeHTML(game.market.provider)}</span>
              </div>
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">Spread proyectado</span>
                <span class="text-orange-300 font-bold">${escapeHTML(game.home.abbreviation)} ${formatSpread(game.fairHomeSpread)}</span>
              </div>
              ${renderTotalsBlock(game)}
              ${renderTeamTotalsBlock(game)}
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">Ganador proyectado</span>
                <span>${escapeHTML(game.projectedWinner)} por ${formatNumber(game.projectedMargin)} ${unit}</span>
              </div>
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">P(local gana)</span>
                <span>${formatPercentage(game.homeWinProbability)}</span>
              </div>
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">P(mercado sin vig loc.)</span>
                <span>${game.marketHomeNoVig != null ? formatPercentage(game.marketHomeNoVig) : "—"}</span>
              </div>
              ${game.selectedNoVig != null ? `
                <div class="flex justify-between gap-3">
                  <span class="text-slate-500">No-vig selección (${escapeHTML(game.recommendedTeam || "")})</span>
                  <span>${formatPercentage(game.selectedNoVig)}</span>
                </div>
              ` : ""}
              ${game.modelVsMarketPts != null ? `
                <div class="flex justify-between gap-3">
                  <span class="text-slate-500">Modelo − mercado</span>
                  <span class="${game.modelVsMarketPts > 0 ? "text-emerald-300" : "text-red-300"} font-bold">
                    ${formatSignedPctPoints(game.modelVsMarketPts)}
                  </span>
                </div>
              ` : ""}
              ${game.consensusEdge != null ? `
                <div class="flex justify-between gap-3">
                  <span class="text-slate-500">Consenso ${game.consensusBooks || 1} casa${(game.consensusBooks || 1) === 1 ? "" : "s"}</span>
                  <span class="${game.consensusEdge >= 0 ? "text-emerald-300" : "text-amber-300"} font-bold">
                    ${formatSignedPctPoints(game.consensusEdge)}
                  </span>
                </div>
              ` : ""}
              <div class="flex justify-between gap-3">
                <span class="text-slate-500">Percentiles margen loc.</span>
                <span class="text-right">
                  P10: ${formatNumber(game.marginP10)} ·
                  P50: ${formatNumber(game.marginP50)} ·
                  P90: ${formatNumber(game.marginP90)}
                </span>
              </div>
              <div class="mt-1">
                ${renderMarginSparkline(game)}
              </div>
              ${renderLineMovementRows(game)}

              ${state.sport.id === "MLB" ? `
                <div class="pt-2 mt-2 border-t border-slate-800/80 text-[10px] grid grid-cols-2 gap-2">
                  <div>
                    <div class="text-slate-500">ML loc/vis</div>
                    <div class="mt-0.5">
                      Loc: ${game.mlHomeProb != null ? formatPercentage(game.mlHomeProb) : "—"}
                      · Vis: ${game.mlAwayProb != null ? formatPercentage(game.mlAwayProb) : "—"}
                    </div>
                  </div>
                  <div>
                    <div class="text-slate-500">RL -1.5 / +1.5</div>
                    <div class="mt-0.5">
                      Loc -1.5: ${game.rlHomeMinus15Prob != null ? formatPercentage(game.rlHomeMinus15Prob) : "—"}
                      · Vis +1.5: ${game.rlAwayPlus15Prob != null ? formatPercentage(game.rlAwayPlus15Prob) : "—"}
                    </div>
                  </div>
                </div>
              ` : ""}
            </div>

            ${renderValidationIssues(game)}

            ${game.market.available ? `
              <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                <div class="rounded-lg bg-slate-900/70 p-2 text-center">
                  <div class="text-[9px] uppercase text-slate-500">Edge</div>
                  <div class="${game.qualified ? "text-emerald-300" : "text-slate-300"} font-black text-sm">
                    ${formatNumber(game.edge)} ${unit}
                  </div>
                  <div class="text-[9px] text-slate-500">
                    Rel: ${formatPercentage(game.edgeRelative ?? 0, 0)} ·
                    <span class="${zWeak ? "text-amber-300 font-bold" : "text-slate-400"}">zEdge: ${game.zEdge != null ? formatNumber(game.zEdge, 2) : "—"}</span>
                  </div>
                </div>
                <div class="rounded-lg bg-slate-900/70 p-2 text-center">
                  <div class="text-[9px] uppercase text-slate-500">P. cubrir</div>
                  <div class="font-black text-sm">
                    ${formatPercentage(game.selectedProbability ?? 0.5)}
                  </div>
                  <div class="text-[9px] text-slate-500">
                    Odds: ${formatAmericanPrice(game.selectedPrice)}
                  </div>
                </div>
                <div class="rounded-lg bg-slate-900/70 p-2 text-center">
                  <div class="text-[9px] uppercase text-slate-500">EV (1u)</div>
                  <div class="${(game.evUnits ?? 0) > 0 ? "text-emerald-300" : (game.evUnits ?? 0) < 0 ? "text-red-300" : "text-slate-300"} font-black text-sm">
                    ${game.evUnits != null && game.recommendedTeam
                      ? `${game.evUnits > 0 ? "+" : ""}${formatNumber(game.evUnits, 3)}u`
                      : "—"}
                  </div>
                  <div class="text-[9px] text-slate-500">
                    ${game.recommendedTeam ? "Riesgo 1u" : "Sin selección"}
                  </div>
                </div>
                <div class="rounded-lg bg-slate-900/70 p-2 text-center">
                  <div class="text-[9px] uppercase text-slate-500">Kelly / Stake</div>
                  <div class="font-black text-sm">
                    ${formatNumber(game.kelly ?? 0)}%
                  </div>
                  <div class="text-[9px] text-slate-500">
                    Stake: $${formatNumber(stake, 2)}${game.kellyCap != null ? ` · cap ${formatNumber(game.kellyCap, 1)}%` : ""}
                  </div>
                </div>
              </div>

              <div class="mt-2 grid grid-cols-3 gap-2 text-[10px] font-mono">
                <div class="rounded-lg bg-slate-900/60 p-2 text-center">
                  <div class="text-slate-500">Teaser +4</div>
                  <div>${formatPercentage(game.probTeaser4 ?? 0.5)}</div>
                </div>
                <div class="rounded-lg bg-slate-900/60 p-2 text-center">
                  <div class="text-slate-500">Teaser +7</div>
                  <div>${formatPercentage(game.probTeaser7 ?? 0.5)}</div>
                </div>
                <div class="rounded-lg bg-slate-900/60 p-2 text-center">
                  <div class="text-slate-500">Fav gana sin cubrir</div>
                  <div>${formatPercentage(game.probFavWinNoCover ?? 0)}</div>
                </div>
              </div>
            ` : `
              <div class="mt-3 rounded-lg bg-orange-500/5 border border-orange-500/10 p-3 text-[11px] text-orange-200/80">
                El modelo calculó el spread probable, pero no puede evaluar edge/Kelly hasta que haya línea de mercado.
              </div>
            `}

            ${renderBooksComparison(game)}

            ${renderModelInputs(game)}

            ${game.qualified && game.recommendedTeam ? `
              <div class="mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3">
                <div class="text-[10px] uppercase tracking-wider text-emerald-400">
                  Selección (${escapeHTML(state.riskProfile.label)})
                </div>
                <div class="mt-1 text-lg font-black text-emerald-300">
                  ${escapeHTML(game.recommendedTeam)} ${formatSpread(game.recommendedSpread)}
                </div>
                <div class="text-[10px] text-emerald-200/60 mt-1">
                  Cuota: ${formatAmericanPrice(game.selectedPrice)}${game.bestLine ? ` en ${escapeHTML(game.bestLine.provider)}` : ""} ·
                  Kelly: ${formatNumber(game.kelly)}% ·
                  Stake: $${formatNumber(stake, 2)}
                </div>
                ${game.selectedNoVig != null ? `
                  <div class="text-[10px] text-emerald-200/60 mt-1">
                    No-vig entrada: ${formatPercentage(game.selectedNoVig)} ·
                    Modelo: ${formatPercentage(game.selectedProbability)}
                    ${game.consensusEdge != null
                      ? ` · Consenso: <span class="${game.consensusEdge >= 0 ? "text-emerald-300" : "text-amber-300"}">${formatSignedPctPoints(game.consensusEdge)}</span> (${game.consensusBooks || 1})`
                      : ""}
                  </div>
                ` : ""}
                ${game.clv ? `
                  <div class="mt-1">${renderClvPill(game.clv)}</div>
                ` : ""}
                ${game.bestLine && game.bestLine.improved ? `
                  <div class="text-[10px] text-orange-300/90 mt-1 font-bold">
                    Mejor línea disponible: ${formatLineImprovement(game.bestLine)}
                  </div>
                ` : ""}
              </div>
            ` : ""}

            ${(function () {
              const label = existingPick ? "Quitar pick oficial" : "Marcar como pick oficial";
              const style = existingPick
                ? "bg-red-600 hover:bg-red-500"
                : "bg-indigo-600 hover:bg-indigo-500";
              const info = existingPick
                ? `<div class="mt-1 text-[10px] text-indigo-200/70">
                     Pick congelado: ${escapeHTML(existingPick.pickTeam)} ${formatSpread(existingPick.pickSpread)}
                     (${existingPick.price > 0 ? "+" : ""}${existingPick.price})
                   </div>`
                : "";
              return `
                <div class="mt-3 flex flex-col items-stretch gap-1">
                  <button
                    onclick="toggleOfficialPickById('${game.id}')"
                    class="w-full px-3 py-2 rounded-xl ${style} text-[11px] font-black tracking-wide"
                  >
                    ${label}
                  </button>
                  ${info}
                </div>
              `;
            })()}

            <button
              onclick="openAddBetFromGame('${game.id}')"
              class="mt-2 w-full px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-mono font-bold text-slate-200"
            >
              + Añadir al cuaderno
            </button>
          </div>
        </article>
      `;
    }

    function renderGameCardCompact(game) {
      const unit = state.sport.unitName;
      const existingPick = findExistingPick(game);
      const minZ = getEffectiveMinZ(state.riskProfile);
      const zWeak = game.zEdge != null && game.zEdge < minZ;
      const rowClass = game.qualified ? "border-emerald-500/40 bg-emerald-500/5" : "border-slate-800 bg-[#111524]";
      const stake = plannedStakeFor(game, recommendedStakeUnits(game.kelly ?? 0, state.bankroll, state.maxStakePerBetPct));
      const lm = game.lineMovement;
      return `
        <article class="rounded-xl border ${rowClass} px-3 py-2 flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono">
          <div class="flex items-center gap-2 min-w-[110px]">
            <span class="font-bold text-slate-200">${escapeHTML(game.away.abbreviation)}</span>
            <span class="text-slate-500">@</span>
            <span class="font-bold text-slate-200">${escapeHTML(game.home.abbreviation)}</span>
          </div>
          <div class="flex flex-col text-[10px] text-slate-400 min-w-[110px]">
            <span>${escapeHTML(game.time)}</span>
            <span class="text-slate-500 truncate max-w-[140px]">${escapeHTML(game.status)}</span>
          </div>
          <div class="flex flex-col text-right min-w-[130px]">
            <span class="text-slate-400">
              Mkt: ${game.market.available ? formatSpread(game.market.homeSpread) : "—"}
            </span>
            <span class="text-orange-300 font-bold">
              Proy: ${formatSpread(game.fairHomeSpread)}
            </span>
          </div>
          <div class="flex flex-col text-right min-w-[130px]">
            <span class="${game.qualified ? "text-emerald-300" : "text-slate-300"} font-bold">
              Edge: ${formatNumber(game.edge ?? 0, 2)} ${unit} · <span class="${zWeak ? "text-amber-300" : ""}">zEdge: ${game.zEdge != null ? formatNumber(game.zEdge, 2) : "—"}</span>
            </span>
            <span class="text-slate-400">
              ${
                (() => {
                  return `K: ${formatNumber(game.kelly ?? 0, 1)}% · Stk: $${formatNumber(stake, 2)} · EV: ${game.evUnits != null && game.recommendedTeam ? `${game.evUnits > 0 ? "+" : ""}${formatNumber(game.evUnits, 2)}u` : "—"}`;
                })()
              }
            </span>
            ${game.consensusEdge != null ? `
              <span class="${game.consensusEdge >= 0 ? "text-emerald-300/80" : "text-amber-300/80"}">
                Consenso: ${formatSignedPctPoints(game.consensusEdge)} (${game.consensusBooks || 1})
              </span>
            ` : ""}
            ${game.modelInputs?.type === "NBA" ? `
              <span class="text-slate-500">Pace ${formatNumber(game.modelInputs.expectedPoss, 1)}</span>
            ` : game.modelInputs?.type === "MLB" ? `
              <span class="text-slate-500">Park ×${formatNumber(game.modelInputs.park, 2)}</span>
            ` : ""}
            ${game.bestLine && (game.market.booksCount || 0) > 1 ? `
              <span class="text-emerald-300/80">
                Mejor: ${escapeHTML(game.bestLine.provider)} ${formatAmericanPrice(game.bestLine.price)}
              </span>
            ` : ""}
          </div>
          <div class="flex flex-col items-end gap-0.5 min-w-[96px]">
            ${lm && Number.isFinite(lm.current?.homeSpread) ? `
              <span class="text-slate-400">
                Línea: ${formatSpread(lm.open?.homeSpread)} → ${formatSpread(lm.current.homeSpread)}
              </span>
            ` : ""}
            ${renderClvPill(game.clv, true)}
          </div>
          <div class="flex flex-col items-end gap-0.5 min-w-[80px]">
            ${game.qualified
              ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[9px] font-bold">PLAY</span>`
              : `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 text-[9px] font-bold">NO PLAY</span>`
            }
            ${renderValidationBadges(game)}
            ${renderAltMarketsBadge(game, true)}
            ${existingPick ? `<span class="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-200 border border-indigo-500/40 text-[9px] font-bold">PICK</span>` : ""}
          </div>
        </article>
      `;
    }

    function generatePDF() {
      if (!state.games.length) {
        alert("No hay datos para exportar.");
        return;
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

      doc.setFontSize(16);
      doc.setTextColor(30, 30, 30);
      doc.text("Lord's Predictions — " + state.sport.label, 14, 15);
      doc.setFontSize(10);
      doc.setTextColor(80, 80, 80);
      doc.text(state.dateLabel + "  |  Perfil: " + state.riskProfile.label + "  |  " + new Date().toLocaleString("es-MX"), 14, 22);

      const headers = [
        "Partido", "Hora", "Spread Proyectado", "Pick", "Casa / Cuota", "Edge", "P. Cubrir", "Kelly", "Estado"
      ];

      const rows = state.games.map(g => {
        const matchup = g.away.abbreviation + " @ " + g.home.abbreviation;
        const proj = g.home.abbreviation + " " + formatSpread(g.fairHomeSpread);
        const pick = g.recommendedTeam
          ? g.recommendedTeam + " " + formatSpread(g.recommendedSpread)
          : "—";
        const book = g.recommendedTeam
          ? `${g.bestLine?.provider || g.market?.provider || "—"} ${formatAmericanPrice(g.selectedPrice)}`
          : "—";
        const edge = g.edge != null ? formatNumber(g.edge) + " " + state.sport.unitName : "—";
        const prob = g.selectedProbability != null ? formatPercentage(g.selectedProbability) : "—";
        const kelly = g.kelly != null ? formatNumber(g.kelly) + "%" : "—";
        let estado = g.pickResult || "PENDING";
        if (g.liveStatus) estado = g.liveStatus === "COVERING" ? "Van ganando" : g.liveStatus === "NOT_COVERING" ? "Van perdiendo" : "En límite";
        if (estado === "WIN") estado = "GANÓ";
        if (estado === "LOSS") estado = "PERDIÓ";
        if (estado === "PUSH") estado = "PUSH";
        if (estado === "NO BET" || estado === "PENDING") estado = g.qualified ? "PLAY" : "—";
        return [matchup, g.time, proj, pick, book, edge, prob, kelly, estado];
      });

      doc.autoTable({
        head: [headers],
        body: rows,
        startY: 28,
        theme: "striped",
        styles: { fontSize: 8, cellPadding: 2, overflow: "linebreak" },
        headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        columnStyles: {
          0: { cellWidth: 30 },
          2: { cellWidth: 34 },
          3: { cellWidth: 30 },
          4: { cellWidth: 36 }
        },
        margin: { left: 10, right: 10 }
      });

      const filename = "Lords_Predictions_" + state.sport.id + "_" + state.dateKey + ".pdf";
      doc.save(filename);
    }

    // Exportar picks oficiales a CSV
    function exportOfficialPicksCSV() {
      if (!state.officialPicks.length) {
        alert("No hay picks oficiales para exportar.");
        return;
      }
      const header = [
        "fecha_iso",
        "deporte",
        "partido",
        "equipo",
        "spread",
        "precio",
        "resultado",
        "unidades",
        "perfil",
        "edge_modelo",
        "prob_modelo",
        "ev_unidades",
        "no_vig_entrada",
        "clv_puntos",
        "clv_cierre",
        "resultado_su"
      ];
      const rows = state.officialPicks.map(p => {
        const dt = new Date(p.createdAt);
        const fecha = dt.toISOString();
        const pickStr = `${p.pickTeam} ${formatSpread(p.pickSpread)}`;
        const clv = getOfficialPickClv(p);
        return [
          fecha,
          p.sportId,
          p.matchup,
          pickStr,
          p.pickSpread,
          p.price,
          p.result,
          p.units ?? 0,
          p.profileId,
          p.modelEdge ?? "",
          p.modelProb != null ? p.modelProb : "",
          p.evUnits ?? "",
          p.entryNoVig ?? p.modelNoVig ?? "",
          clv?.clvPts != null ? clv.clvPts : "",
          clv?.closingPrice ?? "",
          p.suResult ?? ""
        ];
      });
      const csv = [header, ...rows]
        .map(r => r.map(v => {
          const s = String(v ?? "");
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        }).join(","))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lords_picks_oficiales_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function summarizeOfficialPicks(picks) {
      const settled = picks.filter(p => ["WIN", "LOSS", "PUSH"].includes(p.result));
      const wins = settled.filter(p => p.result === "WIN").length;
      const losses = settled.filter(p => p.result === "LOSS").length;
      const pushes = settled.filter(p => p.result === "PUSH").length;
      const units = settled.reduce((sum, p) => sum + (p.units || 0), 0);
      const totalBets = wins + losses + pushes;
      const decisions = wins + losses;
      const roi = decisions > 0 ? units / decisions : 0;
      return { wins, losses, pushes, units, totalBets, decisions, roi };
    }

    function normalizeBacktestPick(pick, source) {
      const sportId = pick.sportId || "NBA";
      const edge = Number.isFinite(pick.modelEdge) ? pick.modelEdge
        : Number.isFinite(pick.edge) ? pick.edge : null;
      const zEdge = Number.isFinite(pick.zEdge) ? pick.zEdge
        : edge != null ? edge / getSportStdDev(sportId) : null;
      const spread = Number.isFinite(pick.pickSpread) ? pick.pickSpread : null;
      let isHome = pick.pickIsHome;
      if (isHome == null && pick.homeTeam) isHome = pick.pickTeam === pick.homeTeam;
      if (isHome == null && pick.matchup?.includes("@")) {
        isHome = pick.matchup.split("@")[1].trim().startsWith(pick.pickTeam);
      }
      const modelProb = Number.isFinite(pick.modelProb) ? pick.modelProb
        : Number.isFinite(pick.selectedProbability) ? pick.selectedProbability : null;
      const clv = source === "OFFICIAL" ? (getOfficialPickClv(pick) || pick.clv) : pick.clv;
      return {
        ...pick,
        source,
        sportId,
        edge,
        zEdge,
        pickSpread: spread,
        isHome: isHome === true ? true : isHome === false ? false : null,
        favorite: spread == null ? null : spread < -0.01 ? true : spread > 0.01 ? false : null,
        kelly: Number.isFinite(pick.kelly) ? pick.kelly : null,
        modelProb,
        profileId: pick.profileId || null,
        clvPts: clv?.clvPts ?? null,
        units: Number(pick.units) || 0,
        time: pick.settledAt || pick.createdAt || 0
      };
    }
    function getBacktestPicks(source) {
      const raw = source === "AUTO" ? state.trackedPicks : state.officialPicks;
      return raw
        .filter(p => ["WIN", "LOSS", "PUSH"].includes(p.result))
        .map(p => normalizeBacktestPick(p, source));
    }
    function backtestMetrics(picks) {
      const wins = picks.filter(p => p.result === "WIN").length;
      const losses = picks.filter(p => p.result === "LOSS").length;
      const pushes = picks.filter(p => p.result === "PUSH").length;
      const decisions = wins + losses;
      const units = picks.reduce((sum, p) => sum + p.units, 0);
      const clvPicks = picks.filter(p => Number.isFinite(p.clvPts));
      const clvPositive = clvPicks.filter(p => p.clvPts > 0.002).length;
      const probPicks = picks.filter(p => Number.isFinite(p.modelProb) && p.result !== "PUSH");
      return {
        count: picks.length,
        wins,
        losses,
        pushes,
        decisions,
        units,
        roi: decisions > 0 ? units / decisions : 0,
        hit: decisions > 0 ? wins / decisions : null,
        clvCount: clvPicks.length,
        clvPositive,
        clvRate: clvPicks.length ? clvPositive / clvPicks.length : null,
        avgClv: clvPicks.length ? clvPicks.reduce((sum, p) => sum + p.clvPts, 0) / clvPicks.length : null,
        probCount: probPicks.length,
        avgProb: probPicks.length ? probPicks.reduce((sum, p) => sum + p.modelProb, 0) / probPicks.length : null
      };
    }
    function groupBacktestMetrics(picks, keyFn, order = null) {
      const groups = new Map();
      for (const pick of picks) {
        const label = keyFn(pick);
        if (!label) continue;
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(pick);
      }
      const entries = [...groups.entries()].map(([label, group]) => ({
        label,
        metrics: backtestMetrics(group)
      }));
      if (order) {
        entries.sort((a, b) => {
          const ia = order.indexOf(a.label);
          const ib = order.indexOf(b.label);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
      }
      return entries;
    }
    function backtestZBand(pick) {
      if (pick.zEdge == null) return "Sin z";
      if (pick.zEdge < 0.15) return "< 0.15";
      if (pick.zEdge < 0.20) return "0.15–0.20";
      if (pick.zEdge < 0.25) return "0.20–0.25";
      if (pick.zEdge < 0.30) return "0.25–0.30";
      return "0.30+";
    }
    function backtestKellyBand(pick) {
      if (pick.kelly == null) return "Sin Kelly";
      if (pick.kelly < 1) return "< 1%";
      if (pick.kelly < 2) return "1–2%";
      if (pick.kelly < 3) return "2–3%";
      return "3%+";
    }
    function backtestRole(pick) {
      if (pick.favorite === true) return "Favorito";
      if (pick.favorite === false) return "Underdog";
      return "Pick'em";
    }
    function backtestHomeRole(pick) {
      if (pick.isHome == null || pick.favorite == null) return null;
      if (pick.isHome && pick.favorite) return "Local favorito";
      if (pick.isHome && !pick.favorite) return "Local underdog";
      if (!pick.isHome && pick.favorite) return "Visitante favorito";
      return "Visitante underdog";
    }
    function backtestSpreadBand(pick) {
      if (pick.pickSpread == null) return "Sin spread";
      const abs = Math.abs(pick.pickSpread);
      if (abs <= 3.5) return "0–3.5";
      if (abs <= 7) return "4–7";
      if (abs <= 10) return "7.5–10";
      return "10.5+";
    }
    function backtestEdgeBand(pick) {
      if (pick.edge == null) return "Sin edge";
      const e = Math.abs(pick.edge);
      if (e < 1) return "< 1";
      if (e < 2) return "1–2";
      if (e < 3) return "2–3";
      if (e < 4) return "3–4";
      return "4+";
    }
    function renderBacktestTable(title, entries) {
      if (!entries.length) return "";
      return `
        <div class="rounded-xl border border-slate-800 bg-[#0b0f1c] p-3">
          <div class="text-[10px] uppercase tracking-wider text-slate-500 font-mono">${escapeHTML(title)}</div>
          <div class="overflow-x-auto mt-2">
            <table class="min-w-full text-[10px] font-mono">
              <thead>
                <tr class="text-slate-500">
                  <th class="text-left py-1 pr-2 font-normal">Grupo</th>
                  <th class="text-right py-1 px-1 font-normal">N</th>
                  <th class="text-right py-1 px-1 font-normal">Récord</th>
                  <th class="text-right py-1 px-1 font-normal">U</th>
                  <th class="text-right py-1 px-1 font-normal">ROI</th>
                  <th class="text-right py-1 px-1 font-normal">Acierto</th>
                  <th class="text-right py-1 pl-1 font-normal">CLV+</th>
                </tr>
              </thead>
              <tbody>
                ${entries.map(({ label, metrics: m }) => `
                  <tr class="border-t border-slate-900/70">
                    <td class="py-1 pr-2 text-slate-300">${escapeHTML(label)}</td>
                    <td class="py-1 px-1 text-right text-slate-400">${m.count}</td>
                    <td class="py-1 px-1 text-right text-slate-300">
                      ${m.wins}-${m.losses}${m.pushes ? "-" + m.pushes : ""}
                    </td>
                    <td class="py-1 px-1 text-right ${m.units > 0 ? "text-emerald-300" : m.units < 0 ? "text-red-300" : "text-slate-300"}">
                      ${formatNumber(m.units, 2)}
                    </td>
                    <td class="py-1 px-1 text-right ${m.roi > 0 ? "text-emerald-300" : m.roi < 0 ? "text-red-300" : "text-slate-300"}">
                      ${formatPercentage(m.roi, 1)}
                    </td>
                    <td class="py-1 px-1 text-right text-slate-300">${m.hit != null ? formatPercentage(m.hit, 0) : "—"}</td>
                    <td class="py-1 pl-1 text-right text-slate-400" title="${m.clvCount} picks con cierre">
                      ${m.clvRate != null ? formatPercentage(m.clvRate, 0) : "—"}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
    function calibrationRows(picks) {
      const defs = [
        [0.35, 0.40, "35–40%"],
        [0.40, 0.425, "40–42.5%"],
        [0.425, 0.45, "42.5–45%"],
        [0.45, 0.475, "45–47.5%"],
        [0.475, 0.50, "47.5–50%"],
        [0.50, 0.525, "50–52.5%"],
        [0.525, 0.55, "52.5–55%"],
        [0.55, 0.575, "55–57.5%"],
        [0.575, 0.60, "57.5–60%"],
        [0.60, 0.625, "60–62.5%"],
        [0.625, 0.65, "62.5–65%"],
        [0.65, 0.70, "65–70%"],
        [0.70, 1.01, "70%+"]
      ].map(([min, max, label]) => ({ min, max, label, picks: [] }));
      for (const pick of picks) {
        if (!Number.isFinite(pick.modelProb) || pick.result === "PUSH") continue;
        const bucket = defs.find(d => pick.modelProb >= d.min && pick.modelProb < d.max);
        if (bucket) bucket.picks.push(pick);
      }
      return defs
        .filter(d => d.picks.length)
        .map(d => {
          const n = d.picks.length;
          const wins = d.picks.filter(p => p.result === "WIN").length;
          const predicted = d.picks.reduce((sum, p) => sum + p.modelProb, 0) / n;
          const actual = wins / n;
          return { label: d.label, n, wins, predicted, actual, delta: actual - predicted };
        });
    }
    function renderCalibrationTable(rows, calibrationError, totalDecisions) {
      if (!rows.length) {
        return `
          <div class="mt-4 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[10px] text-slate-500 font-mono">
            Calibración: aún no hay picks liquidados con probabilidad del modelo.
          </div>
        `;
      }
      return `
        <div class="mt-4 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="text-[10px] uppercase tracking-wider text-slate-500 font-mono">Calibración de probabilidades</div>
            <div class="text-[10px] text-slate-400 font-mono">
              Error ponderado: ${formatPercentage(calibrationError, 1)} · N=${totalDecisions}
            </div>
          </div>
          <div class="overflow-x-auto mt-2">
            <table class="min-w-full text-[10px] font-mono">
              <thead>
                <tr class="text-slate-500">
                  <th class="text-left py-1 pr-2 font-normal">Prob. modelo</th>
                  <th class="text-right py-1 px-1 font-normal">N</th>
                  <th class="text-right py-1 px-1 font-normal">Predicha</th>
                  <th class="text-right py-1 px-1 font-normal">Real</th>
                  <th class="text-right py-1 pl-1 font-normal">Desvío</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => `
                  <tr class="border-t border-slate-900/70">
                    <td class="py-1 pr-2 text-slate-300">${escapeHTML(r.label)}</td>
                    <td class="py-1 px-1 text-right text-slate-400">${r.n}</td>
                    <td class="py-1 px-1 text-right text-slate-300">${formatPercentage(r.predicted, 1)}</td>
                    <td class="py-1 px-1 text-right">
                      <div class="text-slate-200">${formatPercentage(r.actual, 1)}</div>
                      <div class="h-1 mt-0.5 rounded bg-slate-800 overflow-hidden">
                        <div class="h-full bg-emerald-500" style="width:${clamp(r.actual * 100, 0, 100)}%"></div>
                      </div>
                    </td>
                    <td class="py-1 pl-1 text-right ${Math.abs(r.delta) <= 0.03 ? "text-slate-400" : r.delta > 0 ? "text-emerald-300" : "text-red-300"}">
                      ${formatSignedPctPoints(r.delta)}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
    function renderBacktestPanel() {
      const official = getBacktestPicks("OFFICIAL");
      const auto = getBacktestPicks("AUTO");
      let source = state.backtestSource;
      if (source === "OFFICIAL" && !official.length && auto.length) source = "AUTO";
      if (source === "AUTO" && !auto.length && official.length) source = "OFFICIAL";
      const picks = source === "AUTO" ? auto : official;
      const metrics = backtestMetrics(picks);
      const zOrder = ["< 0.15", "0.15–0.20", "0.20–0.25", "0.25–0.30", "0.30+", "Sin z"];
      const kellyOrder = ["< 1%", "1–2%", "2–3%", "3%+", "Sin Kelly"];
      const edgeOrder = ["< 1", "1–2", "2–3", "3–4", "4+", "Sin edge"];
      const spreadOrder = ["0–3.5", "4–7", "7.5–10", "10.5+", "Sin spread"];
      const groups = [
        { title: "Por deporte", entries: groupBacktestMetrics(picks, p => p.sportId, ["NBA", "MLB", "NFL"]) },
        { title: "Local vs visitante", entries: groupBacktestMetrics(picks, p => p.isHome === true ? "Local" : p.isHome === false ? "Visitante" : "Sin lado", ["Local", "Visitante", "Sin lado"]) },
        { title: "Favorito vs underdog", entries: groupBacktestMetrics(picks, backtestRole, ["Favorito", "Underdog", "Pick'em"]) },
        { title: "Localía + rol", entries: groupBacktestMetrics(picks, backtestHomeRole, ["Local favorito", "Local underdog", "Visitante favorito", "Visitante underdog"]) },
        { title: "Rango de spread", entries: groupBacktestMetrics(picks, backtestSpreadBand, spreadOrder) },
        { title: "Rango de edge", entries: groupBacktestMetrics(picks, backtestEdgeBand, edgeOrder) },
        { title: "Rango de z-edge", entries: groupBacktestMetrics(picks, backtestZBand, zOrder) },
        { title: "Rango de Kelly", entries: groupBacktestMetrics(picks, backtestKellyBand, kellyOrder) },
        { title: "Por perfil", entries: groupBacktestMetrics(picks, p => p.profileId ? (RISK_PROFILES[p.profileId]?.label || p.profileId) : "Sin perfil", Object.values(RISK_PROFILES).map(p => p.label)) }
      ].filter(g => g.entries.length);
      const calibration = calibrationRows(picks);
      const calibrationDecisions = calibration.reduce((sum, r) => sum + r.n, 0);
      const calibrationError = calibrationDecisions > 0
        ? calibration.reduce((sum, r) => sum + r.n * Math.abs(r.delta), 0) / calibrationDecisions
        : 0;
      const lowSample = metrics.decisions > 0 && metrics.decisions < 20;
      const sourceButton = (id, label, count) => `
        <button onclick="setBacktestSource('${id}')"
                class="px-2 py-1 ${source === id ? "bg-orange-500 text-white" : "bg-slate-900 text-slate-300 hover:bg-slate-800"}">
          ${escapeHTML(label)} (${count})
        </button>
      `;
      return `
        <section class="mt-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="font-bold text-sm">Backtesting y calibración</h2>
              <div class="text-[10px] text-slate-500 font-mono mt-1">
                Oficiales: picks que marcaste · Auto-modelo: picks calificados registrados automáticamente.
              </div>
            </div>
            <div class="inline-flex rounded-xl overflow-hidden border border-slate-700 text-[10px] font-mono">
              ${sourceButton("OFFICIAL", "Oficiales", official.length)}
              ${sourceButton("AUTO", "Auto-modelo", auto.length)}
            </div>
          </div>
          ${picks.length === 0 ? `
            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[11px] text-slate-500 font-mono">
              Aún no hay picks liquidados en esta fuente. Marca picks oficiales o deja activo el auto-registro para acumular historial.
            </div>
          ` : `
            <div class="grid grid-cols-2 md:grid-cols-6 gap-2 mt-3 text-[10px] font-mono">
              <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
                <div class="text-slate-500 uppercase text-[9px]">Picks</div>
                <div class="text-base font-black mt-0.5">${metrics.count}</div>
              </div>
              <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
                <div class="text-slate-500 uppercase text-[9px]">Récord</div>
                <div class="text-base font-black mt-0.5">
                  ${metrics.wins}-${metrics.losses}${metrics.pushes ? "-" + metrics.pushes : ""}
                </div>
              </div>
              <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
                <div class="text-slate-500 uppercase text-[9px]">Unidades</div>
                <div class="text-base font-black mt-0.5 ${metrics.units > 0 ? "text-emerald-300" : metrics.units < 0 ? "text-red-300" : ""}">
                  ${formatNumber(metrics.units, 2)}
                </div>
              </div>
              <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
                <div class="text-slate-500 uppercase text-[9px]">ROI</div>
                <div class="text-base font-black mt-0.5 ${metrics.roi > 0 ? "text-emerald-300" : metrics.roi < 0 ? "text-red-300" : ""}">
                  ${formatPercentage(metrics.roi, 1)}
                </div>
              </div>
              <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
                <div class="text-slate-500 uppercase text-[9px]">Acierto</div>
                <div class="text-base font-black mt-0.5">${metrics.hit != null ? formatPercentage(metrics.hit, 0) : "—"}</div>
              </div>
              <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
                <div class="text-slate-500 uppercase text-[9px]">CLV a favor</div>
                <div class="text-base font-black mt-0.5 ${metrics.clvRate != null && metrics.clvRate >= 0.5 ? "text-emerald-300" : "text-slate-200"}">
                  ${metrics.clvRate != null ? formatPercentage(metrics.clvRate, 0) : "—"}
                </div>
                <div class="text-[8px] text-slate-600">
                  ${metrics.avgClv != null ? `med ${formatSignedPctPoints(metrics.avgClv)}` : "sin cierres"}
                </div>
              </div>
            </div>
            ${lowSample ? `
              <div class="mt-2 text-[10px] text-amber-300/80 font-mono">
                Muestra pequeña (${metrics.decisions} decisiones). Interpreta los segmentos con cautela.
              </div>
            ` : ""}
            <div class="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
              ${groups.map(g => renderBacktestTable(g.title, g.entries)).join("")}
            </div>
            ${renderCalibrationTable(calibration, calibrationError, calibrationDecisions)}
            <div class="mt-2 text-[10px] text-slate-500 font-mono">
              Si un tramo de z-edge o de Kelly muestra ROI negativo de forma consistente, sube el z-edge mínimo para excluirlo.
            </div>
          `}
        </section>
      `;
    }
    function setBacktestSource(source) {
      state.backtestSource = source === "AUTO" ? "AUTO" : "OFFICIAL";
      render();
    }

    const OFFICIAL_CAL_BUCKETS = Object.freeze([
      { min: 0, max: 0.45, label: "<45%" },
      { min: 0.45, max: 0.50, label: "45–50%" },
      { min: 0.50, max: 0.55, label: "50–55%" },
      { min: 0.55, max: 0.60, label: "55–60%" },
      { min: 0.60, max: 0.65, label: "60–65%" },
      { min: 0.65, max: 0.70, label: "65–70%" },
      { min: 0.70, max: 1.0000001, label: "70%+" }
    ]);

    const OFFICIAL_SEGMENTS = Object.freeze({
      SPORT: {
        label: "Deporte",
        order: ["NBA", "MLB", "NFL"],
        value: pick => pick.sportId || "Sin deporte"
      },
      PROFILE: {
        label: "Perfil",
        order: Object.values(RISK_PROFILES).map(p => p.label),
        value: pick => pick.profileId
          ? (RISK_PROFILES[pick.profileId]?.label || pick.profileId)
          : "Sin perfil"
      },
      PROB: {
        label: "Prob. modelo",
        order: ["< 45%", "45–50%", "50–55%", "55–60%", "60–65%", "65–70%", "70%+", "Sin prob."],
        value: pick => {
          const prob = pick.modelProb;
          if (!Number.isFinite(prob)) return "Sin prob.";
          if (prob < 0.45) return "< 45%";
          if (prob < 0.50) return "45–50%";
          if (prob < 0.55) return "50–55%";
          if (prob < 0.60) return "55–60%";
          if (prob < 0.65) return "60–65%";
          if (prob < 0.70) return "65–70%";
          return "70%+";
        }
      },
      EDGE: {
        label: "Rango de edge",
        order: ["< 1", "1–2", "2–3", "3–4", "4+", "Sin edge"],
        value: pick => {
          const edge = Number.isFinite(pick.modelEdge) ? pick.modelEdge : pick.edge;
          if (!Number.isFinite(edge)) return "Sin edge";
          const abs = Math.abs(edge);
          if (abs < 1) return "< 1";
          if (abs < 2) return "1–2";
          if (abs < 3) return "2–3";
          if (abs < 4) return "3–4";
          return "4+";
        }
      },
      PRICE: {
        label: "Signo de cuota",
        order: ["Cuota −", "Cuota +", "Cuota 0", "Sin cuota"],
        value: pick => {
          if (!Number.isFinite(pick.price)) return "Sin cuota";
          if (pick.price < 0) return "Cuota −";
          if (pick.price > 0) return "Cuota +";
          return "Cuota 0";
        }
      },
      ROLE: {
        label: "Favorito / underdog",
        order: ["Favorito", "Underdog", "Pick'em", "Sin spread"],
        value: pick => {
          if (!Number.isFinite(pick.pickSpread)) return "Sin spread";
          if (pick.pickSpread < -0.01) return "Favorito";
          if (pick.pickSpread > 0.01) return "Underdog";
          return "Pick'em";
        }
      },
      SIDE: {
        label: "Local / visitante",
        order: ["Local", "Visitante", "Sin lado"],
        value: pick => {
          const isHome = pick.isHome === true || pick.isHome === false ? pick.isHome : pick.pickIsHome;
          return isHome === true ? "Local" : isHome === false ? "Visitante" : "Sin lado";
        }
      },
      SPREAD: {
        label: "Rango de spread",
        order: ["0–3.5", "4–7", "7.5–10", "10.5+", "Sin spread"],
        value: pick => {
          if (!Number.isFinite(pick.pickSpread)) return "Sin spread";
          const abs = Math.abs(pick.pickSpread);
          if (abs <= 3.5) return "0–3.5";
          if (abs <= 7) return "4–7";
          if (abs <= 10) return "7.5–10";
          return "10.5+";
        }
      },
      MONTH: {
        label: "Mes",
        value: pick => {
          const key = String(pick.dateKey || "").slice(0, 6);
          return /^\d{6}$/.test(key) ? `${key.slice(0, 4)}-${key.slice(4, 6)}` : "Sin fecha";
        }
      }
    });

    function officialSegmentValue(pick, segmentId) {
      const def = OFFICIAL_SEGMENTS[segmentId] || OFFICIAL_SEGMENTS.PROB;
      return def.value(pick || {});
    }

    function getOfficialSegmentEntries(picks, segmentId) {
      const def = OFFICIAL_SEGMENTS[segmentId] || OFFICIAL_SEGMENTS.PROB;
      let order = def.order || null;
      if (segmentId === "MONTH") {
        order = [...new Set(
          picks
            .map(p => String(p.dateKey || "").slice(0, 6))
            .filter(key => /^\d{6}$/.test(key))
        )].sort();
      }
      const entries = groupBacktestMetrics(picks, pick => def.value(pick), order);
      if (!order) {
        entries.sort((a, b) =>
          (b.metrics.decisions - a.metrics.decisions) ||
          (b.metrics.units - a.metrics.units) ||
          a.label.localeCompare(b.label, "es")
        );
      }
      return entries;
    }

    // Calibración de probabilidades exclusiva de picks oficiales liquidados.
    // Excluye PUSH; Brier y log loss se calculan solo con WIN/LOSS y modelProb.
    function computeOfficialCalibration(picks) {
      const decided = (picks || []).filter(p =>
        (p.result === "WIN" || p.result === "LOSS") &&
        Number.isFinite(p.modelProb) && p.modelProb > 0 && p.modelProb < 1
      );
      const n = decided.length;
      if (!n) {
        return {
          n: 0, wins: 0, losses: 0, predicted: null, actual: null,
          bias: null, brier: null, logLoss: null, ece: null, rows: []
        };
      }

      let wins = 0;
      let sumPredicted = 0;
      let brierSum = 0;
      let logLossSum = 0;
      const buckets = OFFICIAL_CAL_BUCKETS.map(def => ({ ...def, picks: [] }));

      for (const pick of decided) {
        const prob = pick.modelProb;
        const win = pick.result === "WIN" ? 1 : 0;
        wins += win;
        sumPredicted += prob;
        brierSum += (prob - win) ** 2;
        const clipped = clamp(prob, 1e-6, 1 - 1e-6);
        logLossSum += -(win * Math.log(clipped) + (1 - win) * Math.log(1 - clipped));
        const bucket = buckets.find(b => prob >= b.min && prob < b.max);
        if (bucket) bucket.picks.push({ prob, win });
      }

      const predicted = sumPredicted / n;
      const actual = wins / n;
      const rows = buckets
        .filter(b => b.picks.length)
        .map(b => {
          const count = b.picks.length;
          const bucketPredicted = b.picks.reduce((sum, x) => sum + x.prob, 0) / count;
          const bucketWins = b.picks.reduce((sum, x) => sum + x.win, 0);
          const bucketActual = bucketWins / count;
          return {
            label: b.label,
            n: count,
            wins: bucketWins,
            predicted: bucketPredicted,
            actual: bucketActual,
            delta: bucketActual - bucketPredicted
          };
        });
      const ece = rows.reduce((sum, row) => sum + row.n * Math.abs(row.delta), 0) / n;

      return {
        n,
        wins,
        losses: n - wins,
        predicted,
        actual,
        bias: actual - predicted,
        brier: brierSum / n,
        logLoss: logLossSum / n,
        ece,
        rows
      };
    }

    function setOfficialAnalyticsSport(value) {
      state.officialAnalytics = {
        ...state.officialAnalytics,
        sport: value === "NBA" || value === "MLB" ? value : "ALL"
      };
      render();
    }

    function setOfficialAnalyticsSegment(value) {
      state.officialAnalytics = {
        ...state.officialAnalytics,
        segment: OFFICIAL_SEGMENTS[value] ? value : "PROB"
      };
      render();
    }

    function renderOfficialAnalyticsPanel() {
      const config = state.officialAnalytics || { sport: "ALL", segment: "PROB" };
      const sportFilter = config.sport === "NBA" || config.sport === "MLB" ? config.sport : "ALL";
      const segmentId = OFFICIAL_SEGMENTS[config.segment] ? config.segment : "PROB";
      const segmentDef = OFFICIAL_SEGMENTS[segmentId];

      const allOfficial = Array.isArray(state.officialPicks) ? state.officialPicks : [];
      const sportPicks = allOfficial.filter(p => sportFilter === "ALL" || p.sportId === sportFilter);
      const pending = sportPicks.filter(p => p.result === "PENDING").length;
      const settledRaw = sportPicks.filter(p => ["WIN", "LOSS", "PUSH"].includes(p.result));
      const picks = settledRaw.map(p => normalizeBacktestPick(p, "OFFICIAL"));
      const metrics = backtestMetrics(picks);
      const calibration = computeOfficialCalibration(picks);
      const entries = picks.length ? getOfficialSegmentEntries(picks, segmentId) : [];

      const sportCount = id => allOfficial.filter(p => p.sportId === id).length;
      const pendingLabel = pending === 1 ? "1 pendiente" : `${pending} pendientes`;
      const metricTone = value => value > 0 ? "text-emerald-300" : value < 0 ? "text-red-300" : "text-slate-200";
      const biasTone = calibration.bias == null
        ? "text-slate-200"
        : Math.abs(calibration.bias) <= 0.03
          ? "text-slate-200"
          : calibration.bias > 0 ? "text-emerald-300" : "text-red-300";
      const eceTone = calibration.ece == null
        ? "text-slate-200"
        : calibration.ece <= 0.03 ? "text-emerald-300" : calibration.ece <= 0.06 ? "text-amber-300" : "text-red-300";
      const statCard = (label, value, tone = "text-slate-100", sub = "") => `
        <div class="rounded-lg bg-[#0b0f1c] border border-slate-800 p-2">
          <div class="text-slate-500 uppercase text-[9px]">${escapeHTML(label)}</div>
          <div class="text-base font-black mt-0.5 ${tone}">${value}</div>
          ${sub ? `<div class="text-[8px] text-slate-600 mt-0.5">${escapeHTML(sub)}</div>` : ""}
        </div>
      `;

      return `
        <section class="mt-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="font-bold text-sm">Calibración y backtesting · picks oficiales</h2>
              <div class="text-[10px] text-slate-500 font-mono mt-1">
                Exclusivo de state.officialPicks · sin auto-modelo · ${allOfficial.length} guardados
                ${pending ? ` · ${pendingLabel}` : ""}
              </div>
            </div>
            <div class="flex flex-wrap items-end gap-2 text-[10px] font-mono">
              <label class="flex flex-col gap-1">
                <span class="text-[9px] uppercase tracking-wider text-slate-500">Deporte</span>
                <select onchange="setOfficialAnalyticsSport(this.value)"
                        class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-1">
                  <option value="ALL" ${sportFilter === "ALL" ? "selected" : ""}>Todos (${allOfficial.length})</option>
                  <option value="NBA" ${sportFilter === "NBA" ? "selected" : ""}>NBA (${sportCount("NBA")})</option>
                  <option value="MLB" ${sportFilter === "MLB" ? "selected" : ""}>MLB (${sportCount("MLB")})</option>
                </select>
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[9px] uppercase tracking-wider text-slate-500">Segmentar por</span>
                <select onchange="setOfficialAnalyticsSegment(this.value)"
                        class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-1">
                  ${Object.entries(OFFICIAL_SEGMENTS).map(([id, def]) => `
                    <option value="${id}" ${id === segmentId ? "selected" : ""}>${escapeHTML(def.label)}</option>
                  `).join("")}
                </select>
              </label>
            </div>
          </div>
          ${allOfficial.length === 0 ? `
            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[11px] text-slate-500 font-mono">
              Aún no hay picks oficiales guardados. Marca picks con “Marcar como pick oficial”;
              esta sección no usa picks automáticos.
            </div>
          ` : picks.length === 0 ? `
            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[11px] text-slate-500 font-mono">
              ${sportFilter === "ALL" ? "No hay" : `No hay en ${sportFilter}:`} picks oficiales liquidados todavía.
              ${pending ? `Hay ${pending} pendiente${pending === 1 ? "" : "s"}; los resultados aparecerán al liquidarse.` : ""}
            </div>
          ` : `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-[10px] font-mono">
              ${statCard("Liquidados", metrics.count, "text-slate-100", pendingLabel)}
              ${statCard("Decisiones", metrics.decisions, "text-slate-100", "WIN + LOSS")}
              ${statCard("Récord", `${metrics.wins}-${metrics.losses}${metrics.pushes ? "-" + metrics.pushes : ""}`)}
              ${statCard("Unidades", formatNumber(metrics.units, 2), metricTone(metrics.units))}
              ${statCard("ROI", formatPercentage(metrics.roi, 1), metricTone(metrics.roi))}
              ${statCard("Acierto", metrics.hit != null ? formatPercentage(metrics.hit, 1) : "—")}
              ${statCard("Prob. media", calibration.predicted != null ? formatPercentage(calibration.predicted, 1) : "—")}
              ${statCard("Sesgo", calibration.bias != null ? formatSignedPctPoints(calibration.bias) : "—", biasTone, "real − predicha")}
            </div>
            ${metrics.decisions > 0 && metrics.decisions < 20 ? `
              <div class="mt-2 text-[10px] text-amber-300/80 font-mono">
                Muestra pequeña (${metrics.decisions} decisiones). Interpreta ROI, calibración y segmentos con cautela.
              </div>
            ` : ""}

            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div class="text-[10px] uppercase tracking-wider text-slate-500 font-mono">Calibración de probabilidades del modelo</div>
                  <div class="text-[9px] text-slate-500 font-mono mt-0.5">
                    Solo WIN/LOSS con modelProb · N=${calibration.n} · menor Brier/log loss/ECE es mejor
                  </div>
                </div>
                <div class="flex flex-wrap gap-2 text-[10px] font-mono">
                  <span class="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-200">Brier ${formatNumber(calibration.brier, 3)}</span>
                  <span class="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-200">Log loss ${formatNumber(calibration.logLoss, 3)}</span>
                  <span class="px-2 py-1 rounded bg-slate-900 border border-slate-700 ${eceTone}">ECE ${formatPercentage(calibration.ece, 1)}</span>
                </div>
              </div>
              ${calibration.rows.length === 0 ? `
                <div class="mt-2 text-[10px] text-slate-500 font-mono">No hay picks liquidados con modelProb para calibrar.</div>
              ` : `
                <div class="overflow-x-auto mt-2">
                  <table class="min-w-full text-[10px] font-mono">
                    <thead>
                      <tr class="text-slate-500">
                        <th class="text-left py-1 pr-2 font-normal">Tramo</th>
                        <th class="text-right py-1 px-1 font-normal">N</th>
                        <th class="text-right py-1 px-1 font-normal">Predicha</th>
                        <th class="text-right py-1 px-1 font-normal">Real</th>
                        <th class="text-right py-1 pl-1 font-normal">Desvío</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${calibration.rows.map(row => {
                        const deltaTone = Math.abs(row.delta) <= 0.03
                          ? "text-emerald-300"
                          : Math.abs(row.delta) <= 0.06 ? "text-amber-300" : "text-red-300";
                        return `
                          <tr class="border-t border-slate-900/70">
                            <td class="py-1 pr-2 text-slate-300">${escapeHTML(row.label)}</td>
                            <td class="py-1 px-1 text-right text-slate-400">${row.n}</td>
                            <td class="py-1 px-1 text-right text-slate-300">
                              <div class="flex items-center justify-end gap-1">
                                <div class="h-1.5 w-14 rounded bg-slate-800 overflow-hidden">
                                  <div class="h-full bg-slate-500" style="width:${clamp(row.predicted * 100, 0, 100)}%"></div>
                                </div>
                                <span class="w-10 text-right">${formatPercentage(row.predicted, 1)}</span>
                              </div>
                            </td>
                            <td class="py-1 px-1 text-right text-slate-200">
                              <div class="flex items-center justify-end gap-1">
                                <div class="h-1.5 w-14 rounded bg-slate-800 overflow-hidden">
                                  <div class="h-full bg-emerald-500" style="width:${clamp(row.actual * 100, 0, 100)}%"></div>
                                </div>
                                <span class="w-10 text-right">${formatPercentage(row.actual, 1)}</span>
                              </div>
                            </td>
                            <td class="py-1 pl-1 text-right ${deltaTone}">${formatSignedPctPoints(row.delta)}</td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                </div>
                <div class="mt-2 text-[9px] text-slate-500 font-mono">
                  Desvío = real − predicha. Verde/ámbar ≤3/≤6 pts; rojo &gt;6 pts. ECE es el error medio ponderado por tamaño de tramo.
                </div>
              `}
            </div>

            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-[10px] uppercase tracking-wider text-slate-500 font-mono">
                  Backtesting segmentado · ${escapeHTML(segmentDef.label)}
                </div>
                <div class="text-[9px] text-slate-500 font-mono">N incluye pushes; decisiones = WIN + LOSS</div>
              </div>
              ${entries.length === 0 ? `
                <div class="mt-2 text-[10px] text-slate-500 font-mono">Sin segmentos para este filtro.</div>
              ` : `
                <div class="overflow-x-auto mt-2">
                  <table class="min-w-full text-[10px] font-mono">
                    <thead>
                      <tr class="text-slate-500">
                        <th class="text-left py-1 pr-2 font-normal">Grupo</th>
                        <th class="text-right py-1 px-1 font-normal">N</th>
                        <th class="text-right py-1 px-1 font-normal">Récord</th>
                        <th class="text-right py-1 px-1 font-normal">Dec.</th>
                        <th class="text-right py-1 px-1 font-normal">U</th>
                        <th class="text-right py-1 px-1 font-normal">ROI</th>
                        <th class="text-right py-1 px-1 font-normal">Acierto</th>
                        <th class="text-right py-1 px-1 font-normal">Prob. media</th>
                        <th class="text-right py-1 pl-1 font-normal">Sesgo</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${entries.map(({ label, metrics: m }) => {
                        const lowSample = m.decisions < 5;
                        const delta = m.hit != null && m.avgProb != null ? m.hit - m.avgProb : null;
                        const deltaTone = delta == null
                          ? "text-slate-500"
                          : Math.abs(delta) <= 0.03 ? "text-slate-400" : delta > 0 ? "text-emerald-300" : "text-red-300";
                        return `
                          <tr class="border-t border-slate-900/70">
                            <td class="py-1 pr-2 text-slate-300">
                              ${escapeHTML(label)}${lowSample ? ` <span class="text-amber-300" title="Menos de 5 decisiones">*</span>` : ""}
                            </td>
                            <td class="py-1 px-1 text-right ${lowSample ? "text-amber-300" : "text-slate-400"}">${m.count}</td>
                            <td class="py-1 px-1 text-right text-slate-300">${m.wins}-${m.losses}${m.pushes ? "-" + m.pushes : ""}</td>
                            <td class="py-1 px-1 text-right text-slate-400">${m.decisions}</td>
                            <td class="py-1 px-1 text-right ${m.units > 0 ? "text-emerald-300" : m.units < 0 ? "text-red-300" : "text-slate-300"}">${formatNumber(m.units, 2)}</td>
                            <td class="py-1 px-1 text-right ${m.roi > 0 ? "text-emerald-300" : m.roi < 0 ? "text-red-300" : "text-slate-300"}">${formatPercentage(m.roi, 1)}</td>
                            <td class="py-1 px-1 text-right text-slate-300">${m.hit != null ? formatPercentage(m.hit, 1) : "—"}</td>
                            <td class="py-1 px-1 text-right text-slate-300">${m.avgProb != null ? formatPercentage(m.avgProb, 1) : "—"}</td>
                            <td class="py-1 pl-1 text-right ${deltaTone}">${delta != null ? formatSignedPctPoints(delta) : "—"}</td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                </div>
                <div class="mt-2 text-[9px] text-slate-500 font-mono">
                  * Menos de 5 decisiones: interpretar con cautela. Sesgo del segmento = acierto real − probabilidad media.
                </div>
              `}
            </div>
          `}
        </section>
      `;
    }

    function renderJournalPanel() {
      const dateKey = state.dateKey;
      const allBets = Array.isArray(state.betJournal) ? state.betJournal : [];
      const betsToday = allBets.filter(b => b.dateKey === dateKey);
      const pendingCount = betsToday.filter(b => b.result === "PENDING").length;
      const summary = getJournalDailySummary(betsToday);
      const shortDate = key => (key && key.length === 8 ? `${key.slice(6, 8)}/${key.slice(4, 6)}` : "—");
      const signedUnits = value => {
        const n = Number(value) || 0;
        return `${n > 0 ? "+" : ""}${formatNumber(n, 2)}`;
      };
      const resultOptions = bet => BET_JOURNAL_RESULTS
        .map(r => `<option value="${r}" ${bet.result === r ? "selected" : ""}>${r}</option>`)
        .join("");
      const rows = betsToday
        .slice()
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map(bet => `
          <tr class="border-t border-slate-900/70">
            <td class="py-1.5 px-2 text-slate-300 whitespace-nowrap">${shortDate(bet.dateKey)}</td>
            <td class="py-1.5 px-2 text-slate-400">${escapeHTML(bet.sportId || "—")}</td>
            <td class="py-1.5 px-2 text-slate-400">${escapeHTML(bet.type || "OTRO")}</td>
            <td class="py-1.5 px-2 text-slate-200">${escapeHTML(bet.description)}</td>
            <td class="py-1.5 px-2 text-right text-slate-300">${formatNumber(bet.stake, 2)}</td>
            <td class="py-1.5 px-2 text-right text-slate-300">${formatAmericanPrice(bet.price)}</td>
            <td class="py-1.5 px-2 text-right ${
              bet.result === "WIN" ? "text-emerald-300" :
              bet.result === "LOSS" ? "text-red-300" :
              "text-slate-300"
            }">${bet.result}</td>
            <td class="py-1.5 px-2 text-right ${
              bet.units > 0 ? "text-emerald-300" :
              bet.units < 0 ? "text-red-300" : "text-slate-300"
            }">${signedUnits(bet.units)}</td>
            <td class="py-1.5 px-2 text-right whitespace-nowrap">
              <select onchange="setJournalResult('${bet.id}', this.value)"
                      class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-[9px] font-mono">
                ${resultOptions(bet)}
              </select>
              <button onclick="removeJournalBet('${bet.id}')" class="ml-1 text-[9px] text-slate-500 hover:text-red-400 font-mono">eliminar</button>
            </td>
          </tr>
        `).join("");
      return `
        <section class="mb-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="font-bold text-sm">Cuaderno de apuestas — ${escapeHTML(formatDateLabel(dateKey))}</h2>
              <div class="text-[10px] text-slate-500 font-mono mt-1">
                Registro manual de lo que juegas · separado de los picks oficiales del modelo.
                Los ATS con partido enlazado se liquidan solos al actualizarse el marcador final.
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <div class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400">
                ${betsToday.length} apuestas · ${pendingCount} pendientes
              </div>
              <button onclick="openAddBetManual('OTRO', null, '', -110)"
                      class="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[10px] font-mono font-bold">
                + Apuesta manual
              </button>
            </div>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono mb-3 mt-3">
            <div><span class="text-slate-500">Bets:</span> <span class="text-slate-200 font-bold">${betsToday.length}</span></div>
            <div><span class="text-slate-500">W-L-P:</span> <span class="text-slate-200 font-bold">${summary.wins}-${summary.losses}${summary.pushes ? "-" + summary.pushes : ""}</span></div>
            <div><span class="text-slate-500">Unidades:</span> <span class="${summary.units > 0 ? "text-emerald-300" : summary.units < 0 ? "text-red-300" : "text-slate-200"} font-bold">${signedUnits(summary.units)}</span></div>
            <div><span class="text-slate-500">ROI/bet:</span> <span class="${summary.roi > 0 ? "text-emerald-300" : summary.roi < 0 ? "text-red-300" : "text-slate-200"} font-bold">${formatPercentage(summary.roi, 1)}</span></div>
          </div>
          ${betsToday.length === 0 ? `
            <div class="rounded-xl border border-dashed border-slate-800 p-4 text-center text-[11px] text-slate-500 font-mono">
              Aún no hay apuestas registradas para esta fecha. Usa “+ Añadir al cuaderno” en una tarjeta de partido o “+ Apuesta manual”.
            </div>
          ` : `
            <div class="overflow-x-auto">
              <table class="min-w-full text-[10px] font-mono border-t border-slate-800">
                <thead class="bg-slate-900/60">
                  <tr>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Fecha</th>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Deporte</th>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Tipo</th>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Apuesta</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Stake</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Cuota</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Resultado</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Unidades</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Acciones</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <div class="mt-2 text-[9px] text-slate-500 font-mono">
              Confirmado = cuenta para W-L-P; pendiente = aún no liquidada. Los ATS enlazados a un partido finalizado se actualizan automáticamente.
            </div>
          `}
        </section>
      `;
    }

    function renderParlaysPanel() {
      const config = state.parlayConfig;
      const baseSet = config.baseSet === "ALL" ? "ALL" : "PLAYS";
      const poolInfo = getParlayCandidatePool(baseSet);
      const eligibleCount = poolInfo.candidates.length;
      const maxSize = Math.max(2, eligibleCount);
      const size = clamp(Number(config.size) || 2, 2, maxSize);
      const totalCombinations = countCombinations(eligibleCount, size);
      const parlays = state.parlays || [];
      const categoryFilter = PARLAY_CATEGORIES[state.parlayCategoryFilter] ? state.parlayCategoryFilter : "ALL";
      const categoryCounts = { ALL: parlays.length, VALUE: 0, SAFE: 0, ACTION: 0 };
      for (const parlay of parlays) {
        const cat = PARLAY_CATEGORIES[parlay.category] ? parlay.category : "ACTION";
        categoryCounts[cat] += 1;
      }
      const parlaysToShow = categoryFilter === "ALL"
        ? parlays
        : parlays.filter(parlay => (parlay.category || "ACTION") === categoryFilter);
      const shown = parlaysToShow.slice(0, PARLAY_MAX_PARLAYS_SHOWN);
      const canGenerate = eligibleCount >= 2;
      const meta = state.parlayMeta;
      const truncated = !!(meta?.truncated && meta.baseSet === baseSet && meta.size === size);
      const capped = !!(meta?.capped && meta.baseSet === baseSet);
      const sourceLabel = baseSet === "ALL" ? "todos con línea válida" : "solo plays calificados";
      const countText = value => Number(value).toLocaleString("es-MX");
      const totalStake = parlays.reduce((sum, parlay) => sum + (Number(parlay.stakeUnits) || 0), 0);
      const totalStakePct = state.bankroll > 0 ? (totalStake / state.bankroll) * 100 : 0;
      const categoryButtons = Object.entries(PARLAY_CATEGORIES).map(([id, def]) => `
        <button onclick="setParlayCategoryFilter('${id}')"
                class="px-2 py-1 rounded-lg border text-[10px] font-bold ${categoryFilter === id ? "bg-orange-500/15 border-orange-500/40 text-orange-300" : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"}">
          ${def.label} <span class="text-slate-500 font-mono">${countText(categoryCounts[id])}</span>
        </button>
      `).join("");
      return `
        <section class="mb-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="font-bold text-sm">Parlays sugeridos</h2>
              <div class="text-[10px] text-slate-500 font-mono mt-1">
                Base: ${eligibleCount} partidos (${sourceLabel}) · parlay de ${size} patas ·
                C(${eligibleCount}, ${size}) = ${countText(totalCombinations)} ·
                filtro por pata: prob ≥ ${formatPercentage(PARLAY_MIN_PROB_PER_LEG, 0)} y EV ≥ ${formatNumber(PARLAY_MIN_EV_PER_LEG, 2)} ·
                máx ${PARLAY_BASE_MAX_PLAYS} partidos base por EV · stake Kelly conservador.
              </div>
            </div>
            <div class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400">
              ${countText(parlays.length)} combinaciones${parlays.length ? ` · top ${Math.min(PARLAY_MAX_PARLAYS_SHOWN, parlays.length)}` : ""}
            </div>
          </div>
          <div class="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3">
            <label class="flex flex-col gap-1">
              <span class="text-[9px] uppercase tracking-wider text-slate-500">Tamaño del parlay</span>
              <div class="flex items-center gap-1">
                <input type="number" min="2" max="${maxSize}" step="1" value="${size}"
                       onchange="setParlaySize(this.value)"
                       ${canGenerate ? "" : "disabled"}
                       class="w-16 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-1 text-right disabled:opacity-50">
                <span class="text-[10px] text-slate-500">patas · 2–${maxSize}</span>
              </div>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[9px] uppercase tracking-wider text-slate-500">Fuente de picks</span>
              <select onchange="setParlayBaseSet(this.value)"
                      class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-1">
                <option value="PLAYS" ${baseSet === "PLAYS" ? "selected" : ""}>Solo plays calificados</option>
                <option value="ALL" ${baseSet === "ALL" ? "selected" : ""}>Todos con línea válida</option>
              </select>
            </label>
            <div class="flex flex-col gap-1">
              <span class="text-[9px] uppercase tracking-wider text-slate-500">Categoría</span>
              <div class="flex flex-wrap items-center gap-1">${categoryButtons}</div>
            </div>
            <div class="text-[10px] text-slate-500 font-mono pb-1">
              ${canGenerate
                ? `${eligibleCount} elegibles · ${countText(totalCombinations)} combinaciones posibles`
                : "Se necesitan al menos 2 partidos elegibles."}
            </div>
          </div>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#0b0f1c] px-3 py-2">
            <div class="text-[10px] text-slate-400 font-mono">
              Stake total sugerido en parlays:
              <span class="text-slate-200 font-bold">${formatNumber(totalStake, 2)} u</span>
              ${state.bankroll > 0
                ? `<span class="text-slate-500">(~${formatNumber(totalStakePct, 2)}% del bankroll)</span>`
                : `<span class="text-amber-300">· bankroll 0: define tu bankroll para ver stakes</span>`}
            </div>
            <div class="text-[9px] text-slate-500 font-mono">
              Kelly ${formatPercentage(PARLAY_KELLY_FACTOR, 0)} del parlay · máx ${formatNumber(PARLAY_MAX_STAKE_PCT, 1)}% del bankroll por parlay
            </div>
          </div>
          ${capped ? `
            <div class="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200 font-mono">
              Filtro de calidad: ${countText(meta.qualityPassed)} de ${countText(meta.basePool)} partidos de la base
              cumplen prob ≥ ${formatPercentage(PARLAY_MIN_PROB_PER_LEG, 0)} y EV ≥ ${formatNumber(PARLAY_MIN_EV_PER_LEG, 2)}.
              Se usan los ${meta.usedForCombos} mejores por EV.
            </div>
          ` : ""}
          ${truncated ? `
            <div class="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200 font-mono">
              Hay ${countText(meta.totalCombinations)} combinaciones posibles. Para no bloquear el navegador se
              evalúan los ${meta.poolSize} mejores partidos (${countText(meta.generated)} combinaciones).
            </div>
          ` : ""}
          ${state.loading && !state.games.length ? `
            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[11px] text-slate-500 font-mono">
              Descargando partidos y ejecutando Monte Carlo...
            </div>
          ` : parlays.length === 0 ? `
            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[11px] text-slate-500 font-mono">
              ${!canGenerate
                ? (poolInfo.stats.basePool > 0
                  ? `Se necesitan al menos 2 partidos que cumplan prob ≥ ${formatPercentage(PARLAY_MIN_PROB_PER_LEG, 0)} y EV ≥ ${formatNumber(PARLAY_MIN_EV_PER_LEG, 2)} (hay ${poolInfo.stats.basePool} en la base).`
                  : (baseSet === "PLAYS"
                    ? "Se necesitan al menos 2 plays calificados para generar parlays."
                    : "Se necesitan al menos 2 partidos con línea válida para generar parlays."))
                : "No se pudieron calcular parlays con las cuotas y probabilidades actuales."}
            </div>
          ` : shown.length === 0 ? `
            <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3 text-[11px] text-slate-500 font-mono">
              No hay parlays en la categoría ${escapeHTML(PARLAY_CATEGORIES[categoryFilter].label)} con la configuración actual.
            </div>
          ` : `
            <div class="overflow-x-auto mt-3">
              <table class="min-w-full text-[10px] font-mono">
                <thead class="bg-slate-900/60">
                  <tr class="text-slate-500 whitespace-nowrap">
                    <th class="text-left py-1 pr-2 font-normal min-w-[210px]">Parlay</th>
                    <th class="text-center py-1 px-1 font-normal">Cat.</th>
                    <th class="text-right py-1 px-1 font-normal">P(Parlay)</th>
                    <th class="text-right py-1 px-1 font-normal">Cuota dec.</th>
                    <th class="text-right py-1 px-1 font-normal">EV (u)</th>
                    <th class="text-right py-1 px-1 font-normal">Stake (u)</th>
                    <th class="text-left py-1 pl-1 font-normal">Leg débil</th>
                    <th class="text-right py-1 pl-1 font-normal">Cuaderno</th>
                  </tr>
                </thead>
                <tbody>
                  ${shown.map((parlay, index) => {
                    const cat = PARLAY_CATEGORIES[parlay.category] ? parlay.category : "ACTION";
                    const catStyle = PARLAY_CATEGORY_STYLES[cat];
                    const evClass = parlay.evUnits > 0 ? "text-emerald-300" : parlay.evUnits < 0 ? "text-red-300" : "text-slate-300";
                    const evText = `${parlay.evUnits > 0 ? "+" : ""}${formatNumber(parlay.evUnits, 2)}`;
                    const stakeUnits = Number(parlay.stakeUnits) || 0;
                    const weak = parlay.weakLeg;
                    const weakGameId = weak?.gameId ?? null;
                    return `
                      <tr class="border-t border-slate-900/70 align-top ${index % 2 ? "bg-slate-900/20" : ""}">
                        <td class="py-1.5 pr-2 min-w-[210px]">
                          <div class="space-y-0.5">
                            ${parlay.legs.map(leg => `
                              <div>
                                <span class="text-slate-200 font-bold">${escapeHTML(leg.team)} ${formatSpread(leg.spread)}</span>
                                <span class="text-slate-500">@ ${escapeHTML(formatAmericanPrice(leg.price))}</span>
                                ${leg.isAlt ? `<span title="${leg.origin === "MODEL" ? "Línea conservadora generada con los márgenes simulados; misma cuota base (MVP)" : "Línea alternativa del proveedor"}" class="ml-1 px-1 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[8px] font-bold">ALT</span>` : ""}
                                ${leg.oppositeSide ? `<span title="Lado opuesto al pick individual; se usa solo para este parlay" class="ml-1 px-1 py-0.5 rounded bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-300 text-[8px] font-bold">OTRO LADO</span>` : ""}
                                ${weakGameId != null && leg.gameId === weakGameId ? `<span title="Pata con menor probabilidad del parlay" class="ml-1 px-1 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-[8px] font-bold">DÉBIL</span>` : ""}
                                <span class="text-slate-600">· ${escapeHTML(leg.matchup)}</span>
                              </div>
                            `).join("")}
                          </div>
                        </td>
                        <td class="py-1.5 px-1 text-center">
                          <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold ${catStyle}">${cat}</span>
                        </td>
                        <td class="py-1.5 px-1 text-right text-slate-300">${formatPercentage(parlay.prob, 1)}</td>
                        <td class="py-1.5 px-1 text-right text-slate-300">${formatNumber(parlay.oddsDecimal, 2)}</td>
                        <td class="py-1.5 px-1 text-right font-bold ${evClass}">${evText}</td>
                        <td class="py-1.5 px-1 text-right ${stakeUnits > 0 ? "text-emerald-200 font-bold" : "text-slate-600"}">${stakeUnits > 0 ? formatNumber(stakeUnits, 2) : "—"}</td>
                        <td class="py-1.5 pl-1 text-slate-300">
                          ${weak
                            ? `<span class="text-slate-200 font-bold">${escapeHTML(weak.team ?? "—")} ${formatSpread(weak.spread)}</span>
                               <span class="text-slate-500">(${formatPercentage(weak.probability, 1)})</span>`
                            : "—"}
                        </td>
                        <td class="py-1.5 pl-1 text-right">
                          <button onclick="openAddBetFromParlay(${state.parlays.indexOf(parlay)})"
                                  class="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] text-slate-200 hover:bg-slate-700">+Cuaderno</button>
                        </td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>
            ${categoryFilter !== "ALL" || parlaysToShow.length > shown.length ? `
              <div class="mt-1 text-[9px] text-slate-500 font-mono">
                Mostrando ${shown.length} de ${countText(parlaysToShow.length)} parlays${categoryFilter !== "ALL" ? ` en ${escapeHTML(PARLAY_CATEGORIES[categoryFilter].label)}` : ""}.
              </div>
            ` : ""}
          `}
          <div class="mt-2 text-[9px] text-slate-500 font-mono">
            Filtro de patas: cada partido debe cumplir prob ≥ ${formatPercentage(PARLAY_MIN_PROB_PER_LEG, 0)} y EV ≥ ${formatNumber(PARLAY_MIN_EV_PER_LEG, 2)};
            se usan hasta ${PARLAY_BASE_MAX_PLAYS} partidos ordenados por EV y hasta ${PARLAY_MAX_PARLAYS_SHOWN} parlays por EV.
            Categorías: VALUE (EV &gt; 0 y prob ≥ ${formatPercentage(PARLAY_CATEGORY_MIN_VALUE_PROB, 0)}), SAFE (prob ≥ ${formatPercentage(PARLAY_CATEGORY_MIN_SAFE_PROB, 0)}), ACTION (resto).
            Stake: ${formatPercentage(PARLAY_KELLY_FACTOR, 0)} del Kelly del parlay, tope ${formatNumber(PARLAY_MAX_STAKE_PCT, 1)}% del bankroll; 0 si el Kelly es ≤ 0.
            Cada pata evalúa ambos lados del partido (local y visitante) con la línea de mercado y dos spreads
            conservadores por base (+${state.sport.id === "MLB" ? "1, +2" : "2, +4"} ${state.sport.unitName}, misma cuota base MVP),
            más las alternativas del proveedor. Se elige la línea con la mayor probabilidad de cubrir entre las que
            tienen prob ≥ ${formatPercentage(PARLAY_LEG_SAFE_PROB, 0)} y EV ≥ ${formatNumber(PARLAY_LEG_MIN_EV, 2)};
            si no hay ninguna así, la de mayor EV. La línea del pick individual se conserva como opción adicional.
            El chip OTRO LADO marca legs del lado opuesto al pick individual. La probabilidad combinada asume
            independencia entre partidos. Informativo: los parlays no se registran como pick oficial.
          </div>
        </section>
      `;
    }

    function renderPropsPanel() {
      const props = propsForCurrentSport();
      const totalStake = props.reduce((sum, prop) => sum + (Number(prop.stakeOver) || 0) + (Number(prop.stakeUnder) || 0), 0);
      const positive = props.filter(prop => (Number(prop.evOver) > 0) || (Number(prop.evUnder) > 0)).length;
      const inputClass = "bg-slate-900 border border-slate-700 text-slate-200 rounded px-2 py-1 text-[11px] focus:border-cyan-500 outline-none";
      const labelClass = "flex flex-col gap-1";
      const labelText = "text-[9px] uppercase tracking-wider text-slate-500";
      const sideCell = (prob, price, ev, stake, isBest) => `
        <td class="px-2 py-1.5 border-t border-slate-800/70 whitespace-nowrap align-top">
          <div class="font-mono text-[11px] ${isBest ? "text-cyan-300 font-bold" : "text-slate-300"}">${formatPercentage(prob, 1)}</div>
          <div class="font-mono text-[10px] text-slate-500">${formatAmericanPrice(price)} · EV ${formatPropEV(ev)}</div>
          <div class="font-mono text-[10px] ${stake > 0 ? "text-amber-300" : "text-slate-600"}">$${formatNumber(stake, 2)}</div>
        </td>`;
      const rows = props.map(prop => {
        const best = bestPropSide(prop);
        return `
          <tr>
            <td class="px-2 py-1.5 border-t border-slate-800/70 align-top">
              <div class="font-bold text-[11px] text-slate-200">${escapeHTML(prop.playerName)}</div>
              <div class="text-[9px] text-slate-500 font-mono">
                ${escapeHTML(prop.teamAbbr || "—")} · ${escapeHTML(prop.marketType)}${prop.statName ? " · " + escapeHTML(prop.statName) : ""}
              </div>
            </td>
            <td class="px-2 py-1.5 border-t border-slate-800/70 font-mono text-[11px] text-slate-300 whitespace-nowrap align-top">
              ${formatNumber(prop.line, 2)}
              <div class="text-[9px] text-slate-500">μ ${formatNumber(prop.mean, 2)} · σ ${formatNumber(prop.sd, 2)}</div>
            </td>
            ${sideCell(prop.probOver, prop.priceOver, prop.evOver, Number(prop.stakeOver) || 0, best === "OVER")}
            ${sideCell(prop.probUnder, prop.priceUnder, prop.evUnder, Number(prop.stakeUnder) || 0, best === "UNDER")}
            <td class="px-2 py-1.5 border-t border-slate-800/70 whitespace-nowrap align-top">
              ${best
                ? `<span class="px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-[9px] font-bold">${best}</span>`
                : `<span class="text-[9px] text-slate-600 font-mono">sin EV+</span>`}
            </td>
            <td class="px-2 py-1.5 border-t border-slate-800/70 text-right align-top">
              <button onclick="openAddBetFromProp('${escapeHTML(prop.id)}')" class="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] text-slate-200 hover:bg-slate-700 font-mono">+Cuaderno</button>
              <div class="mt-1">
                <button onclick="removePlayerProp('${escapeHTML(prop.id)}')" class="text-[10px] text-slate-500 hover:text-red-400 font-mono">eliminar</button>
              </div>
            </td>
          </tr>`;
      }).join("");
      return `
        <section class="mb-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="font-bold text-sm">Player Props <span class="text-[10px] text-cyan-300 font-mono">· ${escapeHTML(state.sport.label)}</span></h2>
              <div class="text-[10px] text-slate-500 font-mono mt-1">
                Entrada manual · P(Over) = 1 − Φ((línea − media)/sd) · EV con cuota americana · stake Kelly topado por Max bet.
              </div>
            </div>
            <div class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400">
              ${props.length} props · ${positive} con EV+ · stake $${formatNumber(totalStake, 2)}
            </div>
          </div>

          <div class="mt-3 rounded-xl border border-slate-800 bg-[#0b0f1c] p-3">
            <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
              <label class="${labelClass} col-span-2">
                <span class="${labelText}">Jugador *</span>
                <input id="propPlayer" type="text" placeholder="LeBron James" class="${inputClass}">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Equipo</span>
                <input id="propTeam" type="text" placeholder="LAL" class="${inputClass} uppercase">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Mercado *</span>
                <input id="propMarket" type="text" list="propMarketPresets" placeholder="Puntos" class="${inputClass}">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Stat</span>
                <input id="propStat" type="text" placeholder="PTS" class="${inputClass}">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Línea *</span>
                <input id="propLine" type="number" step="0.5" placeholder="27.5" class="${inputClass} text-right">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Media (μ) *</span>
                <input id="propMean" type="number" step="0.1" placeholder="28.0" class="${inputClass} text-right">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Desv. (σ) *</span>
                <input id="propSd" type="number" step="0.1" min="0.1" placeholder="6.0" class="${inputClass} text-right">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Cuota Over</span>
                <input id="propPriceOver" type="number" step="1" placeholder="-110" class="${inputClass} text-right">
              </label>
              <label class="${labelClass}">
                <span class="${labelText}">Cuota Under</span>
                <input id="propPriceUnder" type="number" step="1" placeholder="-110" class="${inputClass} text-right">
              </label>
              <div class="flex items-end">
                <button onclick="addPlayerProp()" class="w-full px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs font-bold">
                  Calcular y añadir
                </button>
              </div>
            </div>
            <datalist id="propMarketPresets">
              ${["Puntos", "Rebotes", "Asistencias", "Puntos+Rebotes+Asistencias", "Triples", "Robos", "Bloqueos", "Ponches", "Hits", "Carreras", "Yardas", "Touchdowns", "Recepciones"]
                .map(value => `<option value="${value}"></option>`).join("")}
            </datalist>
            ${state.propsError ? `<div class="mt-2 text-[10px] font-mono text-red-300">${escapeHTML(state.propsError)}</div>` : ""}
            ${state.propsNotice ? `<div class="mt-2 text-[10px] font-mono text-emerald-300">${escapeHTML(state.propsNotice)}</div>` : ""}
          </div>

          ${props.length ? `
            <div class="mt-3 overflow-x-auto">
              <table class="w-full text-left border-collapse min-w-[760px]">
                <thead>
                  <tr class="text-[9px] uppercase tracking-wider text-slate-500">
                    <th class="px-2 pb-1.5">Jugador / mercado</th>
                    <th class="px-2 pb-1.5">Línea / modelo</th>
                    <th class="px-2 pb-1.5">Over</th>
                    <th class="px-2 pb-1.5">Under</th>
                    <th class="px-2 pb-1.5">Valor</th>
                    <th class="px-2 pb-1.5"></th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] font-mono text-slate-500">
              <span>
                Bankroll $${formatNumber(Math.max(0, Number(state.bankroll) || 0), 2)} · Max bet ${formatNumber(state.maxStakePerBetPct, 1)}% ·
                empates no modelados (normal continua).
              </span>
              <button onclick="clearPlayerProps()" class="text-[10px] text-red-300/80 hover:text-red-300">
                Borrar props de ${escapeHTML(state.sport.label)}
              </button>
            </div>
          ` : `
            <div class="mt-3 rounded-xl border border-dashed border-slate-800 p-4 text-center text-[11px] text-slate-500">
              Sin props de ${escapeHTML(state.sport.label)}. Añade una entrada manual arriba.
            </div>
          `}
        </section>
      `;
    }

    function render() {
      const app = document.getElementById("app");
      state.stakePlan = computeStakePlan(state.games);
      const plays = state.games.filter(g => g.qualified);
      const propsCount = propsForCurrentSport().length;
      const journalCount = (state.betJournal || []).filter(b => b.dateKey === state.dateKey).length;
      const gamesWithMarket = state.games.filter(g => g.market?.available);

      const base = state.tab === "PLAYS" ? plays : state.games;
      const showGames = applyFiltersAndSort(base);

      const minEdgeDisplay = formatNumber(getEffectiveMinEdge(state.riskProfile, state.sport), 2);
      const minZDisplay = getEffectiveMinZ(state.riskProfile);
      const kellyCtx = state.kellyContext;
      const enrichedCount = state.games.filter(g => g.modelInputs).length;
      const summary = summarizeOfficialPicks(state.officialPicks);

      app.innerHTML = `
        <header class="relative overflow-hidden rounded-3xl bg-[#111524]/95 border border-slate-800 p-5 sm:p-7 mb-5">
          <div class="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-orange-500 via-amber-400 to-emerald-500"></div>
          ${state.loading ? `
            <div class="absolute top-0 left-0 right-0 h-0.5 overflow-hidden bg-slate-800">
              <div class="loading-bar w-1/3 h-full bg-gradient-to-r from-orange-500 to-emerald-400"></div>
            </div>
          ` : ""}
          <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div>
              <div class="flex items-center gap-3">
                <div class="w-11 h-11 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-300 text-slate-950 flex items-center justify-center font-black text-xl shadow-lg">
                  LP
                </div>
                <div>
                  <h1 class="text-2xl sm:text-3xl font-black tracking-tight">
                    Lord's <span class="text-orange-400">Predictions</span>
                  </h1>
                  <p class="text-xs text-slate-400 mt-0.5">
                    ${escapeHTML(state.sport.description)}
                  </p>
                </div>
              </div>
              <div class="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span class="px-2 py-1 rounded-full bg-slate-900 border border-slate-800">
                  ${escapeHTML(state.dateLabel)}
                </span>
                <span class="px-2 py-1 rounded-full bg-slate-900 border border-slate-800">
                  Deporte: ${escapeHTML(state.sport.label)}
                </span>
                <span class="px-2 py-1 rounded-full bg-slate-900 border border-slate-800">
                  Fuente: ${escapeHTML(state.source)}
                </span>
                <span class="px-2 py-1 rounded-full bg-slate-900 border border-slate-800">
                  Actualizado: ${escapeHTML(formatUpdatedTime(state.lastUpdated))}
                </span>
                <span class="px-2 py-1 rounded-full ${state.testsPassed ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20" : "bg-red-500/10 text-red-300 border-red-500/20"} border">
                  Pruebas: ${state.testsPassed ? "OK" : "ERROR"}
                </span>
                ${state.altMarkets.error ? `
                  <span class="px-2 py-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20" title="${escapeHTML(state.altMarkets.error)}">
                    Cuotas alt.: sin backend
                  </span>
                ` : ""}
              </div>
            </div>
            <div class="flex flex-col gap-3 items-end">
              <div class="flex gap-2 flex-wrap justify-end">
                ${renderSportButtons()}
                ${renderRiskButtons()}
              </div>
              <div class="flex flex-wrap gap-2 justify-end">
                <button onclick="selectDay(-1)" ${state.loading ? "disabled" : ""} class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold">
                  Ayer
                </button>
                <button onclick="selectDay(0)" ${state.loading ? "disabled" : ""} class="px-3 py-2 rounded-xl ${state.dayOffset === 0 ? "bg-orange-500 text-white" : "bg-slate-800 hover:bg-slate-700"} text-xs font-bold">
                  Hoy
                </button>
                <button onclick="selectDay(1)" ${state.loading ? "disabled" : ""} class="px-3 py-2 rounded-xl ${state.dayOffset === 1 ? "bg-orange-500 text-white" : "bg-slate-800 hover:bg-slate-700"} text-xs font-bold">
                  Mañana
                </button>
                <button onclick="manualRefresh()" ${state.loading ? "disabled" : ""} class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold">
                  ${state.loading ? "Actualizando..." : "Actualizar"}
                </button>
                <button onclick="generatePDF()" ${state.loading || !state.games.length ? "disabled" : ""} class="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-bold">
                  Descargar PDF
                </button>
              </div>
              <div class="flex flex-col items-end gap-1 text-[10px] text-slate-400 max-w-xs">
                <div class="flex flex-wrap gap-2 justify-end items-center">
                  <span class="text-slate-500">Bankroll:</span>
                  <input type="number" min="0" step="1"
                         value="${state.bankroll}"
                         onchange="setBankroll(this.value)"
                         class="w-20 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-right">
                  <span class="text-slate-500">Max bet:</span>
                  <input type="number" min="0" step="0.5"
                         value="${state.maxStakePerBetPct}"
                         onchange="setMaxStakePerBetPct(this.value)"
                         class="w-14 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-right">
                  <span class="text-slate-500">%</span>
                  <span class="text-slate-500">Riesgo diario:</span>
                  <input type="number" min="0" step="1"
                         value="${state.maxDailyRiskPct}"
                         onchange="setMaxDailyRiskPct(this.value)"
                         class="w-14 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-right">
                  <span class="text-slate-500">%</span>
                </div>
                <div class="text-right ${state.stakePlan.exceeded ? "text-amber-300" : "text-slate-500"}">
                  Plan diario: $${formatNumber(state.stakePlan.total, 2)} de $${formatNumber(state.stakePlan.cap, 2)}
                  (${state.stakePlan.count} play${state.stakePlan.count === 1 ? "" : "s"}${state.bankroll > 0
                    ? ` · ${formatPercentage(state.stakePlan.total / state.bankroll, 1)} del bankroll`
                    : ""})${state.stakePlan.exceeded
                    ? ` · ajustado ×${formatNumber(state.stakePlan.scale, 2)} por límite`
                    : ""}
                </div>
                <div class="text-right">
                  Perfil: ${escapeHTML(state.riskProfile.description)} · Edge mín ~${minEdgeDisplay} ${state.sport.unitName}
                  · z mín ${formatNumber(minZDisplay, 2)}
                </div>
                <div class="text-right">
                  ${kellyCtx ? `
                    Temporada ${formatPercentage(kellyCtx.seasonProgress, 0)} ·
                    Drawdown ${formatNumber(kellyCtx.drawdownUnits, 2)}u ·
                    Kelly cap ${formatNumber(kellyCtx.maxKelly, 2)}%
                  ` : "Kelly cap por perfil"}
                </div>
              </div>
            </div>
          </div>
        </header>

        ${state.error ? `
          <div class="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            ${escapeHTML(state.error)}
          </div>
        ` : ""}

        ${state.warning ? `
          <div class="mb-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-xs text-amber-200">
            ${escapeHTML(state.warning)}
          </div>
        ` : ""}

        ${renderAlertsPanel()}

        ${renderOddsProviderPanel()}

        <section class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          <div class="rounded-2xl bg-[#111524] border border-slate-800 p-4">
            <div class="text-[10px] uppercase tracking-wider text-slate-500">Partidos</div>
            <div class="text-2xl font-black mt-1">${state.games.length}</div>
          </div>
          <div class="rounded-2xl bg-[#111524] border border-slate-800 p-4">
            <div class="text-[10px] uppercase tracking-wider text-slate-500">Con línea</div>
            <div class="text-2xl font-black mt-1">${gamesWithMarket.length}</div>
            <div class="text-[9px] text-slate-600">
              ${state.games.filter(g => (g.market?.booksCount || 0) > 1).length} con 2+ casas
            </div>
          </div>
          <div class="rounded-2xl bg-[#111524] border border-slate-800 p-4">
            <div class="text-[10px] uppercase tracking-wider text-slate-500">
              Plays (${escapeHTML(state.riskProfile.label)})
            </div>
            <div class="text-2xl font-black mt-1 text-emerald-400">${plays.length}</div>
          </div>
          <div class="rounded-2xl bg-[#111524] border border-slate-800 p-4">
            <div class="text-[10px] uppercase tracking-wider text-slate-500">Resultados</div>
            <div class="text-2xl font-black mt-1">
              ${
                (() => {
                  const settled = state.games.filter(g => g.qualified && ["WIN","LOSS","PUSH"].includes(g.pickResult));
                  const w = settled.filter(g => g.pickResult === "WIN").length;
                  const l = settled.filter(g => g.pickResult === "LOSS").length;
                  const p = settled.filter(g => g.pickResult === "PUSH").length;
                  return settled.length ? `${w}-${l}${p ? "-" + p : ""}` : "—";
                })()
              }
            </div>
            <div class="text-[9px] text-slate-600">W-L de plays</div>
          </div>
          <div class="rounded-2xl bg-[#111524] border border-slate-800 p-4">
            <div class="text-[10px] uppercase tracking-wider text-slate-500">Simulaciones</div>
            <div class="text-2xl font-black mt-1 text-orange-400">
              ${state.sport.id === "MLB" ? "18,000" : "22,000"}
            </div>
            <div class="text-[9px] text-slate-600">por partido</div>
          </div>
        </section>

        <nav class="flex gap-2 mb-3">
          <button onclick="setTab('ALL')" class="px-4 py-2 rounded-xl text-xs font-mono font-bold ${state.tab === "ALL" ? "bg-orange-500 text-white" : "bg-[#111524] text-slate-400 border border-slate-800"}">
            TODOS (${state.games.length})
          </button>
          <button onclick="setTab('PLAYS')" class="px-4 py-2 rounded-xl text-xs font-mono font-bold ${state.tab === "PLAYS" ? "bg-emerald-500 text-slate-950" : "bg-[#111524] text-slate-400 border border-slate-800"}">
            PLAYS (${plays.length})
          </button>
          <button onclick="setTab('PARLAYS')" class="px-4 py-2 rounded-xl text-xs font-mono font-bold ${state.tab === "PARLAYS" ? "bg-indigo-500 text-white" : "bg-[#111524] text-slate-400 border border-slate-800"}">
            PARLAYS (${state.parlays.length})
          </button>
          <button onclick="setTab('PROPS')" class="px-4 py-2 rounded-xl text-xs font-mono font-bold ${state.tab === "PROPS" ? "bg-cyan-500 text-slate-950" : "bg-[#111524] text-slate-400 border border-slate-800"}">
            PROPS (${propsCount})
          </button>
          <button onclick="setTab('JOURNAL')" class="px-4 py-2 rounded-xl text-xs font-mono font-bold ${state.tab === "JOURNAL" ? "bg-amber-500 text-slate-950" : "bg-[#111524] text-slate-400 border border-slate-800"}">
            CUADERNO (${journalCount})
          </button>
        </nav>

        ${state.tab === "PARLAYS" ? renderParlaysPanel() : ""}
        ${state.tab === "PROPS" ? renderPropsPanel() : ""}
        ${state.tab === "JOURNAL" ? renderJournalPanel() : ""}

        <div class="${["PARLAYS", "PROPS", "JOURNAL"].includes(state.tab) ? "hidden" : ""}">

        <section class="mb-3 flex justify-between items-center text-[10px] font-mono text-slate-400">
          <div class="inline-flex border border-slate-700 rounded-xl overflow-hidden">
            <button onclick="setViewMode('DETAILED')" class="px-2 py-1 ${state.viewMode === 'DETAILED' ? 'bg-orange-500 text-white' : 'bg-slate-900 text-slate-400'}">
              Detallada
            </button>
            <button onclick="setViewMode('COMPACT')" class="px-2 py-1 ${state.viewMode === 'COMPACT' ? 'bg-orange-500 text-white' : 'bg-slate-900 text-slate-400'}">
              Compacta
            </button>
          </div>
        </section>

        <section class="mb-5 rounded-2xl bg-[#111524] border border-slate-800 p-3 text-[11px] font-mono">
          <div class="flex flex-wrap gap-3 items-center">
            <label class="inline-flex items-center gap-1">
              <input type="checkbox" onchange="toggleFilter('onlyWithLine', this.checked)" ${state.filters.onlyWithLine ? "checked" : ""} class="w-3 h-3 text-orange-500 bg-slate-900 border-slate-700 rounded">
              <span class="text-slate-400">Solo con línea válida</span>
            </label>
            <label class="inline-flex items-center gap-1">
              <input type="checkbox" onchange="toggleFilter('onlyQualified', this.checked)" ${state.filters.onlyQualified ? "checked" : ""} class="w-3 h-3 text-orange-500 bg-slate-900 border-slate-700 rounded">
              <span class="text-slate-400">Solo plays</span>
            </label>
            <label class="inline-flex items-center gap-1">
              <input type="checkbox" onchange="toggleFilter('onlyClean', this.checked)" ${state.filters.onlyClean ? "checked" : ""} class="w-3 h-3 text-orange-500 bg-slate-900 border-slate-700 rounded">
              <span class="text-slate-400">Línea limpia (sin avisos)</span>
            </label>
            <div class="flex items-center gap-1">
              <span class="text-slate-500">Estado:</span>
              <select onchange="setStatusFilter(this.value)" class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5">
                <option value="ALL" ${state.filters.status === "ALL" ? "selected" : ""}>Todos</option>
                <option value="PENDING" ${state.filters.status === "PENDING" ? "selected" : ""}>Pendientes</option>
                <option value="LIVE" ${state.filters.status === "LIVE" ? "selected" : ""}>En vivo</option>
                <option value="FINAL" ${state.filters.status === "FINAL" ? "selected" : ""}>Finalizados</option>
              </select>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-slate-500">Edge mín:</span>
              <input type="number" min="0" step="0.5"
                     value="${state.filters.minEdge}"
                     onchange="setMinEdgeFilter(this.value)"
                     class="w-16 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-right">
            </div>
            <div class="flex items-center gap-1">
              <span class="text-slate-500" title="Edge en desviaciones estándar del deporte">z-edge mín:</span>
              <input type="number" min="0" max="1" step="0.01"
                     value="${formatNumber(minZDisplay, 2)}"
                     onchange="setMinZ(this.value)"
                     class="w-14 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-right">
              <button onclick="setMinZ('')" title="Volver al valor del perfil"
                      class="px-1 py-0.5 rounded border border-slate-700 text-slate-400 bg-slate-900 hover:text-slate-200 text-[9px]">
                auto
              </button>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-slate-500">Prob. mín:</span>
              <input type="number" min="0" max="100" step="0.5"
                     value="${formatNumber((state.filters.minProbability || 0) * 100, 0)}"
                     onchange="setMinProbabilityFilter(this.value)"
                     class="w-14 bg-slate-900 border border-slate-700 text-slate-200 rounded px-1 py-0.5 text-right">
              <span class="text-slate-500">%</span>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-slate-500">Lado:</span>
              <select onchange="setSideTypeFilter(this.value)" class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5">
                <option value="ALL" ${state.filters.sideType === "ALL" ? "selected" : ""}>Todos</option>
                <option value="FAVORITES" ${state.filters.sideType === "FAVORITES" ? "selected" : ""}>Favoritos</option>
                <option value="DOGS" ${state.filters.sideType === "DOGS" ? "selected" : ""}>Underdogs</option>
              </select>
            </div>
            <div class="flex items-center gap-1 ml-auto">
              <span class="text-slate-500">Orden:</span>
              <select onchange="setSortField(this.value)" class="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5">
                <option value="EDGE" ${state.sort.field === "EDGE" ? "selected" : ""}>Edge</option>
                <option value="KELLY" ${state.sort.field === "KELLY" ? "selected" : ""}>Kelly</option>
                <option value="EV" ${state.sort.field === "EV" ? "selected" : ""}>EV</option>
                <option value="PROB" ${state.sort.field === "PROB" ? "selected" : ""}>Probabilidad</option>
                <option value="TIME" ${state.sort.field === "TIME" ? "selected" : ""}>Hora</option>
              </select>
              <button onclick="toggleSortDirection()" class="px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 bg-slate-900">
                ${state.sort.direction === "DESC" ? "↓" : "↑"}
              </button>
            </div>
          </div>
        </section>

        ${state.loading && state.games.length === 0 ? `
          <div class="py-20 text-center">
            <div class="inline-block w-9 h-9 rounded-full border-2 border-slate-700 border-t-orange-500 animate-spin"></div>
            <div class="mt-4 text-sm text-slate-400">
              Descargando datos y ejecutando Monte Carlo...
            </div>
          </div>
        ` : ""}

        ${!state.loading && showGames.length === 0 ? `
          <div class="rounded-2xl border border-slate-800 bg-[#111524] p-10 text-center">
            <div class="font-bold text-slate-300">
              ${state.tab === "PLAYS"
                ? "No hay plays que cumplan los filtros de este perfil."
                : "No hay partidos programados para esta fecha o los filtros son muy estrictos."
              }
            </div>
            <div class="text-xs text-slate-500 mt-2">
              Revisa tus filtros (edge mínimo, solo plays, estado, etc.).
            </div>
          </div>
        ` : ""}

        ${state.games.length > 0 ? renderTotalsSummary(state.games) : ""}

        <main class="${
          state.viewMode === 'DETAILED'
            ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4'
            : 'grid grid-cols-1 gap-2'
        }">
          ${
            showGames.map(g =>
              state.viewMode === "DETAILED"
                ? renderGameCardDetailed(g)
                : renderGameCardCompact(g)
            ).join("")
          }
        </main>
        </div>

        ${renderBacktestPanel()}

        ${renderOfficialAnalyticsPanel()}

        <section class="mt-5 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <div class="flex items-center justify-between gap-2 mb-3">
            <h2 class="font-bold text-sm">Historial de picks oficiales (local)</h2>
            <div class="flex items-center gap-2">
              <div class="text-[10px] text-slate-500">
                Guardado en este navegador · ${state.officialPicks.length} picks
              </div>
              <button onclick="exportOfficialPicksCSV()"
                      class="px-2 py-1 rounded border border-slate-700 text-[10px] text-slate-200 bg-slate-900 hover:bg-slate-800">
                Exportar CSV
              </button>
            </div>
          </div>
          ${state.officialPicks.length === 0 ? `
            <div class="text-[11px] text-slate-500">
              Aún no has marcado ningún pick como oficial.
              Usa el botón <span class="text-indigo-300 font-bold">"Marcar como pick oficial"</span> en las tarjetas.
            </div>
          ` : `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono mb-3">
              <div>
                <span class="text-slate-500">Récord:</span>
                ${summary.wins}-${summary.losses}${summary.pushes ? "-" + summary.pushes : ""}
              </div>
              <div>
                <span class="text-slate-500">Unidades:</span>
                ${formatNumber(summary.units, 2)}
              </div>
              <div>
                <span class="text-slate-500">Bets:</span>
                ${summary.totalBets}
              </div>
              <div>
                <span class="text-slate-500">ROI por apuesta:</span>
                ${formatPercentage(summary.roi, 1)}
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="min-w-full text-[10px] font-mono border-t border-slate-800">
                <thead class="bg-slate-900/60">
                  <tr>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Fecha</th>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Deporte</th>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Partido</th>
                    <th class="text-left py-1.5 px-2 text-slate-400 font-normal">Pick</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Cuota</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">No-vig</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">CLV</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">ATS</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">SU</th>
                    <th class="text-right py-1.5 px-2 text-slate-400 font-normal">Unidades</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    state.officialPicks
                      .slice()
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map(p => {
                        const dt = new Date(p.createdAt);
                        const dateStr = dt.toLocaleDateString("es-MX", { month: "2-digit", day: "2-digit" });
                        const resColor = p.result === "WIN" ? "text-emerald-300"
                                      : p.result === "LOSS" ? "text-red-300"
                                      : "text-slate-300";
                        const priceStr = p.price > 0 ? "+" + p.price : String(p.price);
                        const clv = getOfficialPickClv(p);
                        const noVig = p.entryNoVig ?? p.modelNoVig;
                        return `
                          <tr class="border-t border-slate-900/70">
                            <td class="py-1.5 px-2 text-slate-300">${escapeHTML(dateStr)}</td>
                            <td class="py-1.5 px-2 text-slate-400">${escapeHTML(p.sportId)}</td>
                            <td class="py-1.5 px-2 text-slate-200">${escapeHTML(p.matchup)}</td>
                            <td class="py-1.5 px-2 text-slate-200">
                              ${escapeHTML(p.pickTeam)} ${formatSpread(p.pickSpread)}
                            </td>
                            <td class="py-1.5 px-2 text-right text-slate-300">${priceStr}</td>
                            <td class="py-1.5 px-2 text-right text-slate-400">${noVig != null ? formatPercentage(noVig) : "—"}</td>
                            <td class="py-1.5 px-2 text-right ${
                              clv?.clvPts > 0 ? "text-emerald-300" : clv?.clvPts < 0 ? "text-red-300" : "text-slate-500"
                            }">${clv?.clvPts != null ? formatSignedPctPoints(clv.clvPts) : "—"}</td>
                            <td class="py-1.5 px-2 text-right ${resColor}">${p.result}</td>
                            <td class="py-1.5 px-2 text-right ${
                              p.suResult === "WIN" ? "text-emerald-300" :
                              p.suResult === "LOSS" ? "text-red-300" : "text-slate-500"
                            }">${p.suResult || "—"}</td>
                            <td class="py-1.5 px-2 text-right ${
                              p.units > 0 ? "text-emerald-300" :
                              p.units < 0 ? "text-red-300" : "text-slate-300"
                            }">
                              ${formatNumber(p.units, 2)}
                            </td>
                          </tr>
                        `;
                      }).join("")
                  }
                </tbody>
              </table>
            </div>
          `}
        </section>

        <section class="mt-7 rounded-2xl bg-[#111524] border border-slate-800 p-4">
          <h2 class="font-bold text-sm">Configuración del modelo</h2>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-[11px] font-mono">
            <div>
              <span class="text-slate-500">Localía base:</span>
              ${state.sport.homeAdvantageBase} ${state.sport.unitName}
            </div>
            <div>
              <span class="text-slate-500">Desviación:</span>
              ${state.sport.stdDev}
            </div>
            <div>
              <span class="text-slate-500">Perfil:</span>
              ${escapeHTML(state.riskProfile.label)}
            </div>
            <div>
              <span class="text-slate-500">Deporte:</span>
              ${escapeHTML(state.sport.label)}
            </div>
            <div>
              <span class="text-slate-500">z-edge mín:</span>
              ${formatNumber(minZDisplay, 2)} ${state.minZOverride == null ? "(perfil)" : "(manual)"}
            </div>
            <div>
              <span class="text-slate-500">Kelly cap:</span>
              ${kellyCtx ? `${formatNumber(kellyCtx.maxKelly, 2)}% de ${formatNumber(state.riskProfile.maxKelly, 2)}%` : "por perfil"}
            </div>
            <div>
              <span class="text-slate-500">Temporada:</span>
              ${kellyCtx ? `${formatPercentage(kellyCtx.seasonProgress, 0)} (${formatNumber(kellyCtx.avgGames, 0)}/${kellyCtx.totalGames})` : "—"}
            </div>
            <div>
              <span class="text-slate-500">Drawdown:</span>
              ${kellyCtx
                ? `${formatNumber(kellyCtx.drawdownUnits, 2)}u · factor ${formatNumber(kellyCtx.drawdownFactor, 2)} (${kellyCtx.settledCount} settled)`
                : "—"}
            </div>
            <div>
              <span class="text-slate-500">Consenso mín:</span>
              ${formatSignedPctPoints(state.riskProfile.minConsensusEdge ?? 0)}
            </div>
            <div>
              <span class="text-slate-500">Datos enriquecidos:</span>
              ${enrichedCount}/${state.games.length} partidos
            </div>
          </div>
          <div class="mt-2 text-[9px] text-slate-500 font-mono">
            NBA: pace, ratings, eFG%, 3P%, FT%, TO%, rebotes y lesiones (ESPN). MLB: abridores (ERA/FIP/K%/BB%/GB%/mano),
            bullpen de relevistas (ERA/FIP), pitcheo de equipo, park factor y clima (MLB Stats API).
          </div>
        </section>

        <footer class="mt-7 pb-6 text-center text-[10px] leading-relaxed text-slate-600 font-mono">
          Lord's Predictions actualiza la información cada cinco minutos. Las proyecciones son estimaciones estadísticas y no garantizan resultados. Apuesta responsablemente.
        </footer>
      `;
    }
