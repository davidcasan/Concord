import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'server', 'dist');
const clientDist = resolve(root, 'client', 'dist');
const livekitExe = resolve(root, 'livekit', 'livekit-server.exe');
const entry = resolve(root, 'server', 'src', 'sea-entry.cjs');
const nodeExe = process.execPath;
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('A geração dos executáveis Concord requer Windows x64.');
}
if (!existsSync(clientDist) || !existsSync(livekitExe)) {
  throw new Error('Interface ou livekit-server.exe não encontrado. Compile a interface e rode npm run setup.');
}

const files = [];
function collect(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, item.name);
    if (item.isDirectory()) collect(absolutePath);
    else files.push(absolutePath);
  }
}
collect(clientDist);
files.push(livekitExe, resolve(root, 'livekit', 'LICENSE'));

const manifest = files.map((absolutePath, index) => {
  const file = relative(root, absolutePath).replaceAll('\\', '/');
  return { key: `asset-${index}`, file };
});
const assetHash = createHash('sha256');
for (const file of files) {
  assetHash.update(relative(root, file).replaceAll('\\', '/'));
  assetHash.update(readFileSync(file));
}
const assetVersion = `${version}-${assetHash.digest('hex')}`;

const temporaryDir = mkdtempSync(join(tmpdir(), 'concord-server-sea-'));
try {
  const bundledEntry = join(temporaryDir, 'server.cjs');
  const manifestPath = join(temporaryDir, 'asset-manifest.json');
  const seaConfigPath = join(temporaryDir, 'sea-config.json');
  const seaBlobPath = join(temporaryDir, 'sea.blob');
  const executablePath = join(outputDir, 'Concord Server Core.exe');
  const assets = Object.fromEntries(manifest.map(({ key }, index) => [key, files[index]]));
  assets['asset-manifest'] = manifestPath;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundledEntry,
    define: { __MINICORD_ASSET_VERSION__: JSON.stringify(assetVersion) },
  });
  writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: bundledEntry, output: seaBlobPath, assets, disableExperimentalSEAWarning: true }),
  );
  execFileSync(nodeExe, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
  mkdirSync(outputDir, { recursive: true });
  cpSync(nodeExe, executablePath);
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules', 'postject', 'dist', 'cli.js'),
      executablePath,
      'NODE_SEA_BLOB',
      seaBlobPath,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts', 'build-server-manager.ps1')],
    { stdio: 'inherit' },
  );
  console.log(`Núcleo e painel Concord Server gerados em ${outputDir} (${version}).`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
