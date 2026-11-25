import { buildVerificationEmail } from './verification-email';

describe('buildVerificationEmail', () => {
  it('genera asunto, HTML y texto en español con el enlace', () => {
    const link = 'https://app/confirm-email?token=abc';
    const m = buildVerificationEmail('Ana', link);
    expect(m.subject).toBe('Confirma tu correo en Kronos');
    expect(m.html).toContain(`href="${link}"`);
    expect(m.text).toContain(link);
    expect(m.html).toContain('Ana');
  });
  it('escapa el nombre en el HTML', () => {
    expect(buildVerificationEmail('<b>x</b>', 'l').html).not.toContain('<b>x</b>');
  });
});
