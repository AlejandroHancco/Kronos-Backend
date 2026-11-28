import { MailQueueProcessor } from './mail-queue.processor';

describe('MailQueueProcessor', () => {
  it('envía el correo del job con MailService (html tal cual si viene)', async () => {
    const mail = { send: jest.fn(async () => undefined) };
    const processor = new MailQueueProcessor(mail as any);
    await processor.handle({
      data: { to: 'a@b.com', subject: 'S', text: 'T', html: '<p>T</p>' },
    } as any);
    expect(mail.send).toHaveBeenCalledWith({
      to: 'a@b.com',
      subject: 'S',
      text: 'T',
      html: '<p>T</p>',
    });
  });

  it('sin html lo genera del texto, escapado y con saltos de línea', async () => {
    const mail = { send: jest.fn(async () => undefined) };
    await new MailQueueProcessor(mail as any).handle({
      data: { to: 'a', subject: 'S', text: 'A <b>\nB' },
    } as any);
    expect((mail.send.mock.calls[0] as any[])[0].html).toBe(
      '<p>A &lt;b&gt;<br>B</p>',
    );
  });

  it('un fallo de Brevo se propaga (Bull reintenta) y el fallo se registra', async () => {
    const mail = {
      send: jest.fn(async () => {
        throw new Error('Brevo respondió 500');
      }),
    };
    const processor = new MailQueueProcessor(mail as any);
    await expect(
      processor.handle({ data: { to: 'a', subject: 'S', text: 'T' } } as any),
    ).rejects.toThrow('500');
    const warn = jest
      .spyOn((processor as any).logger, 'warn')
      .mockImplementation();
    processor.onFailed(
      {
        id: '9',
        attemptsMade: 2,
        opts: { attempts: 5 },
        data: { to: 'a', subject: 'S' },
      } as any,
      new Error('Brevo respondió 500'),
    );
    expect(warn.mock.calls.join(' ')).toContain('Brevo respondió 500');
  });
});
