# Bambuzle

Self-hosted monitoring dashboard for BambuLab 3D printers. Connects to BambuLab Cloud via MQTT, stores telemetry in SQLite, and serves a real-time web dashboard.

## Features

- Real-time printer status cards (temps, progress, fans, ETA)
- Historical temperature and progress charts
- Event log with sorting and filtering
- Configurable alert rules
- Multi-printer support
- H2D dual-nozzle support

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

See [Install.md](Install.md) for detailed platform-specific instructions (Windows, macOS/Linux, Raspberry Pi).

## Documentation

- [Install.md](Install.md) — installation and configuration
- [Wiki](https://github.com/sffoundry/bambuzle/wiki) — release notes and project documentation

## License

ISC
