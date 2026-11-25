const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function buildVerificationEmail(name: string, link: string) {
  const safeName = escapeHtml(name);
  const safeLink = escapeHtml(link);
  return {
    subject: 'Confirma tu correo en Kronos',
    html:
      `<p>Hola ${safeName},</p>` +
      `<p>Gracias por registrarte en Kronos. Confirma tu correo para continuar:</p>` +
      `<p><a href="${safeLink}">Confirmar mi correo</a></p>` +
      `<p>Si el botón no funciona, copia este enlace en tu navegador:<br>${safeLink}</p>` +
      `<p>Si no creaste esta cuenta, ignora este mensaje.</p>`,
    text:
      `Hola ${name},\n\nGracias por registrarte en Kronos. Confirma tu correo abriendo este enlace:\n${link}\n\n` +
      `Si no creaste esta cuenta, ignora este mensaje.`,
  };
}
