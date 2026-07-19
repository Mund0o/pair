const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync('cmd', ['/c', path.join(__dirname, 'addon', 'build-native.bat')], {
  cwd: path.join(__dirname, 'addon'),
  stdio: 'inherit',
  shell: true
});
if (r.status !== 0) {
  console.error('Addon build failed with code', r.status);
  process.exit(r.status);
}
console.log('Addon rebuilt successfully');
