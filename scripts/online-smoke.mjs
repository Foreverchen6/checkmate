import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const shots = 'docs/screenshots';
mkdirSync(shots, { recursive: true });

const hostData = mkdtempSync(join(tmpdir(), 'xiangqi-online-host-'));
const guestData = mkdtempSync(join(tmpdir(), 'xiangqi-online-guest-'));

const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;
baseEnv.XIANGQI_ONLINE_SMOKE_LOCAL = '1';

const packagedExe = process.env.XIANGQI_EXE;
const launch = (userData) =>
  electron.launch({
    executablePath: packagedExe ?? 'node_modules/electron/dist/electron.exe',
    args: packagedExe ? [] : ['.'],
    env: { ...baseEnv, XIANGQI_USER_DATA: userData },
  });

const waitFor = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};

const text = (page, selector) => page.locator(selector).textContent();

// 棋钟必须在 4 秒内出现文本变化（格式到秒，正常情况下 1 秒内就会变）。
const waitClockTick = async (page, who) => {
  const before = ((await text(page, '#online-bar-clock')) ?? '').trim();
  if (before === '') throw new Error(`${who}棋钟文本为空`);
  const startedClockAt = Date.now();
  await waitFor(
    async () => ((await text(page, '#online-bar-clock')) ?? '').trim() !== before,
    `${who}棋钟跳动`,
    4000,
  );
  const after = ((await text(page, '#online-bar-clock')) ?? '').trim();
  console.log(`${who}棋钟跳动：`, before, '→', after, `${Date.now() - startedClockAt}ms`);
};

const openOnline = async (page) => {
  if (!(await page.locator('.controls').isVisible())) await page.locator('#toggle-panel').click();
  await page.waitForTimeout(150);
  await page.locator('#online').click();
  await page.waitForSelector('#online-modal:not([hidden])');
};

// 联机面板是覆盖全屏的 .modal，#online-modal 打开时会拦截棋盘点击，
// 因此点棋盘前必须先关闭面板，需要点面板按钮时再打开。
const closeOnline = async (page) => {
  if (!(await page.locator('#online-modal').isVisible())) return;
  await page.locator('#online-close').click();
  await page.waitForSelector('#online-modal[hidden]', { state: 'hidden' });
};

const clickSquare = async (page, orientation, file, rank) => {
  const df = orientation === 'red' ? file : 8 - file;
  const dr = orientation === 'red' ? 9 - rank : rank;
  await page.locator(`.hits rect[data-df="${df}"][data-dr="${dr}"]`).click();
};

const moveCount = (page) =>
  page.locator('#move-list .move-red, #move-list .move-black').count();

const rendererErrors = [];
let host = null;
let guest = null;
const startedAt = Date.now();

