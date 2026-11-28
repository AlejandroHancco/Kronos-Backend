import {
  SeriesWindow,
  firstOverlap,
  nextReservationStart,
  reservationNear,
  occurrenceStart,
  reservedSecondsFor,
  selfOverlaps,
  suggestStart,
} from './series';

const MIN = 60_000;
const t0 = new Date('2026-11-27T23:30:00.000Z');

function series(over: Partial<SeriesWindow> = {}): SeriesWindow {
  return { seriesStartAt: t0, intervalMinutes: 30, firstIndex: 1, lastIndex: 10, reservedSeconds: 600, ...over };
}

describe('occurrenceStart', () => {
  it('espaciado exacto en ms, cruzando la medianoche UTC', () => {
    const s = { seriesStartAt: t0, intervalMinutes: 30 };
    expect(occurrenceStart(s, 1).getTime()).toBe(t0.getTime());
    expect(occurrenceStart(s, 2).toISOString()).toBe('2026-11-28T00:00:00.000Z');
    expect(occurrenceStart(s, 3).toISOString()).toBe('2026-11-28T00:30:00.000Z');
    expect(occurrenceStart(s, 1345).getTime() - t0.getTime()).toBe(1344 * 30 * MIN);
  });
  it('serie única (intervalMinutes null) devuelve el inicio', () => {
    expect(occurrenceStart({ seriesStartAt: t0, intervalMinutes: null }, 1).getTime()).toBe(t0.getTime());
  });
});

