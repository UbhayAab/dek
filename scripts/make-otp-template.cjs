// Insert the dek-otp transactional template into JCF-Mailer.
const { readFileSync } = require('node:fs');
const html = readFileSync(process.env.USERPROFILE + '\\Desktop\\claude\\dek\\docs\\dek-otp-template.html', 'utf8')
  // Strip the wrapper page the docs file carries - the mailer wants the email body only.
  .replace(/^[\s\S]*?<body[^>]*>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .trim();

const esc = (s) => s.replace(/'/g, "''");
const sql = `
insert into email_template (name, slug, subject, type, html_body, description, created_by)
values (
  'Dek sign-in code',
  'dek-otp',
  'Your Dek sign-in code: {{CODE}}',
  'TRANSACTIONAL',
  '${esc(html)}',
  'OTP code for Dek sign-in/sign-up. Placeholders: CODE, EMAIL, FROM_NAME.',
  'ubhay-via-ssh'
)
on conflict (slug) do update
  set html_body = excluded.html_body,
      subject = excluded.subject,
      updated_at = now()
returning id, slug, subject;
`;
process.stdout.write(sql);
