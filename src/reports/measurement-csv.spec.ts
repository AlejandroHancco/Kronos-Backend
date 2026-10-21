import {
  buildCsv, csvPreamble, rowsToCsvLines, csvHeader, measurementToRows, CsvMeasurement, unitSlug, valueColumnsFor,
  xColumnOf, blockKeyOf,
} from './measurement-csv';
import { parseSensorValues } from '../measurements/measurement-data';
import type { AcquisitionSnapshot } from '../device-plugins/core/acquisition';

const FREQUENCY_SWEEP: AcquisitionSnapshot = { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } };

const channel = (n: number, alias = `Canal ${n}`) => ({
  channelNumber: n, channelAlias: alias, concreteMix: 0.45, hasEmulsifier: false,
  sampleAge: 7, temperature: 22.5, humidity: 60, notes: 'ok',
});

const base: CsvMeasurement = {
  id: 32,
  takenAt: new Date('2026-10-12T14:03:00Z'),
  takenByName: 'Alejandro Hancco',
  presetName: 'Default',
  watcherStatus: 'correct',
  acquisition: FREQUENCY_SWEEP,
  data: [
    { x: 1000, values: { g: [0.1, 0.2, 0, 0], b: [0.01, 0.02, 0, 0] } },
    { x: 2000, values: { g: [0.3, 0.4, 0, 0], b: [0.03, 0.04, 0, 0] } },
  ],
  sensorValues: [{ name: 'g', unit: 'S' }, { name: 'b', unit: 'S' }],
  channels: [channel(2), channel(1)],
};

const cols = valueColumnsFor(parseSensorValues(base.sensorValues));
const CSV_HEADER = csvHeader(cols, xColumnOf(FREQUENCY_SWEEP));

describe('measurementToRows', () => {
  it('una fila por (frecuencia, canal medido), canales ordenados', () => {
    const rows = measurementToRows(base, cols);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual([
      32, '2026-10-12T14:03:00.000Z', 'Alejandro Hancco', 'Default', 'correct',
      1000, 1, 'Canal 1', 0.1, 0.01, 0.45, false, 7, 22.5, 60, 'ok',
    ]);
    expect(rows[1][6]).toBe(2);
    expect(rows[1][8]).toBe(0.2);
    expect(rows[2][5]).toBe(2000);
  });

  it('cada fila tiene tantas columnas como el encabezado', () => {
    for (const row of measurementToRows(base, cols)) expect(row).toHaveLength(CSV_HEADER.length);
  });

  it('sin filas si data está vacío o no es array', () => {
    expect(measurementToRows({ ...base, data: [] }, cols)).toEqual([]);
    expect(measurementToRows({ ...base, data: null }, cols)).toEqual([]);
  });

  it('barrido con variable declarada (voltage, V) → columna voltage_v', () => {
    const voltage: AcquisitionSnapshot = { kind: 'sweep', variable: { name: 'voltage', unit: 'V', label: 'Voltaje' } };
    const m: CsvMeasurement = { ...base, acquisition: voltage };
    expect(xColumnOf(voltage)).toBe('voltage_v');
    expect(csvHeader(cols, xColumnOf(voltage))).toContain('voltage_v');
    const rows = measurementToRows(m, cols);
    expect(rows[0][5]).toBe(1000); // sigue siendo la celda de x, aunque la columna se llame distinto
  });

  it('medición puntual (single): sin columna de x, una fila por canal', () => {
    const single: CsvMeasurement = {
      ...base,
      acquisition: { kind: 'single' },
      data: [{ values: { g: [0.1, 0.2], b: [0.01, 0.02] } }],
      channels: [channel(1), channel(2)],
    };
    expect(xColumnOf({ kind: 'single' })).toBeNull();
    const header = csvHeader(cols, xColumnOf({ kind: 'single' }));
    expect(header).not.toContain('frequency_hz');
    const rows = measurementToRows(single, cols);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(header.length);
    // taken_at sigue presente, pero no hay celda de x.
    expect(rows[0][1]).toBe('2026-10-12T14:03:00.000Z');
    expect(rows[0]).toEqual([32, '2026-10-12T14:03:00.000Z', 'Alejandro Hancco', 'Default', 'correct', 1, 'Canal 1', 0.1, 0.01, 0.45, false, 7, 22.5, 60, 'ok']);
  });

  it('medición sin acquisition (formato previo a la migración) se trata como barrido en frecuencia', () => {
    const legacy: CsvMeasurement = { ...base, acquisition: undefined };
    expect(measurementToRows(legacy, cols)).toEqual(measurementToRows(base, cols));
  });
});

