# DRAFT: Bambu Lab Local Server SDK access request

> **Status:** draft for Steve/Francisco to review and submit. Claude did not send this anywhere.
> **Submit via:** the SDK access form linked from https://wiki.bambulab.com/en/software/third-party-integration ("Apply for SDK Access", needs a Bambu Lab account). Optionally also email devpartner@bambulab.com.
> **Fill in before sending:** `[contact name]`, `[email]`, `[Bambu account email]`, `[company/org]`, and the printer list if the form asks.

---

**Subject:** SDK access request: Bambuzle (self-hosted printer monitoring), requesting the Linux x86_64 + ARM64 build

Hello Bambu Lab developer partnerships team,

We maintain **Bambuzle** (https://github.com/sffoundry/bambuzle), an open-source, self-hosted monitoring dashboard for Bambu Lab printers. It runs headless on Linux, typically in a Docker container on a small home server or a Raspberry Pi 4/5. It gives single operators and small print farms:
- a real-time dashboard;
- historical telemetry, print statistics and maintenance tracking;
- HMS alerts with links to your wiki;
- notifications.

It uses the status data your authorization framework leaves open (MQTT status push), and it already works with X1C, H2D, P1 and A1-series printers.

**Why we are applying.** Our users want to take basic actions from the same dashboard when an alert fires: pause, resume, stop, and adjust print speed. With the authorization firmware those commands are rightly rejected unless they come through an authorized channel. We confirmed this on an H2D: an unsigned `print_speed` command returned `mqtt message verify failed`. We would like to support control **the authorized way**. We will not use extracted or unofficial credentials.

**Why Bambu Connect and Developer Mode don't fully cover our use case:**
- **Bambu Connect** is an interactive desktop application, and its documented integration is the `import-file` URL scheme. Bambuzle is a headless server process with no desktop session, and it needs status and control rather than file import.
- **Developer Mode** works, and we will support it for users who choose it. But it requires taking printers off Bambu Cloud entirely. Most of our users want to keep cloud features (Handy, remote access) and still monitor and control from a self-hosted dashboard.

**What we are requesting:**
1. Access to the **Bambu Local Server SDK**, specifically to work on, or beta-test, the **Linux pathway: x86_64 and ARM64 (aarch64)**. Our deployment targets are Linux containers and Raspberry Pi-class ARM64 boards. A Windows-only component isn't viable for us; our users run headless Linux servers. Your wiki lists Linux and ARM64 support as in development, and we would be glad to be an early Linux/ARM64 integration partner and give structured feedback.
2. Use of these API areas:
   - **Printer status monitoring:** print status, HMS alerts, printer errors, and snapshots if available.
   - **Printer control:** pause, resume, stop, print speed.
   - **Later, possibly:** file upload / print task for queueing. Not in our first integration.
3. Guidance on **licensing and distribution** for an open-source project. Can our users download the SDK component separately (for example, a container image or binary fetched at install time under your license) while Bambuzle stays open source? We will follow whatever distribution model you require.

**What we will commit to:**
- **Commands only through the SDK:** all control goes through the SDK's authorized interface. No signing material is extracted, logged or redistributed.
- **Operator access control:** control actions require an admin-authenticated operator in Bambuzle. That's already in place: token auth on every API route, an audit log of every command attempt, state checks that block stale or duplicate commands, and a confirmation step for destructive actions.
- **Load:** we will respect any rate limits, connection limits or usage policies you set. We already keep cloud MQTT connections to one per printer.
- **Testing:** we have X1C, H2D and A1 mini printers available.

**About us:** `[company/org]`, `[contact name]`, `[email]`, Bambu account `[Bambu account email]`.

Thank you. We are happy to join a call or provide more detail about the architecture.

---

## Notes for Steve (not part of the request)
- Bambu's wiki says the Local Server SDK currently runs on **Windows 10+ x86-64 only**. Linux and ARM64 are "in development", with no date published. The request leans into that: it asks to be a Linux/ARM64 early partner and explicitly rules out a Windows hop.
- We don't know the review timeline or terms (NDA, licence). Point 3 asks directly how an open-source project may ship with it.
- Bambuzle is being structured so an SDK transport can be added alongside the cloud and LAN transports without changing the rest of the app (see BAM-35 in `ROADMAP.md`).
