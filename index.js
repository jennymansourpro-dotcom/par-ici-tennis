import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'
import { sendInvite, sendAlert } from './lib/email.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)

// Reservations open OPEN_WINDOW_DAYS days ahead on tennis.paris.fr
const OPEN_WINDOW_DAYS = 6

// New slots are released every day at 08:00 Paris time
const RELEASE_TZ = 'Europe/Paris'

// Compare site labels (price type, court type) leniently: strip tags and
// non-breaking spaces, collapse whitespace, ignore case.
const normalizeLabel = str => (str || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

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
  // Dates listed in config.excludeDates (D/MM/YYYY) are never booked,
  // e.g. a week where the usual day is not playable.
  const excludedDates = (config.excludeDates || []).map(d => dayjs(d, 'D/MM/YYYY').format('DD/MM/YYYY'))
  // Keep only dates already open for reservation, preserving preference order.
  const openDates = targetDates.filter((d) => {
    const daysAhead = d.startOf('day').diff(today, 'days')
    return daysAhead >= 0 && daysAhead <= OPEN_WINDOW_DAYS && !excludedDates.includes(d.format('DD/MM/YYYY'))
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
  // Note: the upstream project blocked the site's invisible-captcha requests
  // here. That circumvented an explicit anti-robot protection of
  // tennis.paris.fr, so it was removed (see the project's agent rules): the
  // captcha now loads normally, and if the site challenges or blocks the
  // session the script fails cleanly instead of working around it.
  page.setDefaultTimeout(90000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  // The site allows a single active reservation per account, and refuses
  // every booking click while one is held. Report what the account already
  // has, so a silent refusal later is not mistaken for a site problem.
  const accountLines = (await page.locator('.main-informations').innerText().catch(() => ''))
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => /r\u00e9servation|court|annuler/i.test(l))
    .slice(0, 8)
  console.log(accountLines.length > 0
    ? `${dayjs().format()} - Account currently shows: ${accountLines.join(' | ')}`
    : `${dayjs().format()} - Account summary block lists no reservation`)

  // Remember any reservation the account already holds: it blocks every new
  // booking, so the alert must say that rather than "book it by hand".
  let heldReservation = null

  // That block does not actually list reservations, so follow the account's
  // own "Mes reservations" link and report what it holds. Read-only, and it
  // runs at 07:55, well before the release.
  const reservationsUrl = await page.locator('a')
    .evaluateAll((els) => {
      const link = els.find(a => /r[\u00e9e]servation/i.test(a.textContent || '') && a.href && !/deconnexion/i.test(a.href))
      return link ? link.href : null
    })
    .catch(() => null)
  if (reservationsUrl) {
    await page.goto(reservationsUrl).catch(() => {})
    const held = (await page.locator('body').innerText().catch(() => ''))
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(l => /court|annuler|\d{1,2}\s+\w+\s+20\d{2}|\d{2}h|\d{2}\/\d{2}\/\d{4}|aucune/i.test(l))
      .slice(0, 10)
    if (held.some(l => /annuler/i.test(l))) {
      heldReservation = held.filter(l => !/annuler/i.test(l)).join(' - ') || held.join(' - ')
    }
    console.log(`${dayjs().format()} - Reservations page says: ${held.length > 0 ? held.join(' | ') : '(nothing matched)'}`)
  } else {
    console.log(`${dayjs().format()} - No reservations link found on the account page`)
  }

  const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations

  // Fill the search form (location + date), leaving only the "Rechercher"
  // click to the caller. With `dateTimeout` set, a date the picker does not
  // offer (yet) makes the fill return false instead of throwing.
  const fillSearchForm = async (location, date, { dateTimeout } = {}) => {
    await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

    // select tennis location
    await page.locator('.tokens-input-text').pressSequentially(`${location} `)
    await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
    await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

    // The suggestions dropdown closes on the click, then REOPENS ~1s later
    // when a late autocomplete response lands. Opened too early, the date
    // picker gets closed again by that reopen (16/09 dry run: every Pailleron
    // search hung 90s on an invisible date cell). Let the late response land,
    // then close whatever it reopened.
    await page.waitForTimeout(1800)
    const suggestionsList = page.locator('.tokens-suggestions-list-element').first()
    if (await suggestionsList.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
      await suggestionsList.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {})
    }

    // Select the date, retrying: the dropdown can still close the picker or
    // intercept the click (13/09 run), and Escape does not always dismiss
    // it — force-hide its container before the next attempt.
    const dateCell = `[dateiso="${date.format('DD/MM/YYYY')}"]`
    const attempts = dateTimeout ? 2 : 4
    const timeout = dateTimeout || 5000
    let picked = false
    for (let attempt = 1; attempt <= attempts && !picked; attempt++) {
      try {
        if (!(await page.locator(dateCell).first().isVisible().catch(() => false))) {
          await page.click('#when', { timeout })
        }
        await page.click(dateCell, { timeout })
        await page.waitForSelector('.date-picker', { state: 'hidden', timeout })
        picked = true
      } catch {
        await page.keyboard.press('Escape').catch(() => {})
        await page.evaluate(() => {
          // eslint-disable-next-line no-undef
          document.querySelectorAll('.tokens-suggestion-selector').forEach(el => { el.style.display = 'none' })
        }).catch(() => {})
      }
    }
    if (!picked) {
      if (dateTimeout) {
        return false
      }
      throw new Error(`Could not select ${date.format('DD/MM/YYYY')} in the date picker`)
    }
    return true
  }

  // Logged in: pre-fill the search form for the top-priority date and
  // location while waiting, so that at 08:00:00 sharp only the "Rechercher"
  // click remains (results at ~08:00:01 instead of ~08:00:06 — five runs in
  // a row showed evening rows still on screen at +6s but no court left).
  // The freshly released date may not be offered by the picker before 08:00;
  // in that case only the location is pre-filled and the date is picked
  // after the gun.
  let preloadReady = false
  let preloadDateSelected = false
  if (!DRY_RUN_MODE) {
    try {
      preloadDateSelected = await fillSearchForm(locations[0], dates[0], { dateTimeout: 3000 })
      preloadReady = true
      console.log(`${dayjs().format()} - Search form pre-filled (date selected: ${preloadDateSelected})`)
    } catch (err) {
      console.log(`${dayjs().format()} - Pre-fill failed (${err.message}), falling back to the normal flow`)
    }
    await waitUntilParis(8, 0)
  }

  // tennis.paris.fr protects booking with an explicit anti-robot check, which
  // this script must not circumvent. When a matching slot is found but the
  // booking page never opens, warn Jenny at once so she can book it by hand.
  let manualAlertSent = false
  const alertManualBookingNeeded = async ({ location, date, hour, blocked, captcha }) => {
    if (manualAlertSent || DRY_RUN_MODE) return
    manualAlertSent = true
    const emailConfig = config.email || {}
    const sender = emailConfig.from || process.env.SMTP_USER || process.env.GMAIL_USER
    const when = `${date.format('DD/MM/YYYY')} à ${hour}h`
    await sendAlert({
      from: sender,
      to: sender,
      subject: `Tennis : créneau libre à réserver à la main (${when})`,
      text: [
        `Un court est libre : ${location}, le ${when}.`,
        '',
        captcha
          ? 'Le site demande une vérification anti-robot pour valider la réservation. Ce contrôle n\'est pas contourné : connecte-toi et termine la réservation à la main, le créneau est réellement disponible.'
          : heldReservation
            ? `Le compte détient déjà une réservation active (${heldReservation}). Le site refuse toute nouvelle réservation tant qu'elle n'est pas annulée ou jouée - y compris à la main.`
            : blocked
              ? 'La réservation automatique a été arrêtée par la vérification anti-robot du site.'
              : 'La page de réservation ne s\'est pas ouverte après le clic.',
        '',
        'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau',
      ].join('\n'),
    })
  }

  try {
    datesLoop:
    for (const date of dates) {
      console.log(`${dayjs().format()} - Trying date ${date.format('DD/MM/YYYY')}`)
      for (const [i, location] of locations.entries()) {
        const logLocation = process.env.GITHUB_ACTIONS ? `location ${i + 1}` : location
        console.log(`${dayjs().format()} - Search at ${logLocation}`)
        // A failure on one location (bad name, page hiccup) must not abort the
        // remaining locations, so each location gets its own try/catch.
        try {
          if (preloadReady && i === 0 && date === dates[0]) {
            preloadReady = false
            if (!preloadDateSelected) {
              // The picker was left open on the pre-filled page; the freshly
              // released date should be offered now. If it still is not,
              // redo the form from scratch.
              const quickPick = await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`, { timeout: 3000 })
                .then(() => page.waitForSelector('.date-picker', { state: 'hidden', timeout: 3000 }))
                .then(() => true)
                .catch(() => false)
              if (!quickPick) {
                await fillSearchForm(location, date)
              }
            }
          } else {
            await fillSearchForm(location, date)
          }

          await page.click('#rechercher')

          // wait until the results page is fully loaded before continue
          await page.waitForLoadState('domcontentloaded')

          // The slot panels are rendered after page load: scanning right at
          // domcontentloaded can see an empty page while the diagnostic a
          // second later lists the very slots the loop missed. Wait for the
          // rows to appear (no rows after 5s = genuinely nothing offered).
          await page.waitForSelector('[datedeb]', { timeout: 5000 }).catch(() => {})

          let selectedHour
          hoursLoop:
          for (const hour of config.hours) {
            const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
            if (await page.locator(dateDeb).count()) {
              console.log(`${dayjs().format()} - ${await page.locator(dateDeb).count()} slot element(s) displayed at ${hour}h for ${logLocation}`)
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

                const [priceType, courtType] = (await page.locator(`.row.tennis-court:has(${bookSlotButton})`).locator('.price-description').innerHTML())
                  .split(/<br\s*\/?>/i)
                  .map(normalizeLabel)
                if (!config.priceType.some(p => normalizeLabel(p) === priceType) || !config.courtType.some(c => normalizeLabel(c) === courtType)) {
                  console.log(`Slot ${hour}h at ${logLocation} skipped by price/court filter: price="${priceType}", type="${courtType}"`)
                  continue
                }
                selectedHour = hour
                await page.click(bookSlotButton)

                break hoursLoop
              }
            }
          }

          // The book click navigates to the reservation page: give it time to
          // load before concluding the slot was lost (18/09: a Jandelle 21h
          // slot was dropped 0.4s after the click, title not yet changed).
          if (selectedHour) {
            for (let waited = 0; waited < 10000 && await page.title() !== 'Paris | TENNIS - Reservation'; waited += 500) {
              await page.waitForTimeout(500)
            }
          }

          // The site answers the booking click with its anti-robot check
          // (view=return_reservation_captcha). It must not be solved or worked
          // around, so report the slot - it is genuinely free - and stop,
          // rather than wait 90s for a page that will never come.
          if (page.url().includes('return_reservation_captcha')) {
            console.log(`${dayjs().format()} - Security check shown after the booking click: ${logLocation} at ${selectedHour}h on ${date.format('DD/MM/YYYY')} must be booked by hand`)
            await alertManualBookingNeeded({ location, date, hour: selectedHour, captcha: true })
            break datesLoop
          }

          if (await page.title() !== 'Paris | TENNIS - Reservation') {
            console.log(`${dayjs().format()} - Failed to find reservation for ${logLocation}`)
            // Diagnostic: list the bookable slots the site actually displayed,
            // to tell "already taken by others" apart from "never offered".
            const offered = await page.locator('[datedeb]')
              .evaluateAll(els => [...new Set(els.map(el => el.getAttribute('datedeb')))])
              .catch(() => [])
            console.log(`Slots displayed by the site: ${offered.length > 0 ? offered.join(' | ') : 'none'}`)

            // A slot was clicked but the booking page never opened. Since the
            // anti-robot check is no longer bypassed (19-21/09), every such
            // click stalls here. Record where it stopped, tell Jenny so she can
            // book by hand, and stop instead of tripping the check again.
            if (selectedHour) {
              const bodyText = await page.locator('body').innerText().catch(() => '')
              const blocked = /vérification de sécurité|bloquons les robots|blacklist|captcha/i.test(bodyText)
              console.log(`Booking click did not open the reservation page: "${await page.title().catch(() => '?')}" ${page.url()}${blocked ? ' - anti-robot check detected' : ''}`)
              // Tell a lost race apart from a silent refusal: if the slot is
              // gone from the page, someone booked it first; if it is still
              // listed with no message, the submission was simply ignored.
              const stillListed = await page
                .locator(`[datedeb="${date.format('YYYY/MM/DD')} ${selectedHour}:00:00"]`)
                .count()
                .catch(() => 0)
              const notice = (await page.locator('.alert, .error, .message, .notification').allInnerTexts().catch(() => []))
                .map(t => t.replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(0, 3)
                .join(' | ')
              console.log(`After the failed click: ${stillListed} slot element(s) still listed at ${selectedHour}h, ${notice ? `page notice: ${notice}` : 'no notice on the page'}`)
              // The page reports "Complet - Pas de disponibilite" while the
              // slot stays listed: dump how each element for that hour is
              // marked, to tell bookable rows from full ones.
              const rows = await page
                .locator(`[datedeb="${date.format('YYYY/MM/DD')} ${selectedHour}:00:00"]`)
                .evaluateAll(els => els.slice(0, 5).map((el) => {
                   
                  const row = el.closest('.row.tennis-court') || el.parentElement
                  return [
                    `tag=${el.tagName}`,
                    `class="${el.className}"`,
                    `disabled=${el.hasAttribute('disabled')}`,
                    `visible=${el.offsetParent !== null}`,
                    `text="${(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`,
                    `row="${row ? (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '?'}"`,
                  ].join(' ')
                }))
                .catch(() => [])
              rows.forEach((r, i) => console.log(`  slot[${i}] ${r}`))
              if (rows.some(r => r.includes('buttonHasReservation'))) {
                console.log('  -> the site marks these buttons "buttonHasReservation": the account already holds an active reservation, which blocks any new booking until it is cancelled or played')
              }
              await alertManualBookingNeeded({ location, date, hour: selectedHour, blocked })
              break datesLoop
            }
            continue
          }

          await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"', { timeout: 30000 })

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

          // Paid bookings land on a .confirmReservation page; free ("Gratuité")
          // bookings land on a recap page with a cancel button instead. Bound
          // the wait: staying on methode_paiement means the payment could not
          // be completed (18/09: 90s burned there while a free Jandelle slot
          // was still available), most likely because the account holds no
          // "carnet de réservation" for paid courts.
          await page.locator('.confirmReservation')
            .or(page.getByText('Annuler ma réservation'))
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {
              throw new Error('No confirmation after payment submission — the account likely has no "carnet de réservation" for paid courts')
            })

          // Extract reservation details, falling back to known values on the
          // free-booking recap page whose markup differs.
          const grab = async (selector) => {
            try {
              return (await page.locator(selector).first().textContent({ timeout: 3000 })).trim().replace(/( ){2,}/g, ' ')
            } catch {
              return null
            }
          }
          const address = await grab('.address') || location
          const dateStr = await grab('.date') || `${date.format('DD/MM/YYYY')} - ${selectedHour}h`
          const court = await grab('.court') || `${location} - réservation confirmée`

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
          console.log(`Page at failure: "${await page.title().catch(() => '?')}" ${page.url()}`)
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
