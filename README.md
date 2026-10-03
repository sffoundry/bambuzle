# Bambuzle

Self-hosted monitoring dashboard for BambuLab 3D printers. Connects to BambuLab Cloud via MQTT, stores telemetry in SQLite, and serves a real-time web dashboard.

## Features

- Real-time printer status cards (temps, progress, fans, ETA)
- Historical temperature and progress charts
- Event log with sorting and filtering
- Configurable alert rules — webhook (generic/Slack/Discord), ntfy, Pushover, Telegram
- Multi-printer support
- H2D dual-nozzle support
- Printer diagnostics: nozzle, firmware updates, AI-monitor settings, SD card, AMS humidity, print errors
- Full HMS error dictionary (5,000+ codes) with Bambu wiki links
- Print job statistics (success rate, print hours, by printer and material)
- Admin-token protected dashboard and API
- Docker image, health/readiness probes, automatic verified backups, Prometheus `/metrics`

## Quick Start

Requires **Node.js 18+** and a C/C++ toolchain (for compiling `better-sqlite3`). See [Install.md](Install.md) for details.

```bash
git clone https://github.com/sffoundry/bambuzle.git
cd bambuzle
npm install
cp .env.example .env   # edit with your BambuLab credentials
npm start
```

Open **http://localhost:3000**

Prefer containers? `cp compose.example.yaml compose.yaml && docker compose up -d --build` — see [Install.md § Docker](Install.md#docker) (amd64 + arm64/Raspberry Pi 4/5).

See [Install.md](Install.md) for detailed platform-specific instructions (Windows, macOS/Linux, Raspberry Pi).

## Documentation

- [Install.md](Install.md) — installation and configuration
- [Export data dictionary](docs/export-data-dictionary.md) — columns of the Stats view's CSV/JSON job export
- [Wiki](https://github.com/sffoundry/bambuzle/wiki) — release notes and project documentation

## License

ISC
