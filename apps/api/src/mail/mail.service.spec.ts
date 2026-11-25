import { MailService } from './mail.service';

const cfg = (env: Record<string, string | undefined>) => ({ get: (k: string, d?: any) => env[k] ?? d }) as any;

describe('MailService', () => {
  const msg = { to: 'a@b.com', subject: 'Hola', html: '<p>x</p>', text: 'x' };
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' });
    (global as any).fetch = fetchMock;
  });

  it('envía a Brevo con header api-key y cuerpo JSON', async () => {
    const svc = new MailService(cfg({ BREVO_API_KEY: 'k123', MAIL_FROM_EMAIL: 'no@kronos.io', MAIL_FROM_NAME: 'Kronos' }));
    await svc.send(msg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('k123');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body)).toEqual({
      sender: { email: 'no@kronos.io', name: 'Kronos' },
      to: [{ email: 'a@b.com' }],
      subject: 'Hola',
      htmlContent: '<p>x</p>',
      textContent: 'x',
    });
  });

  it('usa Kronos como nombre por defecto', async () => {
    const svc = new MailService(cfg({ BREVO_API_KEY: 'k', MAIL_FROM_EMAIL: 'no@kronos.io' }));
    await svc.send(msg);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sender.name).toBe('Kronos');
  });

  it('sin BREVO_API_KEY no llama a Brevo y registra el texto (con el enlace)', async () => {
    const svc = new MailService(cfg({}));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation();
    await svc.send({ ...msg, text: 'Abre http://x/confirm-email?token=abc' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.join(' ')).toContain('http://x/confirm-email?token=abc');
  });

  it('lanza si Brevo responde con error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const svc = new MailService(cfg({ BREVO_API_KEY: 'k', MAIL_FROM_EMAIL: 'no@kronos.io' }));
    await expect(svc.send(msg)).rejects.toThrow(/401/);
  });
});
