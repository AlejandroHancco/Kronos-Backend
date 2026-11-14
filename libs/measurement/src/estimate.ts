// ── Modelo ADITIVO de duración ────────────────────────────────────────────────
// total = canales × [ T_MUX + Σ_rangos (T_SETUP + puntos × T_PUNTO) ]
// Cada canal repite todos los rangos (así mide measureTask), por eso es aditivo:
// más canales o más rangos ⇒ más tiempo, linealmente.
const MUX_SWITCH_SECONDS = 1.5; // cambio de canal en el MUX (HTTP + asentamiento)
const RANGE_SETUP_SECONDS = 1; // comandos SCPI de setup por rango (6 × 100ms + margen)
const SECONDS_PER_POINT = 0.01; // barrido: ~8s para 801 puntos

/** Estimación aditiva: canales × (mux + Σ rangos(setup + puntos·t)) */
export function estimateSeconds(ranges: { points: number }[], channelCount: number): number {
  const perChannel =
    MUX_SWITCH_SECONDS +
    ranges.reduce((sum, r) => sum + RANGE_SETUP_SECONDS + r.points * SECONDS_PER_POINT, 0);
  return Math.ceil(channelCount * perChannel);
}
