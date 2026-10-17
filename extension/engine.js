// Claude engine management: the bundled Agent SDK + Claude Code binary, plus background
// auto-updates from npm so new models, commands and features arrive without reinstalling.
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const BIN_PKG = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

class Engine {
  constructor(extensionPath, storageDir, log) {
    this.extensionPath = extensionPath;
    this.dir = path.join(storageDir, 'engine');
    this.log = log || (() => {});
    this.active = this.resolve();
  }

  bundled() {
    const nm = path.join(this.extensionPath, 'node_modules');
    const version = JSON.parse(fs.readFileSync(path.join(nm, SDK_PKG, 'package.json'), 'utf8')).version;
    return { version, sdk: path.join(nm, SDK_PKG, 'sdk.mjs'), exe: path.join(nm, BIN_PKG, EXE), bundled: true };
  }

  installed() {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(this.dir, 'current.json'), 'utf8'));
      const root = path.join(this.dir, cur.version);
      const e = { version: cur.version, sdk: path.join(root, 'sdk', 'package', 'sdk.mjs'), exe: path.join(root, 'bin', 'package', EXE), bundled: false };
      return fs.existsSync(e.sdk) && fs.existsSync(e.exe) ? e : null;
    } catch { return null; }
  }

  // Newest of bundled vs downloaded.
  resolve() {
    const b = this.bundled(), i = this.installed();
    return i && cmpVersion(i.version, b.version) > 0 ? i : b;
  }

  // Checks npm for a newer engine; downloads, verifies and stages it. Returns the new version or null.
  async update() {
    const meta = await getJson(`https://registry.npmjs.org/${SDK_PKG.replace('/', '%2F')}/latest`);
    const latest = meta.version;
    if (cmpVersion(latest, this.resolve().version) <= 0) return null;
    const binVersion = meta.optionalDependencies?.[BIN_PKG];
    if (!binVersion) throw new Error(`No ${BIN_PKG} for ${latest}`);
    const binMeta = await getJson(`https://registry.npmjs.org/${BIN_PKG.replace('/', '%2F')}/${binVersion}`);

    const root = path.join(this.dir, latest);
    const tmp = root + '.partial';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'sdk'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
    this.log(`Downloading Claude engine ${latest}…`);
    await fetchAndExtract(meta.dist.tarball, meta.dist.integrity, path.join(tmp, 'sdk'));
    await fetchAndExtract(binMeta.dist.tarball, binMeta.dist.integrity, path.join(tmp, 'bin'));
    const exe = path.join(tmp, 'bin', 'package', EXE);
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    const out = await run(exe, ['--version']);
    if (!out.ok) throw new Error('New engine failed its self-check: ' + out.stderr.slice(0, 200));
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(tmp, root);
    fs.writeFileSync(path.join(this.dir, 'current.json'), JSON.stringify({ version: latest, installed: Date.now() }));
    this.cleanup(latest);
    this.log(`Claude engine ${latest} ready (${out.stdout.trim()})`);
    return latest;
  }

  cleanup(keep) {
    try {
      for (const d of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, d);
        if (d !== keep && d !== 'current.json' && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'nebula-ide' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(res.headers.location, redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    }).on('error', reject);
  });
}
async function getJson(url) { return JSON.parse((await get(url)).toString('utf8')); }

async function fetchAndExtract(url, integrity, dest) {
  const buf = await get(url);
  if (integrity) {
    const [algo, expected] = integrity.split('-');
    const actual = require('crypto').createHash(algo).update(buf).digest('base64');
    if (actual !== expected) throw new Error('Integrity check failed for ' + url);
  }
  const file = path.join(dest, 'pkg.tgz');
  fs.writeFileSync(file, buf);
  const r = await run(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xzf', file, '-C', dest]);
  fs.rmSync(file, { force: true });
  if (!r.ok) throw new Error('Extract failed: ' + r.stderr.slice(0, 200));
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err?.message || '') })));
}

module.exports = { Engine, cmpVersion };
