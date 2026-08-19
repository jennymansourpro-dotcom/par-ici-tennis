import nodemailer from 'nodemailer'

// Send the reservation as a calendar invitation (text/calendar; method=REQUEST)
// so recipients receive it as an event they can accept in their calendar.
// SMTP credentials come from environment variables (GitHub secrets):
//   SMTP_HOST     (default: smtp.gmail.com)
//   SMTP_PORT     (default: 465)
//   SMTP_USER     (default: `from`)
//   SMTP_PASSWORD (required, e.g. a Gmail app password)
export const sendInvite = async ({ from, to, subject, text, icsContent }) => {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com'
  const port = Number(process.env.SMTP_PORT || 465)
  const user = process.env.SMTP_USER || from
  const pass = process.env.SMTP_PASSWORD

  const recipients = Array.isArray(to) ? to : [to]

  if (!pass) {
    console.log('SMTP_PASSWORD not set, skipping email invitation')
    return
  }
  if (!from || recipients.length === 0) {
    console.log('Email sender or recipients missing, skipping email invitation')
    return
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    })

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
