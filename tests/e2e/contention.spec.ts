import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * 多页面争用验收。
 * 三个页面都在同一个浏览器 profile 下（共享同源 IndexedDB / Web Locks /
 * BroadcastChannel），模拟“旧排练窗口、正式控制页、投影页”同时存在。
 */

const EDITOR = '/#/editor';
const STAGE = '/#/stage';
const PROJECTION = '/#/projection';

async function clearSiteData(page: Page) {
  await page.goto(EDITOR);
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map((d) => d.name ? new Promise<void>((res, rej) => {
        const r = indexedDB.deleteDatabase(d.name!);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      }) : Promise.resolve()),
    );
  });
}

async function adoptProgram(editor: Page) {
  await editor.goto(EDITOR);
  // 第一条双语字幕
  await editor.getByRole('button', { name: '＋ 双语字幕' }).click();
  const zhInputs = editor.locator('textarea').nth(0);
  const itInputs = editor.locator('textarea').nth(1);
  await zhInputs.fill('爱情像一只小鸟');
  await itInputs.fill('L’amour est un oiseau');
  // 第二条字幕
  await editor.getByRole('button', { name: '＋ 双语字幕' }).click();
  await editor.locator('textarea').nth(2).fill('哈巴涅拉舞曲');
  await editor.locator('textarea').nth(3).fill('Habanera');
  // 一条黑场
  await editor.getByRole('button', { name: '＋ 黑场提示' }).click();
  await editor.getByRole('button', { name: '采用节目单（冻结在演版本）' }).click();
  await expect(editor.getByTestId('frozen-info')).toContainText('当前在演版本');
}

async function startAndExpectLeader(page: Page, name: string) {
  await page.goto(STAGE);
  await expect(page.getByTestId('role-banner')).toHaveAttribute('data-role', 'idle');
  await page.locator('.control-identity input').fill(name);
  await page.getByTestId('start-btn').click();
  await expect(page.getByTestId('role-banner')).toHaveAttribute('data-role', 'leader');
}

