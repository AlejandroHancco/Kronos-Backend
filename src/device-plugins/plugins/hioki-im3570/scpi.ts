import type { MeasuredPoint, SweepParams } from '../../core/device-plugin.interface';

/** Puerto SCPI/TCP del Hioki IM3570 (fijo, como hasta ahora). */
export const HIOKI_SCPI_PORT = 3570;

/** Consulta que devuelve el barrido como CSV de tripletas freq,G,B terminado en \n. */
export const MEASURE_QUERY = ':MEASure?';

/** Comandos que se envían antes de cada barrido (modo analizador, G y B fijos porque Kronos declara g y b). */
export function sweepSetupCommands(s: SweepParams): string[] {
  return [
    ':MODE ANALyzer',
    ':SWEep:TRIGger SEQuential',
    `:LIST:STARt:STOP ${s.startFreq},${s.stopFreq},${s.points},${s.sweepType}`,
    ':PARameter1 G',
    ':PARameter3 B',
    '*TRG',
  ];
}

/** Parsea la respuesta CSV como tripletas [freq, g, b]; descarta tripletas con NaN o incompletas. */
export function parseGbResponse(csv: string): MeasuredPoint[] {
  const fields = csv.split(',');
  const points: MeasuredPoint[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const frequency = parseFloat(fields[i]);
    const g = parseFloat(fields[i + 1]);
    const b = parseFloat(fields[i + 2]);
    if (!isNaN(frequency) && !isNaN(g) && !isNaN(b)) points.push({ frequency, values: { g, b } });
  }
  return points;
}
