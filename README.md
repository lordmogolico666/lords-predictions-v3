# Lord's Predictions — NBA / MLB / NFL

App de predicciones deportivas con simulación Monte Carlo, análisis de cuotas,
parlays, bankroll/Kelly, player props y backtesting.

## Estructura

| Archivo | Contenido |
| --- | --- |
| `index.html` | Solo markup, Tailwind/jsPDF y carga ordenada de scripts. |
| `config.js` | `SPORTS`, `RISK_PROFILES`, `GLOBAL_CONFIG`, cuotas, parlays, `MONTE_CARLO`, `ENRICHMENT_CONCURRENCY`, `WORKER_CONFIG`. |
| `utils.js` | Helpers puros: formato, RNG, Poisson, odds, Kelly, fechas, semáforo de concurrencia. |
| `model.js` | Fuerza de equipo, `simulateGame` (Monte Carlo), totales, parlays y props. Sin red. |
| `api.js` | ESPN (scoreboard/standings/enriquecimiento), The Odds API vía proxy, cachés y `AbortSignal`. |
| `worker.js` | Web Worker que importa config/utils/model y ejecuta `simulateGame` fuera del hilo principal. |
| `store.js` | Persistencia local: caché, picks oficiales, cuaderno de apuestas, snapshots, alertas, props. |
| `ui.js` | Render, paneles, handlers, exportación PDF/CSV. |
| `selftests.js` | Pruebas internas que alimentan el indicador `Pruebas: OK`. |
| `main.js` | Estado, carga de datos, cliente del worker e inicialización. |
| `server.js` | Proxy opcional de cuotas alternativas (Express). |

El orden de carga importa y está fijado en `index.html`:

```html
config.js → utils.js → model.js → api.js → store.js → ui.js → selftests.js → main.js
```

Son scripts clásicos (no módulos ES) compartiendo el ámbito global, para que los
`onclick` inline y las funciones entre archivos sigan funcionando igual.

## Cómo correrlo

Requiere servir por HTTP (el Web Worker no funciona con `file://`).

```bash
cd "lords-predictions - v3"

# Opción A: servidor estático simple (puerto 8765)
npx serve -l 8765 .
# o
python -m http.server 8765

# Abrir http://127.0.0.1:8765/index.html
```

### Proxy de cuotas (opcional)

```bash
npm install
cp .env.example .env        # pon tu ODDS_API_KEY
npm start                   # http://localhost:8787
```

La clave `ODDS_API_KEY` vive **solo** en el servidor. Si sirves el frontend en
otro puerto/origen, define antes de cargar los scripts:

```html
<script>window.LORDS_ODDS_BASE_URL = "http://localhost:8787";</script>
```

Sin proxy, el badge de cuotas alternativas mostrará un 404 en consola; el resto
de la app (ESPN + modelo) funciona igual.

## Rendimiento y cambios de esta versión

- **Monte Carlo en Web Worker** (`worker.js`): la UI ya no se congela durante la
  simulación. Si el worker falla (por ejemplo, sin soporte o bloqueado), `main.js`
  cae al hilo principal ejecutando exactamente la misma función `simulateGame`.
  Se prefirió ese fallback a una aproximación por CDF normal para no cambiar la
  semántica del modelo. Si el worker no responde en 15 s se reinicia y se usa el
  hilo principal, sin dejar la carga esperando.
- **Simulaciones por partido**: `MONTE_CARLO.sims` = 10.000 (NBA/NFL) y 9.000
  (MLB), antes 18.000–22.000. Los campos deterministas (margen esperado, spread
  justo, edge, pick, línea) son idénticos; las probabilidades Monte Carlo pueden
  variar ~1% por error de muestreo.
- **Concurrencia de enriquecimiento**: máximo 6 peticiones simultáneas
  (`createConcurrencyLimiter`/`mapWithConcurrency`), antes sin límite.
- **Presupuesto de enriquecimiento**: si ESPN tarda más de 10 s en total, la app
  renderiza con el modelo base en vez de seguir esperando.
- **Cancelación de red**: cada `loadGames` aborta la carga anterior con
  `AbortController`; las respuestas obsoletas se descartan por `state.requestId`.
  Un watchdog de 30 s corta cualquier carga que se quede colgada y muestra la
  caché o un aviso, nunca un spinner infinito.
