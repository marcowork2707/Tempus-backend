const nodemailer = require('nodemailer');

let transporter = null;

function getMailConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: {
      user,
      pass,
    },
  };
}

function getTransporter() {
  const config = getMailConfig();
  if (!config) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport(config);
  }

  return transporter;
}

async function sendInvitationEmail({ to, firstName, centerName, roleLabel, activationLink, expiresAt }) {
  const mailer = getTransporter();

  if (!mailer) {
    return {
      sent: false,
      reason: 'SMTP_NOT_CONFIGURED',
    };
  }

  const fromName = process.env.SMTP_FROM_NAME || 'Tempus';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const expiresText = new Date(expiresAt).toLocaleDateString('es-ES');

  await mailer.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: `Activa tu cuenta de Tempus - ${centerName}`,
    text: [
      `Hola ${firstName},`,
      '',
      `Has sido invitado/a a Tempus como ${roleLabel} en ${centerName}.`,
      'Para activar tu cuenta y crear tu contraseña, entra en este enlace:',
      activationLink,
      '',
      `Este enlace caduca el ${expiresText}.`,
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.5;">
        <h2 style="margin: 0 0 12px;">Activa tu cuenta de Tempus</h2>
        <p>Hola ${firstName},</p>
        <p>Has sido invitado/a a <strong>Tempus</strong> como <strong>${roleLabel}</strong> en <strong>${centerName}</strong>.</p>
        <p>Para activar tu cuenta y crear tu contraseña, pulsa aquí:</p>
        <p>
          <a
            href="${activationLink}"
            style="display:inline-block;padding:12px 18px;background:#086aa0;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;"
          >
            Crear contraseña
          </a>
        </p>
        <p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
        <p style="word-break: break-all; color: #0369a1;">${activationLink}</p>
        <p>Este enlace caduca el <strong>${expiresText}</strong>.</p>
      </div>
    `,
  });

  return {
    sent: true,
    reason: null,
  };
}

module.exports = {
  sendInvitationEmail,
};
