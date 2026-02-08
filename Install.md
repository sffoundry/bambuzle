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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails with `gyp ERR!` | Missing C/C++ build tools — see prerequisites above |
| `EADDRINUSE` on startup | Another process is using port 3000. Change `PORT` in `.env` or stop the other process |
| `better-sqlite3` crashes on ARM | Make sure you're on Node.js 18+ and have `build-essential` installed, then `npm rebuild better-sqlite3` |
| Dashboard shows login but printers don't appear | Check `.env` credentials and `BAMBU_REGION`. Look at the server console for auth errors |
