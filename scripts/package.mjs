import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join('release', 'Xiangqi-win32-x64');

// Windows 上刚关闭的 exe/资源管理器会短暂持有目录句柄，首删常报 EPERM；短暂重试即可。
function resetReleaseDir() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync('release', { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
resetReleaseDir();

cpSync(join('node_modules', 'electron', 'dist'), out, { recursive: true });
rmSync(join(out, 'resources', 'default_app.asar'), { recursive: true, force: true });
renameSync(join(out, 'electron.exe'), join(out, 'Xiangqi.exe'));

const appDir = join(out, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'Xiangqi',
      productName: 'Xiangqi',
      version: '0.1.0',
      main: 'dist-electron/main.cjs',
    },
    null,
    2,
  ),
  'utf8',
);
cpSync('dist-electron', join(appDir, 'dist-electron'), { recursive: true });
cpSync('dist-ui', join(appDir, 'dist-ui'), { recursive: true });

for (const file of [
  'Pikafish-Windows-x86-64-universal.exe',
  'pikafish.nnue',
  'config.json',
  'NNUE权重协议（使用视为同意本协议）_NNUE License.txt',
  'AI引擎介绍_AI Engine Introduction.txt',
  '作者&算力贡献_Authors&Contributor.txt',
]) {
  if (!existsSync(file)) throw new Error(`缺少打包资源：${file}`);
  cpSync(file, join(out, 'resources', file));
}

console.log(`打包完成：${join(out, 'Xiangqi.exe')}`);