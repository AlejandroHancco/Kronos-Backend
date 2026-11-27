import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

const getUser = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser } }),
}));

import { SupabaseStrategy } from './supabase.strategy';

describe('SupabaseStrategy.validateToken', () => {
  const SECRET = 'test-supabase-secret';
  const prisma: any = { user: { findUnique: jest.fn(), create: jest.fn() } };
  const config = (secret?: string): any => ({
    get: (k: string) =>
      ({ SUPABASE_URL: 'http://supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_JWT_SECRET: secret })[k],
  });
  const created = { uuid: 'new-uuid', email: 'a@x.com', banned: false, isPlatformAdmin: false };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(created);
  });

  describe('remote path (no SUPABASE_JWT_SECRET)', () => {
    const strategy = new SupabaseStrategy(config(undefined), prisma);
    const remoteUser = (over: any) => ({
      data: {
        user: {
          id: 'sb1',
          email: 'a@x.com',
          email_confirmed_at: null,
          user_metadata: { full_name: 'Ana Pérez' },
          app_metadata: { provider: 'email', providers: ['email'] },
          ...over,
        },
      },
      error: null,
    });

    it('rejects an email signup whose email is not confirmed (401, no user created)', async () => {
      getUser.mockResolvedValue(remoteUser({}));
      await expect(strategy.validateToken('tok')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('accepts a Google identity and creates the user as verified', async () => {
      getUser.mockResolvedValue(remoteUser({ app_metadata: { provider: 'google', providers: ['google'] } }));
      await expect(strategy.validateToken('tok')).resolves.toEqual({
        id: 'new-uuid',
        email: 'a@x.com',
        role: undefined,
        provider: 'supabase',
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: 'a@x.com', emailVerified: true, provider: 'google', name: 'Ana', lastName: 'Pérez' }),
      });
    });

    it('accepts an email identity linked to Google via providers[]', async () => {
      getUser.mockResolvedValue(remoteUser({ app_metadata: { provider: 'email', providers: ['email', 'google'] } }));
      await expect(strategy.validateToken('tok')).resolves.toMatchObject({ id: 'new-uuid' });
    });

    it('accepts a confirmed email and creates the user as verified', async () => {
      getUser.mockResolvedValue(remoteUser({ email_confirmed_at: '2026-11-27T10:00:00Z' }));
      await expect(strategy.validateToken('tok')).resolves.toMatchObject({ id: 'new-uuid' });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ emailVerified: true, provider: 'supabase' }),
      });
    });

    it('rejects a Supabase session for the superadmin email (401)', async () => {
      getUser.mockResolvedValue(remoteUser({ app_metadata: { provider: 'google', providers: ['google'] } }));
      prisma.user.findUnique.mockResolvedValue({ uuid: 'sa', email: 'a@x.com', banned: false, isPlatformAdmin: true });
      await expect(strategy.validateToken('tok')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('does not trust user_metadata.email_verified (user-writable)', async () => {
      getUser.mockResolvedValue(remoteUser({ user_metadata: { email_verified: true } }));
      await expect(strategy.validateToken('tok')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('maps an existing normal user without creating one', async () => {
      getUser.mockResolvedValue(remoteUser({ email_confirmed_at: '2026-11-27T10:00:00Z' }));
      prisma.user.findUnique.mockResolvedValue({ uuid: 'u1', email: 'a@x.com', banned: false, isPlatformAdmin: false });
      await expect(strategy.validateToken('tok')).resolves.toMatchObject({ id: 'u1' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('local path (SUPABASE_JWT_SECRET set)', () => {
    const strategy = new SupabaseStrategy(config(SECRET), prisma);
    const sign = (claims: any) => jwt.sign({ sub: 'sb1', email: 'a@x.com', ...claims }, SECRET);

    it('accepts a Google token locally without calling Supabase', async () => {
      const tok = sign({ app_metadata: { provider: 'google', providers: ['google'] } });
      await expect(strategy.validateToken(tok)).resolves.toMatchObject({ id: 'new-uuid' });
      expect(getUser).not.toHaveBeenCalled();
    });

    it('falls back to remote for an email token and rejects it if unconfirmed', async () => {
      const tok = sign({ app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } });
      getUser.mockResolvedValue({
        data: { user: { id: 'sb1', email: 'a@x.com', email_confirmed_at: null, app_metadata: { provider: 'email' }, user_metadata: {} } },
        error: null,
      });
      await expect(strategy.validateToken(tok)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(getUser).toHaveBeenCalledWith(tok);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('falls back to remote for an email token and accepts it if confirmed', async () => {
      const tok = sign({ app_metadata: { provider: 'email' } });
      getUser.mockResolvedValue({
        data: { user: { id: 'sb1', email: 'a@x.com', email_confirmed_at: '2026-11-27T10:00:00Z', app_metadata: { provider: 'email' }, user_metadata: {} } },
        error: null,
      });
      await expect(strategy.validateToken(tok)).resolves.toMatchObject({ id: 'new-uuid' });
    });

    it('accepts an email_confirmed_at claim when present', async () => {
      const tok = sign({ app_metadata: { provider: 'email' }, email_confirmed_at: '2026-11-27T10:00:00Z' });
      await expect(strategy.validateToken(tok)).resolves.toMatchObject({ id: 'new-uuid' });
      expect(getUser).not.toHaveBeenCalled();
    });
  });
});