describe('firstOverlap', () => {
  it('dos series de 30 min sin desfase chocan en la primera ocurrencia', () => {
    const r = firstOverlap(series(), series());
    expect(r).toEqual({ aIndex: 1, bIndex: 1, at: t0 });
  });
  it('desfase de 15 min con reservedSeconds 600: sin solapamiento', () => {
    const b = series({ seriesStartAt: new Date(t0.getTime() + 15 * MIN) });
    expect(firstOverlap(series(), b)).toBeNull();
    expect(firstOverlap(b, series())).toBeNull();
  });
  it('extremos que se tocan no se solapan (intervalo semiabierto)', () => {
    const a = series({ intervalMinutes: null, firstIndex: 1, lastIndex: 1 });
    const b = series({ intervalMinutes: null, seriesStartAt: new Date(t0.getTime() + 600_000), firstIndex: 1, lastIndex: 1 });
    expect(firstOverlap(a, b)).toBeNull();
    const c = { ...b, seriesStartAt: new Date(t0.getTime() + 599_999) };
    expect(firstOverlap(a, c)).toEqual({ aIndex: 1, bIndex: 1, at: c.seriesStartAt });
  });
  it('encuentra el primer par en colisión respetando firstIndex/lastIndex', () => {
    // a cada 30 min desde t0; b cada 60 min desde t0+5min, solo índices 4..6
    const a = series({ firstIndex: 3, lastIndex: 20 });
    const b = series({ seriesStartAt: new Date(t0.getTime() + 5 * MIN), intervalMinutes: 60, firstIndex: 4, lastIndex: 6 });
    // b4 = t0+185min; a7 = t0+180min, a7 ocupa hasta +190 -> choca
    const r = firstOverlap(a, b);
    expect(r).toEqual({ aIndex: 7, bIndex: 4, at: new Date(t0.getTime() + 185 * MIN) });
    expect(firstOverlap(b, a)).toEqual({ aIndex: 4, bIndex: 7, at: new Date(t0.getTime() + 185 * MIN) });
  });
  it('serie única contra serie periódica', () => {
    const one = series({ intervalMinutes: null, seriesStartAt: new Date(t0.getTime() + 95 * MIN), firstIndex: 1, lastIndex: 1 });
    expect(firstOverlap(one, series())).toEqual({ aIndex: 1, bIndex: 4, at: new Date(t0.getTime() + 95 * MIN) });
    expect(firstOverlap(series(), one)).toEqual({ aIndex: 4, bIndex: 1, at: new Date(t0.getTime() + 95 * MIN) });
    const far = { ...one, seriesStartAt: new Date(t0.getTime() + 10 * 24 * 60 * MIN) };
    expect(firstOverlap(far, series())).toBeNull();
  });
  it('dos series de 28 días cada 30 min (1344 ocurrencias) en < 50 ms', () => {
    const a = series({ firstIndex: 1, lastIndex: 1344 });
    const b = series({ seriesStartAt: new Date(t0.getTime() + 15 * MIN), firstIndex: 1, lastIndex: 1344 });
    const last = series({ seriesStartAt: new Date(t0.getTime() + 15 * MIN), firstIndex: 1344, lastIndex: 1344, intervalMinutes: 30 });
    const started = performance.now();
    expect(firstOverlap(a, b)).toBeNull();
    const c = { ...b, seriesStartAt: new Date(t0.getTime() + 25 * MIN) };
    expect(firstOverlap(a, c)).toEqual({ aIndex: 2, bIndex: 1, at: new Date(t0.getTime() + 30 * MIN) });
    expect(firstOverlap(a, { ...last, seriesStartAt: t0 })).toEqual({ aIndex: 1344, bIndex: 1344, at: occurrenceStart(a, 1344) });
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('selfOverlaps', () => {
  it('intervalo 5 min con reservedSeconds 600 se solapa consigo misma', () => {
    expect(selfOverlaps(series({ intervalMinutes: 5, reservedSeconds: 600 }))).toBe(true);
  });
  it('intervalo igual a la reserva no se solapa; una sola ocurrencia tampoco', () => {
    expect(selfOverlaps(series({ intervalMinutes: 10, reservedSeconds: 600 }))).toBe(false);
    expect(selfOverlaps(series({ intervalMinutes: 5, firstIndex: 3, lastIndex: 3 }))).toBe(false);
    expect(selfOverlaps(series({ intervalMinutes: null, firstIndex: 1, lastIndex: 1 }))).toBe(false);
  });
});

describe('nextReservationStart', () => {
  it('menor inicio estrictamente posterior a after entre todas las series', () => {
    const a = series({ firstIndex: 3, lastIndex: 5 }); // t0+60, +90, +120
    const b = series({ seriesStartAt: new Date(t0.getTime() + 70 * MIN), intervalMinutes: null, firstIndex: 1, lastIndex: 1 });
    expect(nextReservationStart([a, b], t0)).toEqual(new Date(t0.getTime() + 60 * MIN));
    expect(nextReservationStart([a, b], new Date(t0.getTime() + 60 * MIN))).toEqual(new Date(t0.getTime() + 70 * MIN));
    expect(nextReservationStart([a, b], new Date(t0.getTime() + 90 * MIN))).toEqual(new Date(t0.getTime() + 120 * MIN));
    expect(nextReservationStart([a, b], new Date(t0.getTime() + 120 * MIN))).toBeNull();
    expect(nextReservationStart([], t0)).toBeNull();
  });
});

describe('reservationNear', () => {
  const ten = series({ intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 600 }); // [t0, t0+10min)
  it('devuelve el inicio de una ocurrencia en curso o que empieza dentro del margen', () => {
    expect(reservationNear([ten], new Date(t0.getTime() + 5 * MIN), 120)).toEqual(t0); // en curso
    expect(reservationNear([ten], new Date(t0.getTime() - 2 * MIN), 120)).toEqual(t0); // empieza justo en 2 min
    expect(reservationNear([ten], new Date(t0.getTime() - 3 * MIN), 120)).toBeNull();
    expect(reservationNear([ten], new Date(t0.getTime() + 10 * MIN), 120)).toBeNull(); // ya terminó
    expect(reservationNear([], t0, 120)).toBeNull();
  });
  it('en una serie periódica encuentra la ocurrencia correcta', () => {
    const s = series({ reservedSeconds: 600 }); // cada 30 min desde t0
    expect(reservationNear([s], new Date(t0.getTime() + 62 * MIN), 120)).toEqual(new Date(t0.getTime() + 60 * MIN));
    expect(reservationNear([s], new Date(t0.getTime() + 45 * MIN), 120)).toBeNull();
    expect(reservationNear([s], new Date(t0.getTime() + 29 * MIN), 120)).toEqual(new Date(t0.getTime() + 30 * MIN));
  });
});

describe('reservedSecondsFor', () => {
  it('ceil(max × 1.2), al menos estimación + 60', () => {
    expect(reservedSecondsFor(100, [])).toBe(160);
    expect(reservedSecondsFor(100, [150])).toBe(180);
    expect(reservedSecondsFor(600, [])).toBe(720);
    expect(reservedSecondsFor(10, [101])).toBe(122); // 121.2 -> 122
  });
});

describe('suggestStart', () => {
  const candidate = { intervalMinutes: 30, firstIndex: 1, lastIndex: 10, reservedSeconds: 600 };
  it('sin otras series devuelve from', () => {
    expect(suggestStart(candidate, [], t0)).toEqual(t0);
  });
  it('devuelve el primer minuto libre de solapamiento', () => {
    const other = series(); // ocupa [t0+30k, t0+30k+10min)
    expect(suggestStart(candidate, [other], t0)).toEqual(new Date(t0.getTime() + 10 * MIN));
    expect(suggestStart(candidate, [other], new Date(t0.getTime() + 2 * MIN), 5)).toEqual(new Date(t0.getTime() + 12 * MIN));
  });
  it('null si no cabe dentro del horizonte', () => {
    const blocker = series({ intervalMinutes: 10, lastIndex: 1000 }); // ocupa todo
    expect(suggestStart(candidate, [blocker], t0)).toBeNull();
    expect(suggestStart({ ...candidate, intervalMinutes: 5 }, [], t0)).toBeNull(); // se solapa consigo misma
  });
  it('null si el hueco aparece después del horizonte', () => {
    const one = { intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 600 };
    const blocker = series({ intervalMinutes: 10, lastIndex: 6 * 3 }); // ocupa 3 h
    expect(suggestStart(one, [blocker], t0, 1, 2)).toBeNull();
    expect(suggestStart(one, [blocker], t0, 1, 4)).toEqual(new Date(t0.getTime() + 180 * MIN));
  });
});

describe('firstOverlap contra fuerza bruta', () => {
  function brute(a: SeriesWindow, b: SeriesWindow) {
    const idx = (s: SeriesWindow) =>
      s.intervalMinutes == null ? [s.firstIndex] : Array.from({ length: Math.max(0, s.lastIndex - s.firstIndex + 1) }, (_, k) => s.firstIndex + k);
    let best: { aIndex: number; bIndex: number; at: Date } | null = null;
    for (const i of idx(a)) {
      const sa = occurrenceStart(a, i).getTime();
      for (const j of idx(b)) {
        const sb = occurrenceStart(b, j).getTime();
        if (sa < sb + b.reservedSeconds * 1000 && sb < sa + a.reservedSeconds * 1000) {
          const at = Math.max(sa, sb);
          if (!best || at < best.at.getTime()) best = { aIndex: i, bIndex: j, at: new Date(at) };
        }
      }
    }
    return best;
  }
  it('coincide en el instante del primer solapamiento para series pseudoaleatorias', () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let iter = 0; iter < 2000; iter++) {
      const mk = (): SeriesWindow => {
        const first = 1 + rnd(5);
        const oneShot = rnd(5) === 0;
        return {
          seriesStartAt: new Date(t0.getTime() + rnd(600) * MIN + rnd(60) * 1000),
          intervalMinutes: oneShot ? null : 1 + rnd(90),
          firstIndex: first,
          lastIndex: oneShot ? first : first + rnd(15),
          reservedSeconds: 1 + rnd(3600),
        };
      };
      const a = mk();
      const b = mk();
      const expected = brute(a, b);
      const got = firstOverlap(a, b);
      expect(got?.at ?? null).toEqual(expected?.at ?? null);
      if (got) {
        const sa = occurrenceStart(a, got.aIndex).getTime();
        const sb = occurrenceStart(b, got.bIndex).getTime();
        expect(sa < sb + b.reservedSeconds * 1000 && sb < sa + a.reservedSeconds * 1000).toBe(true);
      }
    }
  });
});

describe('suggestStart con salto (jump-ahead) contra búsqueda ingenua', () => {
  /** La búsqueda original: probar cada paso de stepMinutes hasta el horizonte. */
  function naive(
    candidate: Omit<SeriesWindow, 'seriesStartAt'>,
    others: SeriesWindow[],
    from: Date,
    stepMinutes: number,
    horizonHours: number,
  ): Date | null {
    if (selfOverlaps({ ...candidate, seriesStartAt: from })) return null;
    const steps = Math.floor((horizonHours * 60) / stepMinutes);
    for (let i = 0; i <= steps; i++) {
      const seriesStartAt = new Date(from.getTime() + i * stepMinutes * MIN);
      if (others.every((o) => firstOverlap({ ...candidate, seriesStartAt }, o) === null)) return seriesStartAt;
    }
    return null;
  }

  it('devuelve el mismo resultado en una muestra pseudoaleatoria', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    let found = 0;
    for (let iter = 0; iter < 400; iter++) {
      const mk = (): SeriesWindow => {
        const first = 1 + rnd(3);
        const oneShot = rnd(4) === 0;
        const intervalMinutes = oneShot ? null : 10 + rnd(80);
        return {
          seriesStartAt: new Date(t0.getTime() + rnd(300) * MIN + rnd(60) * 1000),
          intervalMinutes,
          firstIndex: first,
          lastIndex: oneShot ? first : first + rnd(12),
          reservedSeconds: 60 + rnd(intervalMinutes ? intervalMinutes * 60 - 59 : 3000),
        };
      };
      const others = Array.from({ length: 1 + rnd(4) }, mk);
      const c = mk();
      const { seriesStartAt: from, ...candidate } = c;
      const step = [1, 1, 5, 7][rnd(4)];
      const horizon = 1 + rnd(12);
      const expected = naive(candidate, others, from, step, horizon);
      if (expected) found++;
      expect(suggestStart(candidate, others, from, step, horizon)).toEqual(expected);
    }
    expect(found).toBeGreaterThan(50); // la muestra ejercita tanto huecos como horizontes agotados
  });
});