test.describe('多页面控制争用', () => {
  let context: BrowserContext;
  let editor: Page;

  test.beforeEach(async ({ browser }) => {
    context = await browser.newContext();
    editor = await context.newPage();
    await clearSiteData(editor);
    await adoptProgram(editor);
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('只有一个控制者：胜者发布，其他页只读显示画面与控制者', async () => {
    const controlA = await context.newPage();
    const controlB = await context.newPage();
    const projector = await context.newPage();

    await startAndExpectLeader(controlA, '主控台');

    // 第二个控制页排队等待
    await controlB.goto(STAGE);
    await controlB.locator('.control-identity input').fill('旧排练窗口');
    await controlB.getByTestId('start-btn').click();
    await expect(controlB.getByTestId('role-banner')).toHaveAttribute(
      'data-role',
      'waiting',
    );

    // 投影打开后是黑场（起始帧）
    await projector.goto(PROJECTION);
    await expect(projector.getByTestId('proj-blackout')).toBeVisible();
    await expect(projector.getByTestId('proj-corner')).toContainText('主控台');

    // 胜者切到第二句
    await controlA.locator('[data-cue-index="1"]').click();
    await expect(projector.getByTestId('proj-subtitles')).toContainText('哈巴涅拉舞曲');
    await expect(projector.getByTestId('proj-subtitles')).toContainText('Habanera');

    // 等待页只读显示相同画面和控制者，且没有操作按钮
    await expect(controlB.getByTestId('readonly-frame')).toContainText('哈巴涅拉舞曲');
    await expect(controlB.getByTestId('role-banner')).toContainText('主控台');
    await expect(controlB.getByTestId('cue-console')).toHaveCount(0);

    // 黑场
    await controlA.getByTestId('blackout-btn').click();
    await expect(projector.getByTestId('proj-blackout')).toBeVisible();
    await expect(projector.getByTestId('proj-corner')).toContainText('#2');
  });

  test('控制页关闭后等待者接管（新代次），观众最终只见新代次画面', async () => {
    const controlA = await context.newPage();
    const controlB = await context.newPage();
    const projector = await context.newPage();

    await startAndExpectLeader(controlA, '主控台');
    await controlB.goto(STAGE);
    await controlB.locator('.control-identity input').fill('替补台');
    await controlB.getByTestId('start-btn').click();
    await expect(controlB.getByTestId('role-banner')).toHaveAttribute('data-role', 'waiting');

    await projector.goto(PROJECTION);
    await controlA.locator('[data-cue-index="0"]').click();
    await expect(projector.getByTestId('proj-subtitles')).toContainText('爱情像一只小鸟');
    await expect(projector.getByTestId('proj-corner')).toContainText('g1');

    // 主控台关闭（释放唯一锁）
    await controlA.close();

    // 替补台自动获锁、取得新代次并发布起始黑场
    await expect(controlB.getByTestId('role-banner')).toHaveAttribute('data-role', 'leader');
    await expect(projector.getByTestId('proj-corner')).toContainText('g2');
    await expect(projector.getByTestId('proj-blackout')).toBeVisible();

    // 新控制者切句
    await controlB.locator('[data-cue-index="1"]').click();
    await expect(projector.getByTestId('proj-subtitles')).toContainText('哈巴涅拉舞曲');
    await expect(projector.getByTestId('proj-corner')).toContainText('g2');

    // 投影重载：从持久状态恢复，仍是新代次确认画面
    await projector.reload();
    await expect(projector.getByTestId('proj-subtitles')).toContainText('哈巴涅拉舞曲');
    await expect(projector.getByTestId('proj-corner')).toContainText('g2');
    await expect(projector.getByTestId('proj-corner')).toContainText('替补台');
  });

  test('失锁旧页立即禁用；迟到消息不能覆盖新代次', async () => {
    const controlA = await context.newPage();
    const controlB = await context.newPage();
    const projector = await context.newPage();

    await startAndExpectLeader(controlA, '主控台');
    await controlB.goto(STAGE);
    await controlB.locator('.control-identity input').fill('替补台');
    await controlB.getByTestId('start-btn').click();
    await expect(controlB.getByTestId('role-banner')).toHaveAttribute('data-role', 'waiting');

    await projector.goto(PROJECTION);
    await controlA.locator('[data-cue-index="0"]').click();
    await expect(projector.getByTestId('proj-subtitles')).toContainText('爱情像一只小鸟');

    // 抢占唯一锁：旧页 A 立刻失锁禁用；B 随后以新代次接管
    await controlA.evaluate(() => (window as any).__testStealLock());

    await expect(controlA.getByTestId('role-banner')).toHaveAttribute('data-role', 'lost');
    await expect(controlA.getByTestId('cue-console')).toHaveCount(0);
    await expect(controlB.getByTestId('role-banner')).toHaveAttribute('data-role', 'leader');

    await expect(projector.getByTestId('proj-corner')).toContainText('g2');
    await expect(projector.getByTestId('proj-corner')).toContainText('替补台');

    // 旧页控制台按钮已不存在；即使从页面上下文伪造一条 g1 迟到广播，
    // 投影也必须拒绝。
    await projector.evaluate(() => {
      const ch = new BroadcastChannel('opera-stage');
      ch.postMessage({
        type: 'frame',
        frame: {
          generation: 1,
          seq: 999,
          kind: 'subtitle',
          cueId: 'stale',
          cueIndex: 0,
          zh: '旧代次迟到的句子',
          it: 'stale',
          programId: 'p',
          controllerId: 'ctl-old',
          controllerName: '主控台',
          publishedAt: 0,
        },
      });
      ch.close();
    });
    await projector.waitForTimeout(300);
    // 仍为新代次黑场（g2/#0），迟到句未出现
    await expect(projector.getByTestId('proj-blackout')).toBeVisible();
    await expect(projector.getByTestId('proj-corner')).toContainText('g2');
    await expect(projector.getByTestId('proj-corner')).not.toContainText('#999');

    // 新控制者可以继续正常发布
    await controlB.locator('[data-cue-index="1"]').click();
    await expect(projector.getByTestId('proj-subtitles')).toContainText('哈巴涅拉舞曲');
  });

  test('冻结边界：采用节目单后的编辑不影响在演版本，空单不能采用', async () => {
    const page = editor;
    // 已采用的版本有 3 条；控制台里应能看到 3 个按钮
    const control = await context.newPage();
    await startAndExpectLeader(control, '主控台');
    await expect(control.locator('[data-cue-index]')).toHaveCount(3);

    // 回编辑页增改草稿（不再点采用）。已有 2 条字幕占 textarea 0..3，
    // 新加的第 3 条字幕是 textarea 4/5。
    await page.goto(EDITOR);
    await expect(page.locator('.cue-row')).toHaveCount(3);
    await page.getByRole('button', { name: '＋ 双语字幕' }).click();
    await expect(page.locator('textarea')).toHaveCount(6);
    await page.locator('textarea').nth(4).fill('未冻结的新句子');
    await page.locator('textarea').nth(5).fill('non adottato');

    // 新开控制页：旧控制页关闭释放锁后，新页仍只能看到冻结的 3 条
    await control.close();
    const control2 = await context.newPage();
    await control2.goto(STAGE);
    await control2.getByTestId('start-btn').click();
    await expect(control2.getByTestId('role-banner')).toHaveAttribute(
      'data-role',
      'leader',
    );
    await expect(control2.locator('[data-cue-index]')).toHaveCount(3);

    // 空节目单不能采用
    await page.goto(EDITOR);
    // 删除全部条目
    const deleteButtons = page.locator('.cue-head .danger');
    const count = await deleteButtons.count();
    for (let i = 0; i < count; i++) {
      await deleteButtons.first().click();
    }
    await expect(
      page.getByRole('button', { name: '采用节目单（冻结在演版本）' }),
    ).toBeDisabled();
  });
});
