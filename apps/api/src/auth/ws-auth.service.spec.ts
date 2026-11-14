import { UnauthorizedException } from '@nestjs/common';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { WsAuthService } from './ws-auth.service';

describe('WsAuthService.authenticate', () => {
  const jwtService = { verify: jest.fn() };
  const prisma = { user: { findUnique: jest.fn() } };
  const supabase = { validateToken: jest.fn() };
  const service = new WsAuthService(jwtService as any, prisma as any, supabase as any);

  beforeEach(() => jest.clearAllMocks());

  it('rechaza cuando no hay token', async () => {
    await expect(service.authenticate(undefined)).rejects.toThrow(UnauthorizedException);
    await expect(service.authenticate('')).rejects.toThrow(UnauthorizedException);
    expect(jwtService.verify).not.toHaveBeenCalled();
    expect(supabase.validateToken).not.toHaveBeenCalled();
  });

  it('acepta un JWT propio válido', async () => {
    jwtService.verify.mockReturnValue({ sub: 'u', iat: 100 });
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', email: 'a@a.com', passwordChangedAt: null });
    await expect(service.authenticate('tok')).resolves.toEqual({
      id: 'u',
      email: 'a@a.com',
      provider: 'jwt',
    });
    expect(jwtService.verify).toHaveBeenCalledWith('tok');
    expect(supabase.validateToken).not.toHaveBeenCalled();
  });

  it('rechaza un JWT emitido antes del cambio de contraseña (sin probar Supabase)', async () => {
    const changedAt = new Date('2026-01-01T00:00:10.000Z');
    jwtService.verify.mockReturnValue({ sub: 'u', iat: Math.floor(changedAt.getTime() / 1000) - 1 });
    prisma.user.findUnique.mockResolvedValue({ uuid: 'u', email: 'a@a.com', passwordChangedAt: changedAt });
    const result = service.authenticate('tok');
    await expect(result).rejects.toThrow(UnauthorizedException);
    await expect(result).rejects.toThrow('La sesión fue cerrada por un cambio de contraseña');
    expect(supabase.validateToken).not.toHaveBeenCalled();
  });

  it('rechaza un JWT propio expirado sin probar Supabase', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new TokenExpiredError('jwt expired', new Date());
    });
    await expect(service.authenticate('tok')).rejects.toThrow(UnauthorizedException);
    expect(supabase.validateToken).not.toHaveBeenCalled();
  });

  it('si la firma no es del JWT propio, delega en Supabase', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new JsonWebTokenError('invalid signature');
    });
    const user = { id: 'g', email: 'g@g.com', role: undefined, provider: 'supabase' };
    supabase.validateToken.mockResolvedValue(user);
    await expect(service.authenticate('sbtok')).resolves.toEqual(user);
    expect(supabase.validateToken).toHaveBeenCalledWith('sbtok');
  });

  it('rechaza cuando fallan JWT y Supabase', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new JsonWebTokenError('invalid signature');
    });
    supabase.validateToken.mockRejectedValue(new Error('boom'));
    await expect(service.authenticate('bad')).rejects.toThrow(UnauthorizedException);
  });
});
