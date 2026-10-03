# Printer transports (BAM-35)

Bambuzle talks to printers through a **transport**. Everything above the transport layer (job tracking, sampling, alerts, stats, the dashboard) sees the same thing: normalized printer state, plus a way to send a command and get the printer's reply. Which transport a printer uses is a per-printer setting, so one install can mix them.

| Transport | Status | Monitoring | Control on authorization firmware | Needs |
|---|---|---|---|---|
| `cloud` — Bambu Cloud MQTT | ✅ (original) | ✅ | ❌ rejected unless signed (`mqtt message verify failed`) | Bambu account login |
| `lan` — printer's local MQTT (`mqtts://<ip>:8883`, user `bblp`) | ✅ BAM-35 | ✅ | ✅ **only with Developer Mode on** (printer then can't use Bambu Cloud) | Printer IP + LAN access code |
| `sdk` — Bambu Local Server SDK | 🔭 planned | — | ✅ via Bambu's authorized API | SDK access (requested; Linux/ARM64 build needed) |

## Contract

A transport is an `EventEmitter` with this interface (`src/bambu/mqtt-client.js` implements it for both MQTT kinds):

- `kind`: `'cloud' | 'lan'` (later `'sdk'`)
- `connected`: boolean
- `mergedState`: the raw merged `push_status` (diagnostics only; never sent to clients unauthenticated)
- `connect()`, `destroy()`
- `sendPushall()`
- `sendCommandAwaitReply(cmd) → Promise<{ sent, acknowledged, result, reason }>`: never rejects
- events: `state(deviceId, normalizedState)`, `raw(deviceId, msg)`, `connected(deviceId)`, `disconnected(deviceId)`, `mqtt_error(deviceId, err)`

An SDK transport has to implement exactly this. The commands it receives are the same `print.*` command objects built in `src/bambu/commands.js`; the SDK adapter is responsible for mapping them to SDK API calls.

## Choosing a transport per printer

`printers.connection_mode`:
- `auto` (default): `lan` if an IP and access code are configured, otherwise `cloud`.
- `cloud`
- `lan`

LAN printers connect at startup and keep running **independently of the Bambu Cloud session**. Their monitoring and commands don't depend on a cloud token, so an expired token or a logout only affects cloud-transport printers. The dashboard UI itself still asks for a BambuLab login (a deliberate product choice, 2026-10-03). Printers that aren't on the account can be added by hand (serial, name, model, IP, access code).

## Capabilities

`GET /api/printers` includes `capabilities` for each printer, and the UI decides what to offer from it:

```
{ transport, connected, connectionMode, lanConfigured, developerMode,
  control: 'available' | 'signature_required' | 'unknown' | 'offline',
  controlHint }
```

`control` is derived from the transport plus the printer's own `print.fun` signature bit:

| Transport | Dev Mode | `control` |
|---|---|---|
| any | (not connected) | `offline` |
| `lan` | on | `available` |
| `lan` | off | `signature_required`: "turn on Developer Mode on the printer" |
| `cloud` | off | `signature_required`: "enable Developer Mode and connect over LAN, or use the Bambu SDK" |
| any | not reported (pre-2025 firmware) | `unknown`: commands are tried; a `verify failed` reply flips it to `signature_required` |

## LAN TLS

- **Certificate check:** printers present certificates issued by Bambu's device CAs. We verify the chain against Bambu's public CA bundle (`src/bambu/certs/`, from ha-bambulab, MIT), so a non-Bambu device can't impersonate a printer.
- **No hostname check:** printers are reached by IP and their certificates don't carry it.
- **TLS 1.2 maximum:** some P2S firmware never answers a TLS 1.3 ClientHello.
- **Unverified fallback:** `BAMBUZLE_LAN_TLS_VERIFY=off` exists only as an escape hatch for unknown future CAs, and logs a warning.

## Secrets

The LAN access code is stored in the SQLite DB, which is owner-only (0600), as are its backups. The API only ever reports `hasAccessCode` and never returns the code itself. Changing connection settings requires the admin token.
