import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/database';
import { createHash, randomBytes } from 'crypto';
import { MailService } from '../mail/mail.service';
import { buildVerificationEmail } from '../mail/verification-email';

const INVALID_LINK = 'El enlace no es válido o expiró';
const RESEND_COOLDOWN_MS = 60_000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  private ttlMs(): number {
    const hours = Number(this.config.get('EMAIL_VERIFICATION_TTL_HOURS'));
    return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600_000;
  }

  /** Crea un token (solo se guarda su hash) y envía el enlace por correo. */
  async issueAndSend(user: { uuid: string; email: string; name: string }): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.emailVerificationToken.create({
      data: { userId: user.uuid, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + this.ttlMs()) },
    });
    const base = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
    const link = `${base}/confirm-email?token=${token}`;
    await this.mail.send({ to: user.email, ...buildVerificationEmail(user.name, link) });
  }

  async verify(token: string): Promise<{ verified: true; email: string }> {
    if (!token || typeof token !== 'string') throw new BadRequestException(INVALID_LINK);
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { email: true } } },
    });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) throw new BadRequestException(INVALID_LINK);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { uuid: row.userId }, data: { emailVerified: true } }),
      this.prisma.emailVerificationToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    ]);
    return { verified: true, email: row.user.email };
  }

  async resend(userId: string): Promise<{ alreadyVerified: true } | { sent: true }> {
    const user = await this.prisma.user.findUnique({ where: { uuid: userId } });
    if (!user) throw new BadRequestException(INVALID_LINK);
    if (user.emailVerified) return { alreadyVerified: true };
    const last = await this.prisma.emailVerificationToken.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new HttpException('Espera un minuto antes de pedir otro correo', HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await this.issueAndSend(user);
    return { sent: true };
  }
}
