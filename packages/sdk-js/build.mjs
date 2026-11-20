// Builds ESM, CJS and a minified IIFE (window.GeeksFraud) and prints the SRI hash
// gateways paste into their PCI DSS 6.4.3 script inventory (FR-101, NFR-11).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const common = { entryPoints: ['src/index.ts'], bundle: true, target: 'es2018', legalComments: 'none' };
mkdirSync('dist', { recursive: true });
await build({ ...common, format: 'esm', outfile: 'dist/geeksfraud.mjs' });
await build({ ...common, format: 'cjs', outfile: 'dist/geeksfraud.cjs', platform: 'neutral' });
await build({ ...common, format: 'iife', globalName: 'GeeksFraud', minify: true, outfile: 'dist/geeksfraud.min.js' });
execFileSync('../../node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' });

const min = readFileSync('dist/geeksfraud.min.js');
const gz = gzipSync(min).length;
const sri = 'sha384-' + createHash('sha384').update(min).digest('base64');
const manifest = { version: JSON.parse(readFileSync('package.json', 'utf8')).version, bytes: min.length, gzip_bytes: gz, integrity: sri };
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));

console.log(manifest);
if (gz > 25 * 1024) {
  console.error(`Bundle ${gz} B gzipped exceeds the 25 KB budget (FR-110)`);
  process.exit(1);
}
