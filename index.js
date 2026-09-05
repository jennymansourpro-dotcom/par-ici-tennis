import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'
import { sendInvite } from './lib/email.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)

// Reservations open OPEN_WINDOW_DAYS days ahead on tennis.paris.fr
const OPEN_WINDOW_DAYS = 6

// New slots are released every day at 08:00 Paris time
const RELEASE_TZ = 'Europe/Paris'

// Sleep until the given Paris time today; no-op if that time is already past.
const waitUntilParis = async (hour, minute) => {
  const now = dayjs().tz(RELEASE_TZ)
  const target = now.hour(hour).minute(minute).second(0).millisecond(0)
  if (now.isBefore(target)) {
    console.log(`${dayjs().format()} - Waiting until ${target.format('HH:mm')} Paris (${target.diff(now)} ms)`)
    await new Promise(resolve => setTimeout(resolve, target.diff(now)))
  }
}

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}

// Decide which dates the script should try to book, in order of preference.
// Priority: an explicit config.date, else the next occurrence of each entry of
// config.weekday (a single weekday or an ordered list, e.g. ["wednesday",
// "thursday", "monday"]), else the furthest bookable day (today + OPEN_WINDOW_DAYS).
const resolveTargetDates = () => {
  if (config.date) {
    return [dayjs(config.date, 'D/MM/YYYY')]
  }

  if (config.weekday !== undefined && config.weekday !== null) {
    const weekdays = Array.isArray(config.weekday) ? config.weekday : [config.weekday]
    const today = dayjs().startOf('day')

    return weekdays.map((weekday) => {
      const targetDow = typeof weekday === 'number'
        ? weekday
        : WEEKDAYS[String(weekday).trim().toLowerCase()]

      if (targetDow === undefined || Number.isNaN(targetDow)) {
        throw new Error(`Invalid "weekday" in config: ${weekday}`)
      }

      let daysUntil = (targetDow - today.day() + 7) % 7
      // Never target today itself: always aim for the upcoming occurrence.
      if (daysUntil === 0) daysUntil = 7
      return today.add(daysUntil, 'days')
    })
  }

  return [dayjs().startOf('day').add(OPEN_WINDOW_DAYS, 'days')]
}

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)

  const targetDates = resolveTargetDates()
  const today = dayjs().startOf('day')
  // Keep only dates already open for reservation, preserving preference order.
  const openDates = targetDates.filter((d) => {
    const daysAhead = d.startOf('day').diff(today, 'days')
    return daysAhead >= 0 && daysAhead <= OPEN_WINDOW_DAYS
  })

  if (openDates.length === 0 && !DRY_RUN_MODE) {
    console.log(`${dayjs().format()} - No target date is open for reservation yet (opens ${OPEN_WINDOW_DAYS} days ahead), nothing to do`)
    return
  }

  // In dry-run, if no target day is open yet, test against the furthest
  // bookable day so the configuration can still be exercised end-to-end.
  const candidates = openDates.length > 0 ? openDates : [today.add(OPEN_WINDOW_DAYS, 'days')]

  // The date whose slots are released this morning (today + OPEN_WINDOW_DAYS)
  // is a race decided in seconds: try it first. Days already open for a while
  // only hold leftover cancellations, which do not vanish in seconds, so they
  // can be swept afterwards, in preference order.
  const dates = [
    ...candidates.filter(d => d.startOf('day').diff(today, 'days') === OPEN_WINDOW_DAYS),
    ...candidates.filter(d => d.startOf('day').diff(today, 'days') !== OPEN_WINDOW_DAYS),
  ]
  console.log(`${dayjs().format()} - Target date(s), fresh release first: ${dates.map(d => d.format('DD/MM/YYYY')).join(', ')}`)

  // Stay idle until shortly before the 08:00 release, then log in so the
  // search itself can fire at 08:00:00 sharp (a fresh session, logged in ~5
  // minutes early, beats logging in after the gun by ~8 seconds).
  if (!DRY_RUN_MODE) {
    await waitUntilParis(7, 55)
  }

  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 90000 })

  console.log(`${dayjs().format()} - Browser started`)
  const page = await browser.newPage()
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (route) => route.abort())
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (route) => route.abort())
  page.setDefaultTimeout(90000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  // Logged in: hold here and start searching at 08:00:00 Paris sharp.
  if (!DRY_RUN_MODE) {
    await waitUntilParis(8, 0)
  }

  try {
    const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
    datesLoop:
    for (const date of dates) {
      console.log(`${dayjs().format()} - Trying date ${date.format('DD/MM/YYYY')}`)
      for (const [i, location] of locations.entries()) {
        const logLocation = process.env.GITHUB_ACTIONS ? `location ${i + 1}` : location
        console.log(`${dayjs().format()} - Search at ${logLocation}`)
        // A failure on one location (bad name, page hiccup) must not abort the
        // remaining locations, so each location gets its own try/catch.
        try {
          await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

          // select tennis location
          await page.locator('.tokens-input-text').pressSequentially(`${location} `)
          await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
          await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

          // select date
          await page.click('#when')
          await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
          await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
          await page.waitForSelector('.date-picker', { state: 'hidden' })

          await page.click('#rechercher')

          // wait until the results page is fully loaded before continue
          await page.waitForLoadState('domcontentloaded')

          let selectedHour
          hoursLoop:
          for (const hour of config.hours) {
            const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
            if (await page.locator(dateDeb).count()) {
              if (await page.isHidden(dateDeb)) {
                await page.click(`#head${location.replaceAll(' ', '')}${hour}h .panel-title`)
              }

              const courtNumbers = !Array.isArray(config.locations) ? config.locations[location] : []
              const slots = await page.locator(dateDeb).all()
              for (const slot of slots) {
                const bookSlotButton = `[courtid="${await slot.getAttribute('courtid')}"]${dateDeb}`
                if (courtNumbers.length > 0) {
                  const courtName = (await page.locator(`.court:left-of(${bookSlotButton})`).innerText()).trim()
                  if (!courtNumbers.includes(parseInt(courtName.match(/Court N°(\d+)/)[1]))) {
                    continue
                  }
                }

                const [priceType, courtType] = (await page.locator(`.row.tennis-court:has(${bookSlotButton})`).locator('.price-description').innerHTML()).split('<br>')
                if (!config.priceType.includes(priceType) || !config.courtType.includes(courtType)) {
                  continue
                }
                selectedHour = hour
                await page.click(bookSlotButton)

                break hoursLoop
              }
            }
          }

          if (await page.title() !== 'Paris | TENNIS - Reservation') {
            console.log(`${dayjs().format()} - Failed to find reservation for ${logLocation}`)
            continue
          }

          await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"')

          for (const [i, player] of config.players.entries()) {
            if (i > 0) {
              await page.click('.addPlayer')
            }
            await page.waitForSelector(`[name="player${i + 1}"]`)
            await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
            await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
          }

          await page.keyboard.press('Enter')

          await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
          const paymentMode = page.locator('#order_select_payment_form #paymentMode')
          await paymentMode.evaluate(el => {
            el.removeAttribute('readonly')
            el.style.display = 'block'
          })
          await paymentMode.fill('existingTicket')

          if (DRY_RUN_MODE) {
            console.log(`${dayjs().format()} - Fausse réservation faite : ${logLocation}`)
            if (!process.env.GITHUB_ACTIONS) console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
            console.log('----- DRY RUN END -----')
            console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')

            await page.click('#previous')
            await page.click('#btnCancelBooking')

            break datesLoop
          }

          const submit = page.locator('#order_select_payment_form #envoyer')
          await submit.evaluate(el => el.classList.remove('hide'))
          await submit.click()

          await page.waitForSelector('.confirmReservation')

          // Extract reservation details
          const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
          const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
          const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')

          if (!process.env.GITHUB_ACTIONS) {
            console.log(`${dayjs().format()} - Réservation faite : ${address}`)
            console.log(`pour le ${dateStr}`)
            console.log(`sur le ${court}`)
          } else {
            console.log('Réservation faite, regardez vos emails ou rendez-vous sur votre compte tennis.paris.fr pour plus de détails sur votre réservation.')
          }

          const [day, month, year] = [date.date(), date.month() + 1, date.year()]
          const hourMatch = dateStr.match(/(\d{2})h/)
          const hour = hourMatch ? Number(hourMatch[1]) : 12
          const start = [year, month, day, hour, 0]
          const duration = { hours: 1, minutes: 0 }
          const emailConfig = config.email || {}
          const organizerEmail = emailConfig.from || process.env.SMTP_USER
          const recipients = emailConfig.to || []
          const event = {
            start,
            startInputType: 'local',
            startOutputType: 'local',
            duration,
            title: 'Réservation Tennis',
            description: `Court: ${court}\nAdresse: ${address}`,
            location: address,
            status: 'CONFIRMED',
          }
          if (organizerEmail) {
            event.organizer = { name: 'Par ici tennis', email: organizerEmail }
          }
          if (recipients.length > 0) {
            event.method = 'REQUEST'
            event.attendees = recipients.map(email => ({
              email,
              rsvp: true,
              role: 'REQ-PARTICIPANT',
              partstat: 'NEEDS-ACTION',
            }))
          }

          const createdEvent = createEvent(event)
          if (createdEvent.error) {
            console.log('ICS creation error:', createdEvent.error)

            break datesLoop
          }

          const { value } = createdEvent
          if (!process.env.GITHUB_ACTIONS) {
            writeFileSync('event.ics', value)
          }
          if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
            await notify(Buffer.from(value, 'utf8'), 'event.ics',
              `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
                domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
                topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
              })
          }

          if (emailConfig.enable !== false && recipients.length > 0) {
            await sendInvite({
              from: organizerEmail,
              to: recipients,
              subject: `Réservation Tennis confirmée - ${dateStr}`,
              text: `Réservation confirmée.\n\n${court}\n${address}\n${dateStr}`,
              icsContent: value,
            })
          }

          break datesLoop
        } catch (err) {
          console.log(`${dayjs().format()} - Error while searching at ${logLocation}, trying next location`)
          console.log(err.message || err)
          // Help debug bad location names: show what the site actually suggested
          const suggestions = await page.locator('.tokens-suggestions-list-element').allInnerTexts().catch(() => [])
          if (suggestions.length) {
            console.log(`Suggestions displayed by the site: ${suggestions.join(' | ')}`)
          }
        }
      }
    }
  } catch (e) {
    console.log(e)
    const screenshot = await page.screenshot({ path: 'img/failure.png' })

    if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
      await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
        domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
        topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
      })
    }
  }

  await browser.close()
}

bookTennis()
