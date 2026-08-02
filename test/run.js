// Runner de tests: ejecuta cada test/test_*.js en serie (comparten test.db) y
// reporta un resumen. Sale con código 1 si alguno falla (para CI).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => /^test_.*\.js$/.test(f)).sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(f.padEnd(28));
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log('PASS');
  } else {
    failed++;
    console.log('FAIL');
    process.stdout.write((r.stdout || '') + (r.stderr || '') + '\n');
  }
}

console.log(`\n${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
