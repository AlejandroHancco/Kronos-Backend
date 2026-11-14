import { BadRequestException } from '@nestjs/common';
import { parseLaasId, toLaasId } from './laas-ids';

const DEVICE = '3f2b8c1e-9d4a-4b6e-8f10-2a3b4c5d6e7f';

describe('LaaS ids <deviceId>:<catalogId>', () => {
  it('toLaasId / parseLaasId son inversos; se parte en el PRIMER ":" (los ids de catálogo llevan "-")', () => {
    const id = toLaasId(DEVICE, 'kronos-mux-16-channel');
    expect(id).toBe(`${DEVICE}:kronos-mux-16-channel`);
    expect(parseLaasId(id)).toEqual({ deviceId: DEVICE, catalogId: 'kronos-mux-16-channel' });
    expect(parseLaasId(`${DEVICE}:a:b`)).toEqual({ deviceId: DEVICE, catalogId: 'a:b' });
  });

  it.each(['', 'sin-separador', `${DEVICE}:`, ':hioki-im3570-lcr', 'no-uuid:hioki-im3570-lcr', `${DEVICE}x:hioki`])(
    '400 "Identificador LaaS inválido" para %p',
    (id) => {
      expect(() => parseLaasId(id)).toThrow(new BadRequestException('Identificador LaaS inválido'));
    },
  );
});
