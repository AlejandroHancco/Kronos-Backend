import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  /** Envía por Brevo. Sin BREVO_API_KEY no envía: registra el contenido (modo desarrollo). */
  async send(msg: MailMessage): Promise<void> {
    const apiKey = this.config.get<string>('BREVO_API_KEY');
    if (!apiKey) {
      this.logger.warn(`BREVO_API_KEY vacío: correo no enviado a ${msg.to} (${msg.subject}). Contenido:\n${msg.text}`);
      return;
    }
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: {
          email: this.config.get<string>('MAIL_FROM_EMAIL'),
          name: this.config.get<string>('MAIL_FROM_NAME') || 'Kronos',
        },
        to: [{ email: msg.to }],
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Brevo respondió ${res.status}: ${detail.slice(0, 200)}`);
    }
  }
}
