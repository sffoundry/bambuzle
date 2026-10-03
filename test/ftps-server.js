'use strict';

// Minimal implicit-FTPS server for tests (control + PASV data over TLS). Implements just what
// basic-ftp uses: USER/PASS/TYPE/PBSZ/PROT/OPTS/FEAT/EPSV/PASV/LIST/MLSD/SIZE/RETR/QUIT.

const tls = require('tls');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'fixtures', 'tls');
const KEY = fs.readFileSync(path.join(dir, 'printer.key'));
const CERT = fs.readFileSync(path.join(dir, 'printer.pem'));
const CA = fs.readFileSync(path.join(dir, 'test-ca.pem'));

/**
 * @param {object} o
 * @param {string} o.password — accepted access code
 * @param {object} o.tree — { '/timelapse': [{ name, size, data }], ... }
 */
async function startFtpsServer({ password, tree }) {
  const sockets = new Set();
  const logins = [];
  const server = tls.createServer({ key: KEY, cert: CERT }, (ctrl) => {
    sockets.add(ctrl);
    ctrl.on('close', () => sockets.delete(ctrl));
    let user = null;
    let authed = false;
    let pasv = null; // { server, next: Promise<socket> }
    const reply = (s) => ctrl.write(`${s}\r\n`);
    const openPasv = async () => {
      if (pasv) pasv.server.close();
      const ds = tls.createServer({ key: KEY, cert: CERT });
      const next = new Promise((resolve) => ds.once('secureConnection', resolve));
      await new Promise((r) => ds.listen(0, '127.0.0.1', r));
      pasv = { server: ds, next };
      return ds.address().port;
    };
    const withData = async (fn) => {
      if (!pasv) return reply('425 Use PASV first');
      reply('150 Opening data connection');
      const sock = await pasv.next;
      await fn(sock);
      sock.end();
      pasv.server.close();
      pasv = null;
      reply('226 Transfer complete');
    };
    const fileAt = (p) => {
      const d = path.posix.dirname(p);
      return (tree[d] || []).find((f) => f.name === path.posix.basename(p));
    };
    reply('220 Test FTPS');
    let buf = '';
    ctrl.on('data', async (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (cmd.toUpperCase()) {
          case 'USER': user = arg; reply('331 Password required'); break;
          case 'PASS': logins.push({ user, pass: arg });
            if (user === 'bblp' && arg === password) { authed = true; reply('230 Logged in'); } else reply('530 Login incorrect');
            break;
          case 'FEAT': reply('211 End'); break;
          case 'OPTS': case 'TYPE': case 'PBSZ': case 'PROT': reply('200 OK'); break;
          case 'EPSV': reply('502 Not implemented'); break;
          case 'PASV': { const port = await openPasv(); reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`); break; }
          case 'MLSD': reply('502 Not implemented'); break;
          case 'LIST': {
            if (!authed) { reply('530 Not logged in'); break; }
            const d = (arg.replace(/^-a\s*/, '') || '/').replace(/\/$/, '') || '/';
            if (!tree[d]) { reply('550 No such directory'); break; }
            await withData(async (s) => {
              for (const f of tree[d]) s.write(`-rw-r--r-- 1 root root ${f.size ?? f.data.length} Oct 01 12:00 ${f.name}\r\n`);
            });
            break;
          }
          case 'SIZE': { const f = fileAt(arg); if (f) reply(`213 ${f.data.length}`); else reply('550 Not found'); break; }
          case 'RETR': { const f = fileAt(arg); if (!f) { reply('550 Not found'); break; } await withData(async (s) => { s.write(f.data); }); break; }
          case 'QUIT': reply('221 Bye'); ctrl.end(); break;
          default: reply('502 Not implemented');
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    ca: CA.toString(),
    logins,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

module.exports = { startFtpsServer };
