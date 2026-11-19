import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const shots = 'docs/screenshots';
mkdirSync(shots, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'xiangqi-smoke-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.XIANGQI_SMOKE = '1';
env.XIANGQI_USER_DATA = userData;

const packagedExe = process.env.XIANGQI_EXE;
const app = await electron.launch({
  executablePath: packagedExe ?? 'node_modules/electron/dist/electron.exe',
  args: packagedExe ? [] : ['.'],
  env,
});

const waitFor = async (check, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};

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

  const savedDir = join(userData, 'saved');
  const settingsFile = join(userData, 'settings.json');
  const readShortcuts = () => {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8')).shortcuts;
    } catch {
      return null;
    }
  };
  const moveCount = () =>
    page.locator('#move-list .move-red, #move-list .move-black').count();
  const openArchive = async () => {
    await openPanel();
    await page.evaluate(() => {
      document.getElementById('archive-panel').open = true;
    });
  };
  const openShortcuts = async () => {
    await openPanel();
    await page.evaluate(() => {
      document.getElementById('shortcut-panel').open = true;
    });
  };

  // FEN 导入
  await openPanel();
  await page.locator('#import-fen').click();
  await page.waitForFunction(() => !document.getElementById('fen-modal').hidden);
  await page.locator('#fen-input').fill('9/9');
  await page.locator('#fen-confirm').click();
  const fenError = (await page.locator('#fen-error').textContent())?.trim();
  const fenStillOpen = await page.evaluate(
    () => !document.getElementById('fen-modal').hidden,
  );
  if (!fenError || !fenStillOpen) throw new Error('非法 FEN 未被拦截');
  await page
    .locator('#fen-input')
    .fill('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');
  await page.locator('#fen-confirm').click();
  await page.waitForFunction(() => document.getElementById('fen-modal').hidden);
  await page.waitForFunction(
    () => (document.getElementById('message')?.textContent ?? '').includes('已导入局面'),
    undefined,
    { timeout: 10000 },
  );
  console.log('FEN 导入：', await page.locator('#message').textContent());

  // 自定义快捷键
  await openShortcuts();
  await page.locator('#shortcut-list .shortcut-key[data-action="undo"]').click();
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForFunction(
    () =>
      document.querySelector('#shortcut-list .shortcut-key[data-action="undo"]')
        ?.textContent === 'Ctrl+Shift+Z',
    undefined,
    { timeout: 10000 },
  );
  await waitFor(
    () => readShortcuts()?.undo === 'Ctrl+Shift+Z',
    '快捷键写入 settings.json',
  );
  await page.locator('#toggle-panel').click();
  await page.waitForTimeout(150);

  await page.locator('.hits rect[data-df="1"][data-dr="9"]').click();
  await page.locator('.hits rect[data-df="2"][data-dr="7"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 2,
    undefined,
    { timeout: 40000 },
  );
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 0,
    undefined,
    { timeout: 10000 },
  );
  console.log('自定义快捷键悔棋：', await page.locator('#message').textContent());

  await openShortcuts();
  await page.locator('#reset-shortcuts').click();
  await waitFor(() => readShortcuts()?.undo === 'Ctrl+Z', '快捷键恢复默认');
  await page.locator('#toggle-panel').click();
  await page.waitForTimeout(150);

  // 快速存档与载入
  await page.locator('.hits rect[data-df="1"][data-dr="9"]').click();
  await page.locator('.hits rect[data-df="2"][data-dr="7"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 2,
    undefined,
    { timeout: 40000 },
  );
  await page.waitForFunction(
    () => !document.getElementById('save').disabled,
    undefined,
    { timeout: 10000 },
  );
  await openPanel();
  await page.locator('#save').click();
  await page.waitForFunction(
    () => (document.getElementById('message')?.textContent ?? '').includes('已保存'),
    undefined,
    { timeout: 10000 },
  );
  await waitFor(
    () => existsSync(savedDir) && readdirSync(savedDir).length === 1,
    '存档文件写入',
  );
  console.log('快速存档：', await page.locator('#message').textContent());

  await openPanel();
  await page.locator('#new-game').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length === 0,
    undefined,
    { timeout: 10000 },
  );
  await openPanel();
  await page.locator('#load').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#archive-list .archive-row').length > 0,
    undefined,
    { timeout: 10000 },
  );
  await page.locator('#archive-list .archive-row').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length === 1,
    undefined,
    { timeout: 10000 },
  );
  console.log('载入存档：', await page.locator('#message').textContent());

  // 导出与从文件载入
  await openArchive();
  await page.locator('#export-game').click();
  await page.waitForFunction(
    () => (document.getElementById('message')?.textContent ?? '').includes('已导出'),
    undefined,
    { timeout: 15000 },
  );
  const exportFile = join(userData, 'smoke-export.json');
  await waitFor(() => existsSync(exportFile), '导出文件写入');

  await openPanel();
  await page.locator('#new-game').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length === 0,
    undefined,
    { timeout: 10000 },
  );
  await openArchive();
  await page.locator('#import-file').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length === 1,
    undefined,
    { timeout: 15000 },
  );
  console.log('从文件载入：', await page.locator('#message').textContent());

  await page.locator('#undo').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-row').length === 0,
    undefined,
    { timeout: 10000 },
  );

  const expectedMoves = await moveCount();
  if (expectedMoves !== 0) throw new Error(`导入测试后应回到空棋谱，实际 ${expectedMoves} 步`);

  await page.evaluate(() => {
    document.querySelectorAll('#board g.piece').forEach((node) => {
      node.setAttribute('data-mark', 'keep');
    });
  });

  // 推演模式：替双方走子，真实对局保持不变
  await page.locator('#simulate').click();
  await page.waitForFunction(
    () => document.getElementById('turn')?.textContent?.includes('推演') ?? false,
    undefined,
    { timeout: 10000 },
  );
  const quickBar = await page.evaluate(() => ({
    undo: !document.getElementById('undo').hidden,
    prev: !document.getElementById('sim-prev').hidden,
    next: !document.getElementById('sim-next').hidden,
    prevDisabled: document.getElementById('sim-prev').disabled,
    nextDisabled: document.getElementById('sim-next').disabled,
  }));
  console.log('推演快捷按钮：', JSON.stringify(quickBar));
  if (quickBar.undo || !quickBar.prev || !quickBar.next) {
    throw new Error('推演时快捷按钮显隐不正确');
  }
  if (!quickBar.prevDisabled || !quickBar.nextDisabled) {
    throw new Error('刚开始推演时上一步/下一步应为置灰');
  }
  console.log(
    '进入推演：',
    await page.locator('#turn').textContent(),
    '|',
    await page.locator('#message').textContent(),
  );

  await page.locator('.hits rect[data-df="1"][data-dr="9"]').click();
  await page.locator('.hits rect[data-df="2"][data-dr="7"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 1,
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => (document.getElementById('eval-quality')?.textContent ?? '') !== '',
    undefined,
    { timeout: 30000 },
  );
  const simQuality = await page.locator('#eval-quality').textContent();
  console.log('推演红方走子质量：', simQuality);
  if (!/好棋|可行|失误|漏着/.test(simQuality ?? '')) throw new Error('推演未给出走子质量');

  await page.waitForTimeout(1200);
  const simOnlyOne = await page.locator('#move-list .move-red, #move-list .move-black').count();
  if (simOnlyOne !== 1) throw new Error(`推演中不应自动应招，实际 ${simOnlyOne} 步`);

  const afterSimMove = await page.evaluate(() => ({
    prevDisabled: document.getElementById('sim-prev').disabled,
    nextDisabled: document.getElementById('sim-next').disabled,
  }));
  if (afterSimMove.prevDisabled || !afterSimMove.nextDisabled) {
    throw new Error('推演走子后应可用上一步，下一步保持置灰');
  }
  await page.locator('#sim-prev').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 0,
    undefined,
    { timeout: 10000 },
  );
  const afterSimPrev = await page.evaluate(() => ({
    prevDisabled: document.getElementById('sim-prev').disabled,
    nextDisabled: document.getElementById('sim-next').disabled,
  }));
  if (!afterSimPrev.prevDisabled || afterSimPrev.nextDisabled) {
    throw new Error('回到推演起点后应置灰上一步，下一步可用');
  }
  await page.locator('#sim-next').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 1,
    undefined,
    { timeout: 10000 },
  );
  console.log('推演上一步/下一步：', await page.locator('#message').textContent());

  await page.locator('.hits rect[data-df="1"][data-dr="0"]').click();
  await page.locator('.hits rect[data-df="2"][data-dr="2"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 2,
    undefined,
    { timeout: 10000 },
  );
  console.log('推演双方走子后提示：', await page.locator('#message').textContent());

  await page.locator('#sim-prev').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 1,
    undefined,
    { timeout: 10000 },
  );
  const simUndoTurn = await page.locator('#turn').textContent();
  console.log('推演上一步后：', simUndoTurn, '|', await page.locator('#message').textContent());
  if (!simUndoTurn?.includes('推演')) throw new Error('推演上一步后退出了推演');

  const simLabel = (await page.locator('#simulate').textContent())?.trim();
  if (simLabel !== '返回对局') throw new Error(`推演按钮未切换：${simLabel}`);
  await page.locator('#simulate').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#move-list .move-red, #move-list .move-black').length === 0,
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => (document.getElementById('eval-score')?.textContent ?? '') !== '评估中',
    undefined,
    { timeout: 30000 },
  );
  const backTurn = await page.locator('#turn').textContent();
  const backEval = await page.locator('#eval-score').textContent();
  console.log('返回对局：', backTurn, '|', backEval);
  if (backTurn?.includes('推演')) throw new Error('返回后仍处于推演状态');
  if (!backEval || backEval === '评估中') throw new Error('返回后未恢复实时评分');

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

  await page.locator('#hint').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#board .hint-line').length === 0,
    undefined,
    { timeout: 10000 },
  );
  const hintOffText = await page.locator('#message').textContent();
  console.log('关闭提示：', hintOffText);
  if (!hintOffText?.includes('已关闭提示')) throw new Error('再次点击提示未关闭提示');

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

  const recordDir = join(userData, 'records');
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
  rmSync(userData, { recursive: true, force: true });
}