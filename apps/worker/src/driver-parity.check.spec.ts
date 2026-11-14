import { DriverParityCheck } from './driver-parity.check';

describe('DriverParityCheck', () => {
  it('delega en DeviceDriverRegistry.assertParity con el catálogo', () => {
    const drivers = { assertParity: jest.fn() };
    const catalog = {} as any;
    new DriverParityCheck(drivers as any, catalog).run();
    expect(drivers.assertParity).toHaveBeenCalledWith(catalog);
  });

  it('propaga el error que nombra el modelo', () => {
    const drivers = { assertParity: jest.fn(() => { throw new Error('Plugin "kronos-mux-16": sin driver'); }) };
    expect(() => new DriverParityCheck(drivers as any, {} as any).run()).toThrow('kronos-mux-16');
  });

  it('no se ejecuta solo al inicializar el módulo (lo hace main.ts antes de listen)', () => {
    expect((DriverParityCheck.prototype as any).onModuleInit).toBeUndefined();
  });
});
