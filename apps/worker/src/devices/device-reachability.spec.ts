import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import { DeviceReachability } from './device-reachability';

function setup(result: boolean | Error = true) {
  const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);
  const driver = {
    testConnection: jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
  const drivers = { has: jest.fn((t: string) => catalog.has(t)), get: jest.fn(() => driver) };
  return { reach: new DeviceReachability(catalog, drivers as any), driver, drivers };
}

describe('DeviceReachability.check', () => {
  it('delega en el driver con el puerto por defecto del catálogo', async () => {
    const { reach, driver } = setup(true);
    expect(await reach.check('hioki-im3570', '10.0.0.5')).toBe(true);
    expect(driver.testConnection).toHaveBeenCalledWith({ ip: '10.0.0.5', port: HIOKI_IM3570.description.connection.defaultPort });
  });

  it('respeta un puerto explícito', async () => {
    const { reach, driver } = setup(true);
    await reach.check('hioki-im3570', '10.0.0.5', 1234);
    expect(driver.testConnection).toHaveBeenCalledWith({ ip: '10.0.0.5', port: 1234 });
  });

  it('tipo desconocido o sin driver → false sin llamar a ningún driver', async () => {
    const { reach, drivers } = setup(true);
    expect(await reach.check('toaster', '10.0.0.9')).toBe(false);
    expect(await reach.check('', '10.0.0.9')).toBe(false);
    expect(drivers.get).not.toHaveBeenCalled();
  });

  it('tipo que requiere IP sin IP → false; tipo sin IP se chequea con ip null', async () => {
    const { reach, driver } = setup(true);
    expect(await reach.check('kronos-mux-16', null)).toBe(false);
    expect(driver.testConnection).not.toHaveBeenCalled();
    expect(await reach.check('sim-impedance', null)).toBe(true);
    expect(driver.testConnection).toHaveBeenCalledWith({ ip: null, port: undefined });
  });

  it('un error del driver cuenta como no alcanzable', async () => {
    const { reach } = setup(new Error('ECONNREFUSED'));
    expect(await reach.check('hioki-im3570', '10.0.0.5')).toBe(false);
  });
});
