import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { JobOptions, Queue } from 'bull';
import { MAIL_QUEUE } from './queue.constants';
import type { MailJob } from './jobs';

/** 5 intentos con backoff exponencial (30 s, 1 min, 2 min, 4 min); los fallidos quedan una semana para revisión. */
export const MAIL_JOB_OPTIONS: JobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * Bandeja de salida de correo: publica el mensaje en la cola 'mail'. La consume la API (que sí
 * tiene internet) con MailService; así el worker, en la red del laboratorio, nunca llama a Brevo.
 */
@Injectable()
export class MailOutbox {
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<MailJob>,
  ) {}

  async enqueue(msg: MailJob): Promise<void> {
    await this.queue.add('send', msg, MAIL_JOB_OPTIONS);
  }
}
