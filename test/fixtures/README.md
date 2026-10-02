# Test fixtures

`push-*.json` are trimmed `push_status` payloads derived from the mock data in
[greghesp/ha-bambulab](https://github.com/greghesp/ha-bambulab) (`custom_components/bambu_lab/pybambu/mock_data/`, MIT License,
Copyright (c) 2023 ha-bambulab contributors), retrieved 2026-10-02. Only the fields used by `src/bambu/diagnostics.js` are kept;
camera `rtsp_url` is removed.
