// Gera o .env e o livekit/livekit.yaml com chaves aleatórias e baixa o servidor LiveKit se faltar.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const livekitDir = resolve(root, 'livekit');
const LIVEKIT_VERSION = '1.13.10';

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

let env;
if (existsSync(envPath)) {
  env = parseEnv(readFileSync(envPath, 'utf8'));
  console.log('.env já existe, mantendo as configurações.');
} else {
  env = {
    PORT: '666',
    INVITE_CODE: randomBytes(4).toString('hex'),
    LIVEKIT_API_KEY: `API${randomBytes(6).toString('hex')}`,
    LIVEKIT_API_SECRET: randomBytes(24).toString('base64url'),
    LIVEKIT_URL: '',
    LIVEKIT_LOCAL: 'true',
  };
  writeFileSync(
    envPath,
    `# Porta do site
PORT=${env.PORT}

# Código que seus amigos precisam para criar conta (deixe vazio para liberar cadastro).
INVITE_CODE=${env.INVITE_CODE}

# Credenciais do LiveKit (servidor de voz/vídeo).
# Para usar o LiveKit Cloud, troque pelas chaves do seu projeto e defina LIVEKIT_LOCAL=false.
LIVEKIT_API_KEY=${env.LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${env.LIVEKIT_API_SECRET}

# Endereço do LiveKit que os navegadores usam (ex.: wss://meuprojeto.livekit.cloud).
# Vazio = ws://<mesmo host do site>:7880 (bom para testes locais e rede local/Tailscale).
LIVEKIT_URL=${env.LIVEKIT_URL}

# true = o servidor inicia o LiveKit local da pasta livekit/ automaticamente.
LIVEKIT_LOCAL=${env.LIVEKIT_LOCAL}
`,
  );
  console.log(`.env criado. Código de convite: ${env.INVITE_CODE}`);
}

mkdirSync(livekitDir, { recursive: true });
writeFileSync(
  resolve(livekitDir, 'livekit.yaml'),
  `# Gerado por scripts/setup.mjs a partir do .env
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${env.LIVEKIT_API_KEY}: ${env.LIVEKIT_API_SECRET}
logging:
  level: warn
`,
);
console.log('livekit/livekit.yaml atualizado.');

const exeName = process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
if (!existsSync(resolve(livekitDir, exeName))) {
  if (process.platform !== 'win32') {
    console.log('Baixe o livekit-server para o seu sistema em https://github.com/livekit/livekit/releases e coloque em livekit/.');
  } else {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_windows_${arch}.zip`;
    console.log(`Baixando LiveKit ${LIVEKIT_VERSION}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao baixar ${url}: ${res.status}`);
    const zip = resolve(livekitDir, 'livekit.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${livekitDir}'`]);
    rmSync(zip);
    console.log('LiveKit baixado.');
  }
}
