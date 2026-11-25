import { createHash } from 'crypto';
import { BadRequestException, HttpException } from '@nestjs/common';
import { EmailVerificationService } from './email-verification.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('EmailVerificationService', () => {
  const prisma: any = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    emailVerificationToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const mail = { send: jest.fn() };
  const env: Record<string, string> = { FRONTEND_URL: 'https://app.test' };
  const config: any = { get: (k: string, d?: any) => env[k] ?? d };
  let svc: EmailVerificationService;
  const user = { uuid: 'u1', email: 'a@b.com', name: 'Ana' };

  beforeEach(() => {
    jest.clearAllMocks();
    delete env.EMAIL_VERIFICATION_TTL_HOURS;
    prisma.emailVerificationToken.create.mockResolvedValue({});
    mail.send.mockResolvedValue(undefined);
    svc = new EmailVerificationService(prisma, config, mail as any);
  });

  describe('issueAndSend', () => {
    it('guarda solo el hash SHA-256 y envía el enlace con el token en claro', async () => {
      await svc.issueAndSend(user);
      const data = prisma.emailVerificationToken.create.mock.calls[0][0].data;
      const sent = mail.send.mock.calls[0][0];
      const token = /token=([\w-]+)/.exec(sent.text)![1];
      expect(token.length).toBeGreaterThanOrEqual(43);
      expect(data.tokenHash).toBe(sha(token));
      expect(data.tokenHash).not.toBe(token);
      expect(data.userId).toBe('u1');
      expect(sent.to).toBe('a@b.com');
      expect(sent.text).toContain('https://app.test/confirm-email?token=');
    });
    it('TTL por defecto 24 h', async () => {
      const before = Date.now();
      await svc.issueAndSend(user);
      const exp = prisma.emailVerificationToken.create.mock.calls[0][0].data.expiresAt.getTime();
      expect(exp - before).toBeGreaterThanOrEqual(24 * 3600e3 - 1000);
      expect(exp - before).toBeLessThanOrEqual(24 * 3600e3 + 5000);
    });
    it('TTL desde EMAIL_VERIFICATION_TTL_HOURS', async () => {
      env.EMAIL_VERIFICATION_TTL_HOURS = '2';
      const before = Date.now();
      await svc.issueAndSend(user);
      const exp = prisma.emailVerificationToken.create.mock.calls[0][0].data.expiresAt.getTime();
      expect(exp - before).toBeLessThanOrEqual(2 * 3600e3 + 5000);
      expect(exp - before).toBeGreaterThanOrEqual(2 * 3600e3 - 1000);
    });
  });

  describe('verify', () => {
    const msg = 'El enlace no es válido o expiró';
    const future = () => new Date(Date.now() + 3600e3);

    it('éxito: marca verificado y usado, devuelve email', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        usedAt: null,
        expiresAt: future(),
        user: { email: 'a@b.com' },
      });
      prisma.user.update.mockResolvedValue({});
      prisma.emailVerificationToken.update.mockResolvedValue({});
      await expect(svc.verify('rawtoken')).resolves.toEqual({ verified: true, email: 'a@b.com' });
      expect(prisma.emailVerificationToken.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: sha('rawtoken') });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { uuid: 'u1' }, data: { emailVerified: true } });
      expect(prisma.emailVerificationToken.update.mock.calls[0][0].data.usedAt).toBeInstanceOf(Date);
    });
    it.each([
      ['desconocido', null],
      ['usado', { id: 't', userId: 'u', usedAt: new Date(), expiresAt: new Date(Date.now() + 1e6), user: { email: 'x' } }],
      ['expirado', { id: 't', userId: 'u', usedAt: null, expiresAt: new Date(Date.now() - 1000), user: { email: 'x' } }],
    ])('%s -> 400', async (_n, row) => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue(row);
      await expect(svc.verify('x')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.verify('x')).rejects.toThrow(msg);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it('token vacío -> 400', async () => {
      await expect(svc.verify('')).rejects.toThrow(msg);
    });
  });

  describe('resend', () => {
    it('ya verificado', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, emailVerified: true });
      await expect(svc.resend('u1')).resolves.toEqual({ alreadyVerified: true });
      expect(mail.send).not.toHaveBeenCalled();
    });
    it('< 60 s desde el último -> 429', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, emailVerified: false });
      prisma.emailVerificationToken.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 10e3) });
      await expect(svc.resend('u1')).rejects.toBeInstanceOf(HttpException);
      await expect(svc.resend('u1')).rejects.toThrow('Espera un minuto antes de pedir otro correo');
      await svc.resend('u1').catch((e) => expect(e.getStatus()).toBe(429));
      expect(mail.send).not.toHaveBeenCalled();
    });
    it('invalida pendientes y envía uno nuevo', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, emailVerified: false });
      prisma.emailVerificationToken.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 120e3) });
      prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 1 });
      await expect(svc.resend('u1')).resolves.toEqual({ sent: true });
      const um = prisma.emailVerificationToken.updateMany.mock.calls[0][0];
      expect(um.where).toEqual({ userId: 'u1', usedAt: null });
      expect(um.data.usedAt).toBeInstanceOf(Date);
      expect(mail.send).toHaveBeenCalledTimes(1);
    });
    it('sin tokens previos envía', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, emailVerified: false });
      prisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.resend('u1')).resolves.toEqual({ sent: true });
    });
  });
});