const collectErrors = (page, who) => {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    console.log(`[${who} error]`, message.text());
    rendererErrors.push(`${who}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.log(`[${who} pageerror]`, error.message);
    rendererErrors.push(`${who}: ${error.message}`);
  });
};

try {
  host = await launch(hostData);
  guest = await launch(guestData);
  const hostPage = await host.firstWindow();
  const guestPage = await guest.firstWindow();
  collectErrors(hostPage, 'host');
  collectErrors(guestPage, 'guest');
  await hostPage.waitForLoadState('domcontentloaded');
  await guestPage.waitForLoadState('domcontentloaded');

  await openOnline(hostPage);
  await hostPage.locator('#online-host-side').selectOption('red');
  const createAt = Date.now();
  await hostPage.locator('#online-create').click();
  await waitFor(
    async () => (await hostPage.locator('#online-url').inputValue()).includes('/#'),
    '房主生成邀请链接',
  );
  const inviteLatency = Date.now() - createAt;
  const invite = await hostPage.locator('#online-url').inputValue();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/.test(invite)) {
    throw new Error(`邀请链接格式异常：${invite}`);
  }
  console.log('邀请链接：', invite);
  console.log('邀请链接生成耗时（点创建到出现链接）：', inviteLatency, 'ms');
  if (inviteLatency > 15000) throw new Error(`邀请链接生成超时：${inviteLatency}ms`);
  console.log('邀请链接耗时（含两实例启动）：', Date.now() - startedAt, 'ms');

  await openOnline(guestPage);
  await guestPage.locator('#online-tab-guest').click();
  await guestPage.locator('#online-join-url').fill(invite);
  await guestPage.locator('#online-join').click();
  // 客人的联机状态在发起 IPC 之前就已落地，房主裁决前界面必须显示“等待房主同意”，
  // 且此时“离开”可用（房主一直不裁决时客人不能死等）。
  await waitFor(
    async () => (await text(guestPage, '#online-guest-state'))?.includes('等待房主同意'),
    '客人进入等待审批',
  );
  const guestBeforeAccept = (await text(guestPage, '#online-guest-state'))?.trim();
  await waitFor(
    () => guestPage.locator('#online-leave').isEnabled(),
    '等待审批期间离开可用',
    5000,
  );
  console.log('客人提交加入后（房主尚未裁决）：', guestBeforeAccept, '离开可用：true');

  await waitFor(
    () => hostPage.locator('#online-join-request').isVisible(),
    '房主收到加入请求',
  );
  await hostPage.locator('#online-accept').click();
  await waitFor(
    async () => (await text(hostPage, '#online-host-state'))?.includes('对局中'),
    '房主进入对局',
  );
  await waitFor(
    async () => (await text(guestPage, '#online-guest-state'))?.includes('对局中'),
    '客人进入对局',
  );

  await closeOnline(hostPage);
  await closeOnline(guestPage);

  await hostPage.screenshot({ path: `${shots}/online-host-start.png` });
  await guestPage.screenshot({ path: `${shots}/online-guest-start.png` });

  const fairnessOf = (page) =>
    page.evaluate(() => ({
      hint: document.getElementById('hint').disabled,
      review: document.getElementById('review').disabled,
      simulate: document.getElementById('simulate').disabled,
      newGame: document.getElementById('new-game').disabled,
      load: document.getElementById('load').disabled,
      importFen: document.getElementById('import-fen').disabled,
      eval: document.getElementById('eval-score').textContent,
      bar: !document.getElementById('online-bar').hidden,
    }));
  const fairnessOk = (fairness) =>
    fairness.hint &&
    fairness.review &&
    fairness.simulate &&
    fairness.newGame &&
    fairness.load &&
    fairness.importFen &&
    fairness.eval === '联机模式已关闭评估' &&
    fairness.bar;

  const fairness = await fairnessOf(hostPage);
  console.log('房主公平性门禁：', JSON.stringify(fairness));
  if (!fairnessOk(fairness)) throw new Error('联机公平性门禁未生效（房主）');

  // 验收第 3 项对双方成立：客人侧同样禁用六个按钮、关闭评估并显示联机条。
  const guestFairness = await fairnessOf(guestPage);
  console.log('客人公平性门禁：', JSON.stringify(guestFairness));
  if (!fairnessOk(guestFairness)) throw new Error('联机公平性门禁未生效（客人）');

  const engineError = await hostPage.evaluate(async () => {
    try {
      await window.xiangqi.search({ fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', nodes: 10 });
      return 'allowed';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  console.log('联机时主进程引擎门禁：', engineError);
  if (!engineError.includes('联机对局中不可使用引擎')) {
    throw new Error('主进程未拒绝联机期间的引擎调用');
  }

  // 红炮初始在第二横线（FEN 第 8 行 "1C5C1" → rank 2），黑炮在 rank 7。
  await clickSquare(hostPage, 'red', 7, 2);
  await clickSquare(hostPage, 'red', 4, 2);
  await waitFor(async () => (await moveCount(hostPage)) === 1, '房主走子');
  await waitFor(async () => (await moveCount(guestPage)) === 1, '客人收到房主走子');
  console.log('房主走子步数（房主/客人）：', await moveCount(hostPage), await moveCount(guestPage));
  // 棋钟必须在双方都真实走动：房主侧由 OnlineGame.clockNow 推导、客人侧由快照推导，
  // 文本都不变即为棋钟卡死，不能只打印文本了事。
  await waitClockTick(hostPage, '房主');
  await waitClockTick(guestPage, '客人');
  console.log(
    '房主走子后棋钟（房主/客人）：',
    await text(hostPage, '#online-bar-clock'),
    '/',
    await text(guestPage, '#online-bar-clock'),
  );

  await clickSquare(guestPage, 'black', 7, 7);
  await clickSquare(guestPage, 'black', 4, 7);
  await waitFor(async () => (await moveCount(guestPage)) === 2, '客人走子');
  await waitFor(async () => (await moveCount(hostPage)) === 2, '房主收到客人走子');
  console.log('客人走子步数（客人/房主）：', await moveCount(guestPage), await moveCount(hostPage));
  await waitClockTick(hostPage, '房主');
  await waitClockTick(guestPage, '客人');
  console.log(
    '客人走子后棋钟（房主/客人）：',
    await text(hostPage, '#online-bar-clock'),
    '/',
    await text(guestPage, '#online-bar-clock'),
  );

  await openOnline(hostPage);
  await hostPage.locator('#online-undo').click();
  await openOnline(guestPage);
  await waitFor(
    () => guestPage.locator('#online-pending').isVisible(),
    '客人收到悔棋请求',
  );
  const pendingText = await text(guestPage, '#online-pending-text');
  if (!pendingText?.includes('对方请求悔棋')) throw new Error(`悔棋提示异常：${pendingText}`);
  await guestPage.locator('#online-pending-accept').click();
  await waitFor(async () => (await moveCount(hostPage)) === 0, '悔棋后回到起点');
  await waitFor(async () => (await moveCount(guestPage)) === 0, '客人同步悔棋');
  await closeOnline(hostPage);
  await closeOnline(guestPage);

  await clickSquare(hostPage, 'red', 7, 2);
  await clickSquare(hostPage, 'red', 4, 2);
  await waitFor(async () => (await moveCount(guestPage)) === 1, '悔棋后房主再走子');
  await clickSquare(guestPage, 'black', 7, 7);
  await clickSquare(guestPage, 'black', 4, 7);
  await waitFor(async () => (await moveCount(hostPage)) === 2, '悔棋后客人再走子');
  console.log('悔棋后重走步数：', await moveCount(hostPage), await moveCount(guestPage));

  await openOnline(guestPage);
  await guestPage.locator('#online-draw').click();
  await openOnline(hostPage);
  await waitFor(
    () => hostPage.locator('#online-pending').isVisible(),
    '房主收到求和请求',
  );
  await hostPage.locator('#online-pending-accept').click();
  await waitFor(
    async () => (await text(hostPage, '#online-host-state'))?.includes('对局已结束'),
    '房主看到和棋',
  );
  await waitFor(
    async () => (await text(guestPage, '#online-guest-state'))?.includes('对局已结束'),
    '客人看到和棋',
  );
  const turnText = await text(hostPage, '#turn');
  if (!turnText?.includes('和棋')) throw new Error(`终局显示异常：${turnText}`);
  console.log('联机悔棋/求和：', pendingText, turnText);

  await hostPage.locator('#online-stop').click();
  await waitFor(
    () => hostPage.locator('#online-bar').isHidden(),
    '房主结束联机',
  );
  await waitFor(
    () => guestPage.locator('#online-bar').isHidden(),
    '客人收到关闭',
  );

  // 验收第 6 项：邀请地址随会话一起失效，结束后无可访问的本地服务。
  // 端口服务已关闭时应为连接被拒（dead === 0）；能拿到 HTTP 状态说明仍在应答。
  const base = invite.split('#')[0];
  const dead = await fetch(`${base}xq/v1/poll?rev=0`, {
    headers: {
      authorization: `Bearer ${invite.split('#')[1]}`,
      'bypass-tunnel-reminder': 'true',
      'user-agent': 'Xiangqi/0.1',
    },
    signal: AbortSignal.timeout(3000),
  })
    .then((response) => response.status)
    .catch(() => 0);
  console.log('结束后邀请地址探测（0=连接被拒，符合预期）：', dead);
  if (dead !== 0) throw new Error(`结束后邀请地址仍可访问：${dead}`);

  const restored = await hostPage.evaluate(() => ({
    newGame: document.getElementById('new-game').disabled,
    review: document.getElementById('review').disabled,
    eval: document.getElementById('eval-score').textContent,
  }));
  console.log('结束后恢复本地功能：', JSON.stringify(restored));
  if (restored.newGame) throw new Error('结束后新局按钮未恢复');
  if (restored.review) throw new Error('结束后复盘按钮未恢复');

  const restoredTools = await hostPage.evaluate(() => ({
    save: document.getElementById('save').disabled,
    export: document.getElementById('export-game').disabled,
    importFile: document.getElementById('import-file').disabled,
    side: document.getElementById('side').disabled,
    level: document.getElementById('level').disabled,
  }));
  console.log('结束后本地按钮（true=禁用）：', JSON.stringify(restoredTools));

  // 打包版两个窗口叠在同一位置，被遮挡的渲染进程可能不再出帧导致截图挂起：
  // 截图前把房主窗口提到最前并聚焦。
  const hostWin = await host.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    win?.moveTop();
    win?.focus();
    return { visible: win?.isVisible(), minimized: win?.isMinimized(), focused: win?.isFocused() };
  });
  console.log(
    '房主窗口（截图前）：',
    JSON.stringify(hostWin),
    'visibility:',
    await hostPage.evaluate(() => document.visibilityState),
  );
  await hostPage.screenshot({ path: `${shots}/online-after-stop.png`, timeout: 60000 });
  if (rendererErrors.length > 0) {
    throw new Error(`存在 renderer error：\n${rendererErrors.join('\n')}`);
  }
  console.log('renderer error：0');
  console.log('联机冒烟通过');
} finally {
  // 任一实例关闭失败都不能让另一个实例成为遗留进程。
  await Promise.allSettled([
    guest ? guest.close() : Promise.resolve(),
    host ? host.close() : Promise.resolve(),
  ]);
}