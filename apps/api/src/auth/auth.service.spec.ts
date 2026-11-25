import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService.changePassword', () => {
  const prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
  const jwtService = { sign: jest.fn().mockReturnValue('tok') };
  const sessionEvents = { revokeUserSessions: jest.fn() };
  const service = new AuthService(prisma as any, jwtService as any, {} as any, sessionEvents as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('rechaza cuentas sin contraseña local (Google)', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', password: null });
    await expect(service.changePassword('u', 'x', 'nuevaClave1')).rejects.toThrow(
      'Tu cuenta usa Google; no tiene contraseña local',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessionEvents.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('rechaza la contraseña actual incorrecta', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', password: await bcrypt.hash('correcta1', 4) });
    await expect(service.changePassword('u', 'incorrecta', 'nuevaClave1')).rejects.toThrow(
      'La contraseña actual es incorrecta',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rechaza una nueva contraseña igual a la actual', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', password: await bcrypt.hash('correcta1', 4) });
    await expect(service.changePassword('u', 'correcta1', 'correcta1')).rejects.toThrow(
      'La nueva contraseña debe ser distinta de la actual',
    );
  });

  it('guarda el hash de la nueva contraseña, marca passwordChangedAt y reemite un token', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', name: 'U', password: await bcrypt.hash('correcta1', 4) });
    prisma.user.update.mockResolvedValue({});
    const result = await service.changePassword('u', 'correcta1', 'nuevaClave1');
    expect(result).toEqual({ ok: true, access_token: 'tok' });
    const call = prisma.user.update.mock.calls[0][0];
    expect(call.where).toEqual({ uuid: 'u' });
    expect(await bcrypt.compare('nuevaClave1', call.data.password)).toBe(true);
    expect(call.data.passwordChangedAt).toBeInstanceOf(Date);
  });

  it('desconecta los sockets del usuario tras cambiar la contraseña', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', name: 'U', password: await bcrypt.hash('correcta1', 4) });
    prisma.user.update.mockResolvedValue({});
    await service.changePassword('u', 'correcta1', 'nuevaClave1');
    expect(sessionEvents.revokeUserSessions).toHaveBeenCalledWith('u');
    expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(
      sessionEvents.revokeUserSessions.mock.invocationCallOrder[0],
    );
  });

  it('no desconecta sockets si la contraseña actual es incorrecta', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', password: await bcrypt.hash('correcta1', 4) });
    await expect(service.changePassword('u', 'mala', 'nuevaClave1')).rejects.toThrow();
    expect(sessionEvents.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('rechaza una nueva contraseña que supera 72 bytes UTF-8 aunque tenga pocos caracteres (tildes/ñ cuentan doble)', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', password: await bcrypt.hash('correcta1', 4) });
    const newPassword = 'ñ'.repeat(37); // 37 caracteres, 74 bytes UTF-8 (> 72)
    await expect(service.changePassword('u', 'correcta1', newPassword)).rejects.toThrow(
      'La nueva contraseña no puede superar 72 bytes (las letras con tilde o ñ cuentan doble)',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessionEvents.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('acepta una nueva contraseña de exactamente 72 bytes UTF-8', async () => {
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', name: 'U', password: await bcrypt.hash('correcta1', 4) });
    prisma.user.update.mockResolvedValue({});
    const newPassword = 'ñ'.repeat(36); // 36 caracteres, 72 bytes UTF-8 exactos
    expect(Buffer.byteLength(newPassword, 'utf8')).toBe(72);
    await expect(service.changePassword('u', 'correcta1', newPassword)).resolves.toEqual({
      ok: true, access_token: 'tok',
    });
  });
});

describe('AuthService.register', () => {
  const prisma = { user: { create: jest.fn() } };
  const jwtService = { sign: jest.fn().mockReturnValue('tok') };
  const verification = { issueAndSend: jest.fn() };
  const service = new AuthService(prisma as any, jwtService as any, {} as any, {} as any, verification as any);
  const created = { uuid: 'u1', email: 'a@b.com', name: 'Ana' };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.create.mockResolvedValue(created);
  });

  it('envía el correo de verificación y devuelve el JWT', async () => {
    verification.issueAndSend.mockResolvedValue(undefined);
    await expect(service.register('a@b.com', 'Ana', undefined, 'clave1234')).resolves.toEqual({ access_token: 'tok' });
    expect(verification.issueAndSend).toHaveBeenCalledWith(created);
  });

  it('devuelve el JWT aunque el envío falle', async () => {
    verification.issueAndSend.mockRejectedValue(new Error('brevo down'));
    await expect(service.register('a@b.com', 'Ana', undefined, 'clave1234')).resolves.toEqual({ access_token: 'tok' });
  });
});
