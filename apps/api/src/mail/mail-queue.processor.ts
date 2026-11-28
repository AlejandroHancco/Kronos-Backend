import { Logger } from '@nestjs/common';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { MAIL_QUEUE, MailJob } from '@app/queue';
import { MailService } from './mail.service';

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Consumidor de la cola 'mail': envía por Brevo los correos que publican otros procesos (el worker
 * no tiene internet). Si Brevo falla el job lanza y Bull reintenta (MAIL_JOB_OPTIONS); cada fallo
 * se registra.
 */
@Processor(MAIL_QUEUE)
export class MailQueueProcessor {
  private readonly logger = new Logger(MailQueueProcessor.name);

  constructor(private readonly mail: MailService) {}

  @Process('send')
  async handle(job: Job<MailJob>): Promise<void> {
    const { to, subject, text, html } = job.data;
    await this.mail.send({
      to,
      subject,
      text,
      html: html ?? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
    });
  }

  @OnQueueFailed()
  onFailed(job: Job<MailJob>, err: Error): void {
    this.logger.warn(
      `Correo ${job.id} a ${job.data?.to} (${job.data?.subject}) falló ` +
        `(intento ${job.attemptsMade}/${job.opts?.attempts ?? 1}): ${err?.message}`,
    );
  }
}
