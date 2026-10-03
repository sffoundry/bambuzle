# Bambu Lab printer CA certificates

`bambu-ca-bundle.pem` holds Bambu Lab's **public** CA certificates (BBL CA, BBL CA2 RSA/ECC, and the device CAs for newer models). Bambuzle uses them to verify a printer's TLS certificate on LAN MQTT connections (`mqtts://<printer-ip>:8883`).

Source: [greghesp/ha-bambulab](https://github.com/greghesp/ha-bambulab), `custom_components/bambu_lab/pybambu/certs/`, files `bambu.cert`, `bambu_h2c_251122.cert`, `bambu_p2s_250626.cert` and `bambu_x2c_260425.cert`. MIT License, Copyright (c) 2023 ha-bambulab contributors. Retrieved 2026-10-03.

These are CA certificates only: no private keys and no signing material. If Bambu ships a printer whose certificate chains to a new CA, add that CA here. `BAMBUZLE_LAN_TLS_VERIFY=off` is a temporary escape hatch.