describe('csvHeader', () => {
  it('frequency_hz queda en la misma posición que hoy (después de watcher_status)', () => {
    const idx = CSV_HEADER.indexOf('frequency_hz');
    expect(idx).toBe(CSV_HEADER.indexOf('watcher_status') + 1);
  });
});

describe('buildCsv', () => {
  it('BOM, metadatos con #, encabezado y filas con CRLF', () => {
    const csv = buildCsv(['Kronos | Tarea: Viga A'], [base]);
    expect(csv.startsWith('﻿# Kronos | Tarea: Viga A\r\n')).toBe(true);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines[1]).toBe(CSV_HEADER.join(','));
    expect(lines).toHaveLength(2 + 4);
  });

  it('protege nombres que parecen fórmulas', () => {
    const csv = buildCsv([], [{ ...base, presetName: '=HACK()' }]);
    expect(csv).toContain(",'=HACK(),");
  });

  it('cita una nota de canal que contiene comas', () => {
    const withComma: CsvMeasurement = {
      ...base,
      channels: [{ ...channel(1), notes: 'ok, revisar' }],
      data: [{ x: 1000, values: { g: [0.1], b: [0.01] } }],
    };
    const csv = buildCsv([], [withComma]);
    expect(csv).toContain('"ok, revisar"');
  });

  it('protege metadatos con nombres de tarea/proyecto maliciosos (CSV injection)', () => {
    // Un nombre de tarea con coma + fórmula no debe "partirse" en columnas evaluables por Excel.
    const maliciousLine = 'Kronos | Tarea: Viga,=HYPERLINK("http://evil","x")';
    const csv = buildCsv([maliciousLine], [base]);
    const firstLine = csv.replace('﻿', '').split('\r\n')[0];
    // Una sola celda citada: sin comas "sueltas" fuera de las comillas.
    expect(firstLine.startsWith('"#')).toBe(true);
    expect(firstLine.endsWith('"')).toBe(true);
    expect(firstLine).toContain('""http://evil""');
  });

  it('un bloque por adquisición consecutiva: [sweep A, sweep B, single C, sweep D]', () => {
    const sweepA: CsvMeasurement = { ...base, id: 1 };
    const sweepB: CsvMeasurement = { ...base, id: 2, data: [{ x: 3000, values: { g: [0.5, 0, 0, 0], b: [0.05, 0, 0, 0] } }], channels: [channel(1)] };
    const single: CsvMeasurement = {
      ...base, id: 3, acquisition: { kind: 'single' },
      data: [{ values: { g: [0.9, 0, 0, 0], b: [0.09, 0, 0, 0] } }], channels: [channel(1)],
    };
    const sweepD: CsvMeasurement = { ...base, id: 4, data: [{ x: 4000, values: { g: [0.7, 0, 0, 0], b: [0.07, 0, 0, 0] } }], channels: [channel(1)] };

    const csv = buildCsv(['Kronos | Tarea: Viga A'], [sweepA, sweepB, single, sweepD]);
    const lines = csv.replace('﻿', '').split('\r\n');

    const sweepHeader = csvHeader(cols, xColumnOf(FREQUENCY_SWEEP)).join(',');
    const singleHeader = csvHeader(cols, null).join(',');

    // preámbulo (1) + header sweep (1) + filas A (4) + filas B (1) + header single (1) + filas C (1) + header sweep (1) + filas D (1)
    expect(lines[0]).toBe('# Kronos | Tarea: Viga A');
    expect(lines[1]).toBe(sweepHeader);
    expect(lines.slice(2, 6)).toHaveLength(4); // filas A
    expect(lines[6].startsWith('2,')).toBe(true); // fila B, measurement_id 2
    expect(lines[7]).toBe(singleHeader);
    expect(lines[8].startsWith('3,')).toBe(true); // fila C, measurement_id 3
    expect(lines[9]).toBe(sweepHeader);
    expect(lines[10].startsWith('4,')).toBe(true); // fila D, measurement_id 4
    expect(lines).toHaveLength(11);
  });
});

