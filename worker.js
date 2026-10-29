/**
 * Lord's Predictions — worker.js
 * Monte Carlo fuera del hilo principal.
 *
 * Importa el modelo completo (config + utils + model) y ejecuta `simulateGame`
 * tal cual, de modo que los resultados sean idénticos a los del hilo principal.
 * main.js tiene un fallback: si el worker falla o no está disponible, simula
 * en el hilo principal con la misma función.
 */
"use strict";

importScripts("config.js", "utils.js", "model.js");

self.onmessage = (event) => {
  const data = event.data || {};
  const { requestId } = data;
  try {
    const sportConfig = SPORTS[data.sportId];
    if (!sportConfig) throw new Error(`sport_desconocido:${data.sportId}`);
    const games = Array.isArray(data.games) ? data.games : [];
    // El Map de standings llega clonado por structured clone.
    const standingsMap = data.standingsMap instanceof Map ? data.standingsMap : new Map(data.standingsMap || []);
    const runtime = {
      dateKey: data.dateKey || "",
      sims: data.sims ?? null,
      minZOverride: data.minZOverride ?? null
    };
    const results = games.map(game =>
      simulateGame(game, standingsMap, sportConfig, data.riskProfile, data.kellyContext || null, runtime)
    );
    self.postMessage({ requestId, results });
  } catch (error) {
    self.postMessage({ requestId, error: String(error?.message || error) });
  }
};