- **Cuotas alternativas sin backend**: el fetch a `/api/odds` tiene timeout de
  4 s y se ignora si da 404. La app carga los partidos de ESPN igualmente y
  muestra un chip discreto `Cuotas alt.: sin backend`.
- **Constantes extraídas** a `config.js` (`TOTAL_BASE`, `TOTAL_SD`,
  `TOTAL_MVP_PRICE`, límites de parlays, etc.).

La lógica de negocio (Kelly, edges, no-vig, parlays, bankroll, props y totales)
no se modificó.

## Totales (Over/Under) informativos

Cada partido expone `totalLine` (desde `market.total`, o `null` si falta) y el
Monte Carlo calcula `overProb`/`underProb` excluyendo empujes, con
`overEV`/`underEV` a cuota de referencia -110. La tarjeta detallada muestra el
bloque **Totales O/U** y, sobre el listado, el panel **Mejores Totales del día**
con el mejor Over y el mejor Under por EV. Es solo informativo: no modifica
`qualified`, picks oficiales, bankroll, parlays ni props, y no genera PLAY.

## Team Totals manuales

En la tarjeta detallada de cada partido hay un bloque **Team Totals (manual)**
para local y visitante. La línea y las cuotas se introducen a mano; la app no
las lee de ESPN. Con esas entradas se calculan probabilidades Over/Under
empíricas usando las muestras de puntaje por equipo del Monte Carlo (los
empujes se excluyen) y el EV se calcula solo si hay una cuota americana válida
(±100 a ±1000).

Estructura por partido:

```js
game.teamTotals = {
  home: { line, priceOver, priceUnder },
  away: { line, priceOver, priceUnder },
  homeProbOver, homeProbUnder, homeEVOver, homeEVUnder,
  awayProbOver, awayProbUnder, awayEVOver, awayEVUnder
};
```

Las entradas manuales se guardan en `localStorage` (`lords_team_totals_v1`) y se
reaplican al refrescar o recargar, sin volver a simular. Las muestras por equipo
se guardan reducidas (`TEAM_TOTAL_SAMPLES`) junto al partido en caché. Este
módulo es informativo: no altera picks, spreads ATS, parlays, props ni historial.

## Cuaderno de apuestas diario

Registro **manual** de las apuestas que realmente se juegan (ATS, totales, props,
parlays u otros), separado por completo de `state.officialPicks`. Vive en
`state.betJournal` y se guarda en `localStorage` (`lords_bet_journal_v1`). No
alimenta al modelo ni cambia spreads, totales, props, parlays, bankroll o
historial.

```js
{
  id, dateKey, sportId, type, description, stake, price,
  result, units, sourceId, createdAt
}
```

Entradas:

- Botón **+ Añadir al cuaderno** en la tarjeta detallada de cada partido
  (descripción, stake y cuota mediante prompts).
- **+Cuaderno** por fila en las tablas de props y parlays.
- **+ Apuesta manual** en la pestaña **CUADERNO**.

Liquidación:

- Los ATS enlazados a un partido (`sourceId`) se liquidan solos cuando el
  partido está finalizado: el lado se deduce de la descripción (abreviatura
  local/visitante) o, si falta, de `recommendedTeam`, y el spread de la
  descripción (`±número`) o de `recommendedSpread`.
- Props, parlays y el resto se liquidan a mano con el selector de resultado de
  la tabla (WIN/LOSS/PUSH/PENDING); las unidades se recalculan con
  `calculateBetUnits`.

La pestaña **CUADERNO** muestra el resumen del día (`bets`, `W-L-P`, unidades y
ROI por apuesta) y la tabla de apuestas de `state.dateKey`, con opción de
eliminar cada entrada.

## Verificación rápida

1. Abrir la app en el navegador: debe aparecer `Pruebas: OK`.
2. `state.workerActive === true` en consola indica que la simulación corrió en el
   worker.
3. Cambiar entre NBA/MLB/NFL y comprobar que las tarjetas, totales y parlays se
   renderizan.
4. Añadir una apuesta desde una tarjeta y comprobar que aparece en **CUADERNO**
   tras recargar (persistencia en `lords_bet_journal_v1`).
