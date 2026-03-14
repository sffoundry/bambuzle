# Bambuzle Roadmap Research — Live Camera Feed

> **Date:** 2026-03-14

## Summary

| Focus | Recommendation |
|---|---|
| Scope | Treat camera work as LAN-only streaming infrastructure, not just a UI card |
| First slice | P1/A1 support first, with a clean proxy boundary and print-active gating |
| Risk | The custom camera protocols and self-signed TLS path can destabilize the server if bolted in casually |

## Recommendation

- Build a dedicated camera-proxy path and only render it while a job is active.
- Start with the P1/A1 path because that is the harder custom protocol.
- Keep X1 RTSPS support behind the same endpoint contract.

## Sources

- `ROADMAP.md:5`
