import { HIOKI_SCPI_PORT, MEASURE_QUERY, parseGbResponse, sweepSetupCommands } from './scpi';

describe('SCPI del Hioki IM3570', () => {
  it('comandos de setup idénticos a los actuales', () => {
    expect(sweepSetupCommands({ startFreq: 1000, stopFreq: 5000, points: 11, sweepType: 'LOG' })).toEqual([
      ':MODE ANALyzer', ':SWEep:TRIGger SEQuential', ':LIST:STARt:STOP 1000,5000,11,LOG', ':PARameter1 G', ':PARameter3 B', '*TRG',
    ]);
  });

  it('parsea tripletas freq,g,b e ignora NaN y tripletas incompletas', () => {
    expect(parseGbResponse('1000,1e-3,2e-4,2000,x,1,3000,5e-4')).toEqual([{ frequency: 1000, values: { g: 1e-3, b: 2e-4 } }]);
  });

  it('puerto y consulta de medición', () => {
    expect(HIOKI_SCPI_PORT).toBe(3570);
    expect(MEASURE_QUERY).toBe(':MEASure?');
  });
});
