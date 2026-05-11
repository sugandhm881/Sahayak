const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: env.EMAIL_PORT === 465,
    auth: env.EMAIL_USER ? { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD } : undefined,
  });
  return transporter;
}

async function sendEmailRaw(to, subject, body) {
  try {
    await getTransporter().sendMail({ from: env.EMAIL_USER, to, subject, text: body });
    return true;
  } catch (e) {
    console.error('Email Error:', e.message);
    return false;
  }
}

async function sendEmailWithAttachment(to, subject, body, attachmentBytes, filename) {
  await getTransporter().sendMail({
    from: env.EMAIL_USER,
    to,
    subject,
    text: body,
    attachments: [{ filename, content: attachmentBytes }],
  });
}

module.exports = { sendEmailRaw, sendEmailWithAttachment };
