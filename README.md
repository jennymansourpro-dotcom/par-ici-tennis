# par-ici-tennis (*Parisii tennis*)

Script to automatically book a tennis court in Paris (on https://tennis.paris.fr)

> "Par ici" mean "this way" in french. The "Parisii" were a Gallic tribe that dwelt on the banks of the river Seine. They lived on lands now occupied by the modern city of Paris. The project name can be interpreted as "For a Parisian tennis, follow this way"

**NOTE**: They added a CAPTCHA during the reservation process. The latest version **should** pass through. If it fails, open an issue with error logs, I will try to find another way.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Get started](#get-started)
  - [Configuration](#configuration)
  - [Ntfy notifications (optional)](#ntfy-notifications-optional)
  - [Payment process](#payment-process)
  - [Running](#running)
    - [On your machine](#on-your-machine)
    - [Using GitHub Actions (beta)](#using-github-actions-beta)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites
- Node.js >= 20.6.x
- A "carnet de réservation" in your Paris Tennis account (see [Payment process](#payment-process))

## Get started

### Configuration

Create `config.json` file from `config.json.sample` and complete with your preferences.

- `location`: a list of courts ordered by preference - [full list](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennisParisien&view=les_tennis_parisiens)

You can use two formats for the `locations` field:

1) **Array format:**
  ```json
  "locations": [
    "Valeyre",
    "Suzanne Lenglen",
    "Poliveau"
  ]
  ```
  Use this if you want to search all courts at each location, in order of preference.

2) **Object format (with court numbers):**
  ```json
  "locations": {
    "Suzanne Lenglen": [5, 7, 11],
    "Henry de Montherlant": []
  }
  ```
  Use this if you want to specify court numbers for each location. An empty array means all courts at that location will be considered.

Choose the format that best matches your preferences.

- `date` (optional) a string representing a date formatted D/M/YYYY, do not set the date to automatically book 6 days in the future as soon as the reservation slots open

- `weekday` (optional) a weekday name (`monday`, `tuesday`, …) or number (`0` = Sunday … `6` = Saturday). When set (and `date` is not), the script always targets the next occurrence of that weekday. If that day is not open for reservation yet (reservations open 6 days ahead), the script exits without booking. This lets you run the workflow every morning: it books the target day as soon as it opens and does nothing the rest of the time. Ignored when `date` is set.

- `hours` a list of hours ordered by preference

- `priceType` an array containing price types you can book `Tarif plein` and/or `Tarif réduit`

- `courtType` an array containing court types you can book `Découvert` and/or `Couvert`

- `players` list of players 3 max (without you)

### Email invitation (optional)

Send the reservation as a calendar invitation (`.ics`, `METHOD:REQUEST`) by email to one or more recipients when a booking succeeds. Add to your `config.json`:

```json
"email": {
  "enable": true,
  "from": "you@example.com",
  "to": ["you@example.com", "partner@example.com"]
}
```

Provide sending credentials via environment variables (GitHub secrets). Two modes are supported:

**Gmail via OAuth2 (recommended)** — sends genuinely as your Google account with Gmail's own DKIM:

- `GMAIL_USER` — the sending Google address (e.g. `jenny@getgranit.ai`)
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` — from a Google Cloud OAuth client
- `GMAIL_REFRESH_TOKEN` — a refresh token for the `https://mail.google.com/` scope

One-time token setup:
1. [Google Cloud Console](https://console.cloud.google.com/) → create a project → enable the **Gmail API**.
2. Configure the **OAuth consent screen** (Internal for Workspace) and add the scope `https://mail.google.com/`.
3. Create an **OAuth client ID** (type: Web application) and add the redirect URI `https://developers.google.com/oauthplayground`.
4. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), click the gear → *Use your own OAuth credentials*, paste the client ID/secret, authorize the `https://mail.google.com/` scope as your sending account, then exchange the code for a **refresh token**.
5. Add the four secrets above to your repository.

**Plain SMTP (fallback)** — used only if the Gmail OAuth2 secrets are absent:

- `SMTP_PASSWORD` (required), `SMTP_USER`, `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `465`)

If neither mode is configured, the email step is skipped silently.

### Ntfy notifications (optional)

You can configure the script to send notifications with the reservation details and the ics file via [ntfy](https://ntfy.sh), a simple pub-sub notification service.

To receive notifications:
- Choose a unique topic name (e.g., `YOUR-UNIQUE-TOPIC-NAME` — choose something unique and hard to guess, as there is no password protection for subscriptions)
- Subscribe to your topic using the [ntfy mobile app](https://ntfy.sh/docs/subscribe/phone/) or [web interface](https://ntfy.sh/)

To enable ntfy notifications in script, add the following configuration to your `config.json`:

```json
"ntfy": {
  "enable": true,
  "topic": "YOUR-UNIQUE-TOPIC-NAME"
}
```

Configuration options:
- `enable`: set to `true` to enable ntfy notifications
- `topic`: your unique ntfy topic name chosen previously
- `domain` (optional): custom ntfy server domain (`ntfy.sh` used if empty)

Notification example:

![Notification example](doc/ntfy.png)

### Payment process

To pass the payment phase without trouble you need a "carnet de réservation", be careful you need a "carnet" that matches your `priceType` & `courtType` [combination](https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=rate&view=les_tarifs) selected previously

### Running

#### <ins>On your machine</ins>

To run this project locally, install the dependencies

```sh
npm install
```

and run the script:

```sh
npm start
```

To test your configuration, you can run this project in dry-run mode. It will check court availability but no reservations will be made:

```sh
npm run start-dry
```

You can start the script automatically using cron or equivalent

#### <ins>Using GitHub Actions (beta)</ins>

> [!IMPORTANT]
> Due to GitHub Actions limitations during high load on their servers, scheduled triggers may not run exactly at 08:00. Improvements are in progress to make the booking more reliable even with a slight delay.
>
> For perfect timing, consider using your [own server or computer](#On-your-machine).

You can automate the booking using GitHub Actions workflows. The repository includes pre-configured workflows:

1. **[Fork this repository](https://github.com/bertrandda/par-ici-tennis/fork)** to your own GitHub account (if you find this repository useful, you can also give it a star ⭐)

2. **Configure GitHub secrets and variables:**
   - Go to your repository Settings → Secrets and variables → Actions
   - Add the following **secrets**:
     - `ACCOUNT_EMAIL`: your Paris Tennis email
     - `ACCOUNT_PASSWORD`: your Paris Tennis password
     - `NTFY_TOPIC`: (optional) your ntfy topic for notifications
     - `NTFY_DOMAIN`: (optional) custom ntfy server domain if you don't use `ntfy.sh`
   - Add a **variable**:
     - `CONFIG_JSON`: the content of your `config.json` file (⚠️ without account credentials and ntfy config for security reasons). Without date line to always book 6 days in advance

3. **Enable workflow:**
   - The day before you want to execute the script, go to the Actions tab and enable the `Tennis booking` workflow
   - The workflow runs the following day at 08:00 Paris time and automatically disables itself after running to avoid restarting on subsequent days
   - Manually re-enable it from the Actions tab when you need to book again

To test Github Actions config you can start `Tennis booking dry-run` workflow manually. It will check court availability but no reservations will be made.

## Contributing

Contributions and bug reports are welcome! Please open an [issue](https://github.com/bertrandda/par-ici-tennis/issues) or submit a [pull request](https://github.com/bertrandda/par-ici-tennis/pulls).

## License

MIT
