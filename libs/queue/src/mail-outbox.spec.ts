import { MailOutbox, MAIL_JOB_OPTIONS } from './mail-outbox';

describe('MailOutbox.enqueue', () => {
  it('publica el correo en la cola mail con 5 intentos y backoff exponencial', async () => {
    const queue = { add: jest.fn(async () => ({ id: '1' })) };
    const outbox = new MailOutbox(queue as any);
    const msg = {
      to: 'a@b.com',
      subject: 'KRONOS: X desconectado',
      text: 'hola',
    };

    await outbox.enqueue(msg);

    expect(queue.add).toHaveBeenCalledWith('send', msg, MAIL_JOB_OPTIONS);
    expect(MAIL_JOB_OPTIONS).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential' },
    });
  });

  it('propaga el error si la cola no acepta el job (el llamador decide)', async () => {
    const queue = {
      add: jest.fn(async () => {
        throw new Error('redis down');
      }),
    };
    await expect(
      new MailOutbox(queue as any).enqueue({
        to: 'a',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow('redis down');
  });
});
