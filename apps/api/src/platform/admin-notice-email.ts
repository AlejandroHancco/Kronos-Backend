const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Aviso de que el destinatario es (o será, al entrar) administrador de un grupo. Sin enlaces con secretos. */
export function buildAdminNoticeEmail(teamName: string, appUrl: string) {
  const safeTeam = escapeHtml(teamName);
  const safeUrl = escapeHtml(appUrl);
  return {
    subject: `Eres administrador de ${teamName} en Kronos`,
    html:
      `<p>Hola,</p>` +
      `<p>Te han nombrado administrador del grupo de investigación <strong>${safeTeam}</strong> en Kronos.</p>` +
      `<p>Entra con este correo en <a href="${safeUrl}">${safeUrl}</a>. ` +
      `Si aún no tienes cuenta, regístrate con este mismo correo y confírmalo: ` +
      `el acceso de administrador se aplicará al iniciar sesión.</p>` +
      `<p>Si no esperabas este mensaje, ignóralo.</p>`,
    text:
      `Hola,\n\nTe han nombrado administrador del grupo de investigación ${teamName} en Kronos.\n\n` +
      `Entra con este correo en ${appUrl}\n` +
      `Si aún no tienes cuenta, regístrate con este mismo correo y confírmalo: ` +
      `el acceso de administrador se aplicará al iniciar sesión.\n\n` +
      `Si no esperabas este mensaje, ignóralo.`,
  };
}
