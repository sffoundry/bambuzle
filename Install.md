# Installation

Bambuzle requires **Node.js 18+** and a C/C++ toolchain (needed to compile the `better-sqlite3` native module). Python 3.6+ is also required at build time by `node-gyp` (the Node.js native module compiler) — it is **not** a runtime dependency.

## Prerequisites by Platform

### Windows

1. Install [Node.js LTS](https://nodejs.org/) (v18 or later). During install, check **"Automatically install the necessary tools"** — this installs the Visual C++ Build Tools and Python for you.

   If you already have Node.js installed without build tools, install them separately:

   - Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select the **"Desktop development with C++"** workload
   - Install [Python 3](https://www.python.org/downloads/) (3.6 or later) if not already present

2. Install [Git for Windows](https://git-scm.com/download/win) if you don't have it.

3. Verify:

   ```powershell
   node --version   # v18.x or later
   npm --version
   git --version
   ```

### macOS / Linux

1. Install Node.js 18+ via your package manager or [nvm](https://github.com/nvm-sh/nvm):

   ```bash
   # nvm (recommended)
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   nvm install 20
   ```

   Or use your system package manager:

   ```bash
   # macOS (Homebrew)
   brew install node

   # Debian / Ubuntu
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs

   # Fedora
   sudo dnf install nodejs
   ```

2. Install the C/C++ toolchain and Python 3:

   ```bash
   # macOS — Xcode Command Line Tools (includes Python 3, make, clang)
   xcode-select --install

   # Debian / Ubuntu
   sudo apt install -y build-essential python3

   # Fedora
   sudo dnf groupinstall "Development Tools"
   sudo dnf install python3
   ```

3. Verify:

   ```bash
   node --version     # v18.x or later
   npm --version
   python3 --version  # 3.6 or later
   gcc --version      # or cc --version on macOS
   ```

### Raspberry Pi

Tested on Raspberry Pi 3B+ and newer (ARMv7/ARM64) running Raspberry Pi OS (Bookworm).

1. Install Node.js 20 via NodeSource:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2. Install build tools:

   ```bash
   sudo apt install -y build-essential python3
   ```

3. Verify:

   ```bash
   node --version   # v20.x
   npm --version
   ```

> **Note:** On a Pi 3B+, `npm install` may take several minutes while compiling `better-sqlite3`. This is normal.

## Install Bambuzle

These steps are the same on all platforms.

```bash
git clone https://github.com/sffoundry/bambuzle.git
cd bambuzle
npm install
```

If `npm install` fails with compiler errors, the C/C++ toolchain is missing or incomplete — see the prerequisites section for your platform above.

## Configure

```bash
cp .env.example .env
```

Edit `.env` with your BambuLab credentials:

```ini
# Option 1: Email + password login
BAMBU_EMAIL=your@email.com
BAMBU_PASSWORD=your_password

# Option 2: Direct token (if MFA is enabled, get token from BambuLab app)
# BAMBU_TOKEN=your_access_token
# BAMBU_USER_ID=your_user_id

BAMBU_REGION=us          # us, cn, or eu
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
```

You can also skip the `.env` file entirely and log in through the dashboard UI on first launch.

Optional tuning via `config.json` in the project root:

```json
{
  "sampling": {
    "activeIntervalSec": 5,
    "idleIntervalSec": 30
  },
  "retention": {
    "days": 90
  }
}
```

## Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

### Run on Startup (Raspberry Pi / Linux)

Create a systemd service:

```bash
sudo tee /etc/systemd/system/bambuzle.service > /dev/null <<'EOF'
[Unit]
Description=Bambuzle Printer Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/bambuzle
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable bambuzle
sudo systemctl start bambuzle
```

Adjust `User` and `WorkingDirectory` to match your setup.

### Run on Startup (Windows)

Use Task Scheduler or install as a service with [node-windows](https://github.com/coreybutler/node-windows), or simply add a shortcut to `npm start` in your Startup folder.

## Docker

Bambuzle ships a multi-stage `Dockerfile` (based on `node:20-bookworm-slim`, glibc) that runs on **linux/amd64** and **linux/arm64** (Raspberry Pi 4/5 on a 64-bit OS). No host Node.js or C/C++ toolchain is needed — `better-sqlite3` is built inside the image.

The container runs as the non-root `node` user (uid/gid **1000**), listens on port **3000**, and keeps all runtime state (`bambuzle.db` and its `-wal`/`-shm` files, plus the generated `admin-token`) in **`/data`**, which is declared as a volume (`BAMBUZLE_DATA_DIR=/data`).

### Build

```bash
git clone https://github.com/sffoundry/bambuzle.git
cd bambuzle
docker build -t bambuzle .
```

### Run

```bash
mkdir -p data
docker run -d --name bambuzle \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v "$PWD/data:/data" \
  bambuzle
```

`--env-file .env` is optional — without credentials the dashboard starts and waits for you to log in through the UI. Open **http://localhost:3000**.

> **Bind-mount permissions:** the container writes to `/data` as uid 1000. If your host user is not uid 1000 (check with `id -u`), either `sudo chown 1000:1000 data`, or run the container as your own user with `--user "$(id -u):$(id -g)"` (Compose: add a `user: "<uid>:<gid>"` line to the service). A Docker named volume (`-v bambuzle-data:/data`) avoids the issue entirely.

`config.json` tuning is read from the app root, not `/data`; mount it read-only if you use one: `-v "$PWD/config.json:/app/config.json:ro"`.

### Docker Compose

```bash
cp compose.example.yaml compose.yaml
cp .env.example .env      # optional: BambuLab credentials, LOG_LEVEL, ...
mkdir -p data
docker compose up -d --build
docker compose logs -f bambuzle
```

`compose.example.yaml` defines a single `bambuzle` service with `./data:/data` (or a named volume — see the comments), `env_file: .env`, `restart: unless-stopped` and port 3000. The `.env` file is marked optional (`required: false`, Compose 2.24+).

### Dashboard auth (optional env vars)

These are listed (commented out) in `compose.example.yaml`; add them to `.env` or the `environment:` block:

| Variable | Effect |
|----------|--------|
| `BAMBUZLE_ADMIN_TOKEN` | Fixed admin token. If unset, the server generates one into `/data/admin-token` on first start and logs it. |
| `BAMBUZLE_AUTH=off` | Disable dashboard auth (trusted networks only). |
| `BAMBUZLE_PUBLIC_READ=true` | Allow unauthenticated read-only viewing. |

Find the generated token with `docker compose logs bambuzle | grep -i token`, or read it from the data volume (`cat data/admin-token` for the bind mount).

### Health check

The image has a built-in `HEALTHCHECK` (Node's built-in `fetch`, no curl) against `GET /api/spec`. Check it with:

```bash
docker inspect -f '{{.State.Health.Status}}' bambuzle   # starting -> healthy
```

### Backup and upgrade

SQLite runs in WAL mode, so copy the data only while the container is stopped:

```bash
docker compose stop bambuzle
cp -a data "data-backup-$(date +%F)"        # named volume: docker run --rm -v bambuzle-data:/data -v "$PWD":/backup debian:bookworm-slim tar czf /backup/bambuzle-data.tgz -C /data .
docker compose start bambuzle
```

To upgrade: `git pull && docker compose up -d --build`. Data in `/data` is preserved; schema migrations run automatically on start.

### Multi-arch builds (amd64 + arm64)

Building directly on a Raspberry Pi 4/5 (64-bit OS) just works with `docker build`. To build both architectures from one machine, use Buildx (with QEMU emulation registered, e.g. `docker run --privileged --rm tonistiigi/binfmt --install arm64`):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/bambuzle:latest --push .
```

A multi-platform build must be pushed to a registry (or exported with `--output`); use `--platform linux/arm64 --load` to load a single-arch image locally. Emulated arm64 builds compile `better-sqlite3` slowly if no prebuilt binary matches — expect several minutes. 32-bit Pi OS (armv7) is not a tested target.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails with `gyp ERR!` | Missing C/C++ build tools — see prerequisites above |
| `EADDRINUSE` on startup | Another process is using port 3000. Change `PORT` in `.env` or stop the other process |
| `better-sqlite3` crashes on ARM | Make sure you're on Node.js 18+ and have `build-essential` installed, then `npm rebuild better-sqlite3` |
| Docker: container exits with `unable to open database file` or `EACCES` on `/data` | Bind-mounted dir isn't writable by uid 1000 — `chown 1000:1000 data` or run with `--user "$(id -u):$(id -g)"` (see Docker section) |
| Dashboard shows login but printers don't appear | Check `.env` credentials and `BAMBU_REGION`. Look at the server console for auth errors |
