/**
 * prepare-app-server.cjs — Electron 패키징용 app-server package.json 생성
 *
 * 루트 package.json에서 dependencies만 추출하여
 * build/app-server-pkg/에 npm install 가능한 최소 package.json + package-lock.json 복사.
 * playwright는 서버 내 lazy-install이므로 optional로 처리.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'app-server-pkg');

fs.mkdirSync(OUT_DIR, { recursive: true });

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

const serverPkg = {
  name: 'agentsalad-server',
  version: rootPkg.version || '0.0.0',
  private: true,
  type: 'module',
  dependencies: { ...rootPkg.dependencies },
};

delete serverPkg.dependencies['playwright'];

fs.writeFileSync(
  path.join(OUT_DIR, 'package.json'),
  JSON.stringify(serverPkg, null, 2) + '\n',
);

const lockSrc = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockSrc)) {
  fs.copyFileSync(lockSrc, path.join(OUT_DIR, 'package-lock.json'));
}

console.log(`[prepare-app-server] Created ${OUT_DIR}/package.json`);
console.log(`  dependencies: ${Object.keys(serverPkg.dependencies).length} packages`);
