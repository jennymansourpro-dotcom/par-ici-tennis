import nodemailer from 'nodemailer'

// Build an email transport. Preferred: Gmail via OAuth2 (sends genuinely as the
// authenticated Google account, e.g. jenny@getgranit.ai, with Gmail's own DKIM).
// Falls back to plain SMTP if OAuth2 is not configured. Credentials come from
// environment variables (GitHub secrets):
//   Gmail OAuth2 : GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   Plain SMTP   : SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465),
//                  SMTP_USER, SMTP_PASSWORD
const buildTransport = () => {
  const gmailUser = process.env.GMAIL_USER
  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN

  if (gmailUser && clientId && clientSecret && refreshToken) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: gmailUser,
        clientId,
        clientSecret,
        refreshToken,
      },
    })
  }

  const pass = process.env.SMTP_PASSWORD
  if (pass) {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com'
    const port = Number(process.env.SMTP_PORT || 465)
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass },
    })
  }

  return null
}

// Send the reservation as a calendar invitation (text/calendar; method=REQUEST)
// so recipients receive it as an event they can accept in their calendar.
export const sendInvite = async ({ from, to, subject, text, icsContent }) => {
  const recipients = Array.isArray(to) ? to : [to]

  const transporter = buildTransport()
  if (!transporter) {
    console.log('No email transport configured (set Gmail OAuth2 or SMTP env vars), skipping email invitation')
    return
  }
  if (!from || recipients.length === 0) {
    console.log('Email sender or recipients missing, skipping email invitation')
    return
  }

  try {
    await transporter.sendMail({
      from,
      to: recipients.join(', '),
      subject,
      text,
      icalEvent: {
        method: 'REQUEST',
        content: icsContent,
      },
    })

    console.log(`Invitation email sent to ${recipients.join(', ')}`)
  } catch (err) {
    console.log('Error while sending email invitation:', err)
  }
}
