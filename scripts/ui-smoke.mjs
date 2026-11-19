import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const shots = 'docs/screenshots';
mkdirSync(shots, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.XIANGQI_SMOKE = '1';

const packagedExe = process.env.XIANGQI_EXE;
const app = await electron.launch({
  executablePath: packagedExe ?? 'node_modules/electron/dist/electron.exe',
  args: packagedExe ? [] : ['.'],
  env,
});

try {
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[renderer error]', message.text());
  });
  await page.waitForLoadState('domcontentloaded');

  const panelOpen = () => page.locator('.controls').isVisible();
  const openPanel = async () => {
    if (!(await panelOpen())) await page.locator('#toggle-panel').click();
    await page.waitForTimeout(150);
  };

  await page.waitForFunction(
    () => document.getElementById('engine')?.textContent?.includes('就绪'),
    undefined,
    { timeout: 30000 },
  );
  console.log('引擎状态：', await page.locator('#engine').textContent());

  const boards = await page.locator('#board').count();
  const pieces = await page.locator('#board g.piece').count();
  console.log('棋盘数量：', boards, '棋子数量：', pieces);
  if (boards !== 1) throw new Error('棋盘不是唯一的');
  if (pieces !== 32) throw new Error(`初始棋子应为 32，实际 ${pieces}`);

  await page.evaluate(() => {
    document.querySelectorAll('#board g.piece').forEach((node) => {
      node.setAttribute('data-mark', 'keep');
    });
  });

  const panelInitial = await page.locator('.controls').isVisible();
  await page.locator('#toggle-panel').click();
  await page.waitForTimeout(200);
  const panelShown = await page.locator('.controls').isVisible();
  const boardWithPanel = await page.locator('#board').boundingBox();
  await page.locator('#toggle-panel').click();
  await page.waitForTimeout(200);
  const panelClosed = await page.locator('.controls').isVisible();
  console.log('菜单默认隐藏/打开/关闭：', !panelInitial, panelShown, !panelClosed);
  if (panelInitial || !panelShown || panelClosed) throw new Error('菜单显隐异常');
  if (!boardWithPanel || boardWithPanel.width < 240) throw new Error('棋盘未铺满窗口');

  const windowInfo = await app.evaluate(({ BrowserWindow, screen }) => {
    const [win] = BrowserWindow.getAllWindows();
    return {
      bounds: win.getBounds(),
      area: screen.getPrimaryDisplay().workArea,
      resizable: win.isResizable(),
      maximized: win.isMaximized(),
    };
  });
  console.log('窗口状态：', JSON.stringify(windowInfo));
  const { bounds, area } = windowInfo;
  if (bounds.x <= area.x + area.width / 2 || bounds.y <= area.y + area.height / 2) {
    throw new Error('窗口未位于屏幕右下角');
  }

  const before = await page.locator('#board').boundingBox();
  const sizeBefore = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  const resized = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const start = win.getBounds();
    win.setResizable(true);
    win.setBounds({ x: start.x, y: start.y, width: 260, height: 320 });
    return win.getBounds();
  });
  console.log('窗口尺寸设置：', JSON.stringify(resized));
  await page.waitForTimeout(900);
  const sizeAfter = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  console.log('窗口可用尺寸：', sizeBefore, '->', sizeAfter);
  const after = await page.locator('#board').boundingBox();
  console.log('窗口缩放前后棋盘尺寸：', before, '->', after);
  if (!before || !after || after.width * after.height >= before.width * before.height) {
    throw new Error('窗口缩放未生效');
  }
  await page.screenshot({ path: `${shots}/gui-compact.png` });
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0].setBounds(bounds);
  }, windowInfo.bounds);
  await page.waitForTimeout(400);

  await page.waitForFunction(
    () => (document.getElementById('eval-score')?.textContent ?? '') !== '评估中',
    undefined,
    { timeout: 30000 },
  );
  console.log('初始实时评分：', await page.locator('#eval-score').textContent());

  await page.locator('.hits rect[data-df="1"][data-dr="9"]').click();
  await page.locator('.hits rect[data-df="2"][data-dr="7"]').click();

  await page.waitForFunction(
    () => {
      const row = document.querySelector('#move-list .move-row');
      return !!row && (row.children[2]?.textContent ?? '').trim().length > 0;
    },
    undefined,
    { timeout: 40000 },
  );

  await page.waitForFunction(
    () => (document.getElementById('eval-quality')?.textContent ?? '') !== '',
    undefined,
    { timeout: 30000 },
  );
  const evalText = (await page.locator('#eval').textContent()).replace(/\s+/g, ' ').trim();
  const evalTitle = await page.locator('#eval').getAttribute('title');
  console.log('实时评分：', evalText, '|', evalTitle);
  if (!evalText.match(/好棋|可行|失误|漏着/)) throw new Error('未显示本步质量');
  if (!evalTitle?.includes('红方') || !evalTitle.includes('黑方')) {
    throw new Error('实时评分未展示双方分数');
  }

  const moveText = await page.locator('#move-list').textContent();
  const message = await page.locator('#message').textContent();
  console.log('棋谱：', moveText.replace(/\s+/g, ' ').trim());
  console.log('状态：', message);
  if (message?.startsWith('AI 出错')) throw new Error(message);

  const marked = await page.locator('#board g.piece[data-mark="keep"]').count();
  if (marked !== 32) throw new Error(`棋子节点未原地复用，剩余 ${marked}`);
  if ((await page.locator('#board').count()) !== 1) throw new Error('走子后棋盘数量变化');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/gui-initial.png` });

  await openPanel();
  await page.locator('#hint').click();
  await page.waitForFunction(
    () => document.getElementById('message')?.textContent?.startsWith('建议：'),
    undefined,
    { timeout: 30000 },
  );
  const hintText = await page.locator('#message').textContent();
  const hintLines = await page.locator('#board .hint-line').count();
  console.log('提示：', hintText);
  if (hintLines < 2 || hintLines > 3) {
    throw new Error(`提示箭头应为 2-3 条，实际 ${hintLines}`);
  }
  if (!hintText?.includes(' / ')) throw new Error('提示未展示多个变化');
  await page.screenshot({ path: `${shots}/gui-hint.png` });

  await openPanel();
  await page.locator('#undo').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length === 0,
    undefined,
    { timeout: 10000 },
  );
  console.log('悔棋后棋子数：', await page.locator('#board g.piece').count());

  await page.locator('.hits rect[data-df="1"][data-dr="9"]').click();
  await page.locator('.hits rect[data-df="2"][data-dr="7"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length > 0,
    undefined,
    { timeout: 40000 },
  );

  await openPanel();
  await page.locator('#resign').click();
  await page.waitForFunction(
    () => document.getElementById('message')?.textContent?.includes('对局结束'),
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => (document.getElementById('record')?.textContent ?? '').includes('棋谱已保存'),
    undefined,
    { timeout: 10000 },
  );
  console.log('结束：', await page.locator('#message').textContent());
  const recordText = await page.locator('#record').textContent();
  console.log('棋谱文件：', recordText);

  await openPanel();
  await page.locator('#review').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#review-body .review-row').length > 0,
    undefined,
    { timeout: 60000 },
  );
  console.log('复盘：', (await page.locator('#review-body').textContent()).replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: `${shots}/gui-review.png` });

  const recordDir = join(env.APPDATA ?? '', 'Xiangqi', 'records');
  const files = readdirSync(recordDir);
  const latest = files.sort().at(-1);
  const record = JSON.parse(readFileSync(join(recordDir, latest), 'utf8'));
  console.log('棋谱内容：', record.result, record.endReason, record.moves[0]);
  if (record.result !== 'black_win' || record.endReason !== 'resign') {
    throw new Error('棋谱结果不正确');
  }

  await openPanel();
  await page.selectOption('#side', 'black');
  await page.locator('#new-game').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#move-list .move-row .move-red, #move-list .move-row .move-black')
        .length > 0,
    undefined,
    { timeout: 40000 },
  );
  const kingY = await page.evaluate(() => {
    const king = [...document.querySelectorAll('#board g.piece text')].find(
      (node) => node.textContent === '帥',
    );
    const group = king?.parentElement;
    const match = group?.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return match ? Number(match[2]) : -1;
  });
  console.log('执黑时红帥的纵坐标：', kingY);
  if (kingY < 0 || kingY > 200) throw new Error('执黑时棋盘未翻转');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/gui-black.png` });

  console.log('UI 冒烟通过');
} finally {
  const child = app.process();
  await app.close().catch(() => {});
  if (child && child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}