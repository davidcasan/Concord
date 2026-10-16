const { randomBytes } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getAsset, isSea } = require('node:sea');

if (!isSea()) throw new Error('Este inicializador só pode ser executado dentro do Concord Server Core.');

const home = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const root = path.join(home, 'Concord Server');
const legacyRoot = path.join(home, 'Minicord Server');
if (existsSync(legacyRoot)) {
  if (!existsSync(root)) {
    renameSync(legacyRoot, root);
  } else {
    for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
      const source = path.join(legacyRoot, entry.name);
      const destination = path.join(root, entry.name);
      if (!existsSync(destination)) cpSync(source, destination, { recursive: true, force: false });
    }
  }
}
process.env.MINICORD_HOME = root;
mkdirSync(root, { recursive: true });

const assetVersion = __MINICORD_ASSET_VERSION__;
const markerPath = path.join(root, '.assets-version');
const manifest = JSON.parse(getAsset('asset-manifest', 'utf8'));
if (
  !existsSync(markerPath) ||
  readFileSync(markerPath, 'utf8') !== assetVersion ||
  manifest.some(({ file }) => !existsSync(path.join(root, file)))
) {
  for (const { key, file } of manifest) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from(getAsset(key)));
  }
  writeFileSync(markerPath, assetVersion);
}

const envPath = path.join(root, '.env');
if (!existsSync(envPath)) {
  const inviteCode = randomBytes(4).toString('hex');
  const apiKey = `API${randomBytes(6).toString('hex')}`;
  const apiSecret = randomBytes(24).toString('base64url');
  writeFileSync(
    envPath,
    `PORT=${process.env.PORT || '666'}\nINVITE_CODE=${inviteCode}\nLIVEKIT_API_KEY=${apiKey}\nLIVEKIT_API_SECRET=${apiSecret}\nLIVEKIT_URL=\nLIVEKIT_LOCAL=true\n`,
  );
  console.log(`Configuração inicial criada. Código de convite: ${inviteCode}`);
}

process.loadEnvFile(envPath);
process.env.PORT ||= '666';
process.env.LIVEKIT_LOCAL ||= 'true';

const livekitDir = path.join(root, 'livekit');
mkdirSync(livekitDir, { recursive: true });
writeFileSync(
  path.join(livekitDir, 'livekit.yaml'),
  `port: 7880\nrtc:\n  tcp_port: 7881\n  port_range_start: 50000\n  port_range_end: 50100\n  use_external_ip: true\nkeys:\n  ${process.env.LIVEKIT_API_KEY}: ${process.env.LIVEKIT_API_SECRET}\nlogging:\n  level: warn\n`,
);

require('./index.js');