describe('csvPreamble / rowsToCsvLines', () => {
  it('csvPreamble: BOM y metadatos citados (sin encabezado)', () => {
    const preamble = csvPreamble(['Kronos | Tarea: Viga A']);
    expect(preamble).toBe('﻿# Kronos | Tarea: Viga A');
  });

  it('csvPreamble cita metadatos con coma y fórmula como una sola celda', () => {
    const preamble = csvPreamble(['Tarea: Viga,=HACK()']);
    const [firstLine] = preamble.replace('﻿', '').split('\r\n');
    expect(firstLine.startsWith('"#')).toBe(true);
    expect(firstLine.endsWith('"')).toBe(true);
  });

  it('rowsToCsvLines: una línea por fila, igual que buildCsv sin preámbulo ni encabezado', () => {
    const lines = rowsToCsvLines(base, cols);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      '32,2026-10-12T14:03:00.000Z,Alejandro Hancco,Default,correct,1000,1,Canal 1,0.1,0.01,0.45,false,7,22.5,60,ok',
    );
  });

  it('rowsToCsvLines vacío cuando no hay data', () => {
    expect(rowsToCsvLines({ ...base, data: [] }, cols)).toEqual([]);
  });
});

describe('columnas dinámicas', () => {
  const sim: CsvMeasurement = { ...base, id: 40, sensorValues: [{ name: 'z', unit: 'Ω' }],
    data: [{ x: 1000, values: { z: [1500] } }], channels: [channel(1)] };

  it('unitSlug y nombre de columna', () => {
    expect(['S', 'Ω', 'kΩ', '°', ''].map(unitSlug)).toEqual(['s', 'ohm', 'kohm', 'deg', '']);
    expect(valueColumnsFor([{ name: 'z', unit: 'Ω' }, { name: 'n', unit: '' }]).map((c) => c.column)).toEqual(['z_ohm', 'n']);
  });

  it('buildCsv une columnas de dispositivos distintos y deja vacías las no declaradas', () => {
    const lines = buildCsv([], [base, sim]).replace('﻿', '').split('\r\n');
    // Sin metaLines, la primera línea (preámbulo) queda vacía; el encabezado es la siguiente.
    expect(lines[1]).toBe('measurement_id,taken_at,taken_by,preset,watcher_status,frequency_hz,channel,channel_alias,g_s,b_s,z_ohm,concrete_mix,has_emulsifier,sample_age,temperature,humidity,notes');
    expect(lines[2]).toContain(',Canal 1,0.1,0.01,,0.45,');
    expect(lines.at(-1)).toContain(',Canal 1,,,1500,0.45,');
  });

  it('el formato legado ({frequency, g, b}) no produce filas', () => {
    const legacy = { ...base, data: [{ frequency: 1000, g: [0.1], b: [0.01] }] }; // legado
    expect(measurementToRows(legacy, valueColumnsFor([{ name: 'g', unit: 'S' }]))).toEqual([]);
  });
});

describe('blockKeyOf', () => {
  it('distingue sweep de single y sweeps por variable', () => {
    expect(blockKeyOf({ kind: 'single' })).toBe('single');
    expect(blockKeyOf(FREQUENCY_SWEEP)).toBe('sweep:frequency:Hz');
    expect(blockKeyOf({ kind: 'sweep', variable: { name: 'voltage', unit: 'V', label: 'Voltaje' } })).toBe('sweep:voltage:V');
  });
});
