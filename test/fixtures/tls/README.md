# Test TLS material

A throwaway CA and a "printer" certificate (`CN=01S00TEST000001`, a fake serial) used only by the
FTPS/TLS tests (`test/printer-files.test.js`). The CA private key was deleted after signing, so nothing
new can be issued from it. The printer key is test-only and is trusted nowhere outside these tests.
