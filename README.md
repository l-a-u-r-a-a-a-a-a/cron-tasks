# event-monitor

Watches an events listing site for newly added events and alerts by email
and/or WhatsApp. Also watches specific sold-out events for tickets coming
back (see `watchlist.txt` — one event ID per line).

Runs on GitHub Actions every ~5 minutes, with an internal 1-minute check
loop. State persists in `known_ids.txt` and `watchlist_state.json`,
committed back by the workflow.

## Configuration

Repository secrets:

| Secret             | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `MONITOR_BASE_URL` | Base URL of the site to monitor (required) |
| `EMAIL_FROM`       | Gmail address that sends alerts          |
| `EMAIL_PASSWORD`   | Gmail app password                       |
| `EMAIL_TO`         | Where alerts are delivered               |
| `WHATSAPP_PHONE`   | CallMeBot phone number (optional)        |
| `WHATSAPP_APIKEY`  | CallMeBot API key (optional)             |

Repository variables (optional): `SEARCH_LOCATION` (default `London`),
`SEARCH_RANGE` (default `50`).
