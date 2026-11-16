import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const executable = process.argv[2];
if (!executable) throw Error('Usage: node scripts/obsidian-smoke.mjs <Obsidian.exe> [installed-obsidian.asar]');
const server = createServer();
await new Promise((done, fail) => server.listen(0, '127.0.0.1', done).on('error', fail));
const { port } = server.address();
await new Promise(done => server.close(done));
await mkdir('work', { recursive: true });
const scratch = await mkdtemp(resolve('work', 'obsidian-'));
const vault = join(scratch, 'TestVault');
const profile = join(scratch, 'obsidian');
const plugin = join(vault, '.obsidian', 'plugins', 'lifepilot');
await mkdir(plugin, { recursive: true });
await mkdir(profile, { recursive: true });
await cp('dist/obsidian', plugin, { recursive: true });
const enabled = ['lifepilot'];
const daylineSource = process.env.LIFEPILOT_DAYLINE_PLUGIN_DIR;
if (daylineSource) {
  const folder = join(vault, '.obsidian', 'plugins', 'dayline-journal');
  await mkdir(folder, { recursive: true });
  for (const name of ['manifest.json', 'main.js', 'styles.css']) await cp(join(daylineSource, name), join(folder, name));
  await writeFile(join(folder, 'data.json'), JSON.stringify({ dailyFolder: 'TestJournal', weatherEnabled: false, reminderEnabled: false }));
  enabled.push('dayline-journal');
}
const fnsConfigPath = process.env.LIFEPILOT_FNS_TEST_CONFIG;
const fnsPlugin = process.env.LIFEPILOT_FNS_PLUGIN_DIR;
let fns, restToken;
if (fnsConfigPath && fnsPlugin) {
  ({ restToken, ...fns } = JSON.parse(await readFile(fnsConfigPath, 'utf8')));
  const url = new URL(fns.api);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !restToken)
    throw Error('FNS smoke requires an isolated loopback server and a test REST token');
  const folder = join(vault, '.obsidian', 'plugins', 'fast-note-sync');
  await mkdir(folder, { recursive: true });
  for (const name of ['manifest.json', 'main.js', 'styles.css']) await cp(join(fnsPlugin, name), join(folder, name));
  await writeFile(join(folder, 'data.json'), JSON.stringify(fns));
  enabled.push('fast-note-sync');
}
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(enabled));
await writeFile(join(vault, 'sentinel.md'), '# Existing fixture\n');
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { a1b2c3d4e5f6a7b8: { path: vault, ts: Date.now(), open: true } } }));
if (process.argv[3]) await cp(process.argv[3], join(profile, process.argv[3].split(/[\\/]/).at(-1)));
const env = { ...process.env, APPDATA: scratch, LOCALAPPDATA: scratch, USERPROFILE: scratch, HOME: scratch };
let launchError;
function launch() {
  launchError = undefined;
  const process = spawn(executable, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1'], { cwd: scratch, env, windowsHide: true, stdio: 'ignore' });
  process.on('error', error => { launchError = error; });
  return process;
}
let child = launch();

async function until(check, label) {
  const end = Date.now() + 22_000;
  let error;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error('Obsidian exited ' + child.exitCode);
    try { const result = await check(); if (result) return result; } catch (err) { error = err; }
    await delay(200);
  }
  throw Error('Timed out: ' + label, { cause: error });
}

let ws, mcp;
async function connectRenderer() {
  const target = await until(async () => (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json())
    .find(x => x.url.startsWith('app://obsidian.md/')), 'isolated Obsidian renderer');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => { ws.addEventListener('open', done, { once: true }); ws.addEventListener('error', fail, { once: true }); });
}
let id = 0;
try {
  await connectRenderer();
  async function evaluate(expression) {
    const requestId = ++id;
    const response = new Promise((done, fail) => {
      const timeout = setTimeout(() => { ws.removeEventListener('message', listener); fail(Error('CDP request timed out')); }, 6000);
      function listener(event) {
        const reply = JSON.parse(event.data);
        if (reply.id !== requestId) return;
        clearTimeout(timeout);
        ws.removeEventListener('message', listener);
        if (reply.error || reply.result.exceptionDetails) fail(Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails)));
        else done(reply.result.result.value);
      }
      ws.addEventListener('message', listener);
    });
    ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    return response;
  }
  await until(() => evaluate('typeof app !== "undefined" && app.vault?.getName() === "TestVault" && !!app.plugins?.manifests?.lifepilot'), 'isolated Vault and plugin manifest');
  if (!await evaluate('!!app.plugins.plugins.lifepilot')) {
    await evaluate(`[...document.querySelectorAll('.modal button')].find(b =>
      /信任仓库作者并启用插件|trust author|trust this vault/i.test(b.textContent))?.click()`);
  }
  await until(() => evaluate('!!app.plugins.plugins.lifepilot'), 'LifePilot plugin load');
  if (fns) await until(async () => {
    const state = await evaluate(`(() => {
      const f = app.plugins.plugins['fast-note-sync'];
      return { loaded: !!f, authenticated: !!f?.websocket?.isAuth };
    })()`);
    if (!state.authenticated) throw Error('FNS loaded: ' + state.loaded + ', authenticated: ' + state.authenticated);
    return true;
  }, 'isolated FNS authentication');
  if (fns) {
    await until(() => evaluate('app.plugins.plugins["fast-note-sync"].fileHashManager.isReady()'), 'FNS file tracking ready');
    await evaluate(`(() => {
      const sync = app.plugins.plugins['fast-note-sync'].websocket;
      const send = sync.SendMessage, receive = sync.handleStructuredMessage;
      window.lifePilotSyncTrace = { messages: [], errors: [] };
      sync.SendMessage = function (action, item, ...args) {
        if (item?.path?.endsWith('.lifepilot-tmp')) lifePilotSyncTrace.messages.push(action);
        return send.call(this, action, item, ...args);
      };
      sync.handleStructuredMessage = function (action, item) {
        if (item?.code === 459) lifePilotSyncTrace.errors.push(item.code);
        return receive.call(this, action, item);
      };
    })()`);
  }
  await evaluate(`(() => {
    window.lifePilotTempEvents = [];
    for (const event of ['create', 'modify', 'delete', 'rename']) app.vault.on(event, (file, oldPath) => {
      if ([file.path, oldPath].some(path => path?.endsWith('.lifepilot-tmp'))) lifePilotTempEvents.push(event);
    });
  })()`);
  await evaluate('app.plugins.plugins.lifepilot.open("today")');

  async function click(label, scope = '.lp-dashboard') {
    const js = `[...${scope === '.lp-modal' ? 'activeWindow.document' : 'document'}.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    await until(() => evaluate(`(() => { const b = ${js}; if (!b || b.disabled) return false; b.click(); return true; })()`), label);
  }

  async function fill(field, value) {
    const js = `activeWindow.document.querySelector(${JSON.stringify('.lp-form [data-field="' + field + '"]')})`;
    await until(() => evaluate(`Boolean(${js})`), field);
    await evaluate(`(() => {
      const row = ${js};
      const value = ${JSON.stringify(value)};
      for (let el = row; el; el = el.parentElement) if (el.tagName === 'DETAILS') el.open = true;
      if (row.querySelector('.lp-stepper')) {
        const output = row.querySelector('output');
        const buttons = [...row.querySelectorAll('button')];
        buttons.find(item => !item.hidden && item.textContent === '记录')?.click();
        for (let count = 0; Number(output.value) !== Number(value); count++) {
          if (count === 100) throw Error('Cannot reach ' + row.dataset.field + ': ' + value);
          const gap = Number(value) - Number(output.value);
          const best = buttons.map(item => {
            const step = item.getAttribute('aria-label')?.match(/(增加|减少) ([0-9.]+)$/);
            return { item, delta: step ? Number(step[2]) * (step[1] === '增加' ? 1 : -1) : 0 };
          }).filter(({ item, delta }) => !item.disabled && gap * delta > 0 && Math.abs(delta) <= Math.abs(gap) + 1e-9)
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
          if (!best) throw Error('No step for ' + row.dataset.field + ': ' + gap);
          best.item.click();
        }
      } else if (row.querySelector('.lp-clock')) {
        const [hour, minute] = row.querySelectorAll('select');
        [hour.value, minute.value] = value.split(':');
        hour.dispatchEvent(new Event('change'));
        minute.dispatchEvent(new Event('change'));
      } else if (row.tagName === 'FIELDSET') {
        [...row.querySelectorAll('input')].find(item => item.value === value).closest('label').click();
      } else {
        const input = row.querySelector('input, select, textarea');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  }

  async function save() {
    await click('保存', '.lp-modal');
    await until(() => evaluate('!activeWindow.document.querySelector(".lp-modal .lp-form")'), 'form saved');
  }

  await click('数据与设置');
  await until(() => evaluate('document.querySelector(".lp-score-settings")?.textContent.includes("学习 45 分")'), 'scoring explained next to settings');
  assert.equal(await evaluate('document.querySelector(".lp-score-settings").open'), false);
  await click('新增主栏目');
  await fill('name', '专题学习');
  await fill('minutes', '60');
  await fill('points', '20');
  await save();
  await until(() => evaluate('document.querySelector(".lp-section-settings")?.textContent.includes("每周 60 分钟 · 满分 20")'), 'main section goal saved');
  const customSection = await evaluate('[...document.querySelectorAll(".lp-section-settings [data-section]")].find(el => el.querySelector("strong")?.textContent === "专题学习").dataset.section');
  await click('新增子栏目', '[data-section="' + customSection + '"]');
  await fill('name', '阶段复盘');
  await fill('minutes', '50');
  await fill('points', '10');
  await save();
  await click('编辑', '.lp-section-children [data-section]:has(button[aria-label="编辑阶段复盘"])');
  await fill('name', '每周复盘');
  await save();
  await click('周计划');
  await click('专题学习', '.lp-subject-nav');
  await click('每周复盘', '.lp-subsection-nav');
  await click('新增周池任务');
  await fill('title', '专题数学任务');
  await fill('subject', 'math');
  await fill('kind', 'recall');
  await save();
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("专题数学任务")'), 'custom subsection task created');
  await click('考研数学', '.lp-subject-nav');
  await click('设定入睡时间');
  await fill('bed', '23:45');
  await save();
  await until(() => evaluate('document.querySelector(".lp-week-nav")?.textContent.includes("23:45")'), 'selected hours and minutes saved');
  await click('导入 JSON');
  await fill('json', JSON.stringify({
    version: 1,
    goals: [{ subject: '408', category: 'practice', title: '进程同步', targetMinutes: 90 }],
    tasks: [{ subject: '408', category: 'practice', title: '进程同步习题', kind: 'exercise', minutes: 35, target: 10, reference: 'os-sync-01', branch: '操作系统' }]
  }));
  await save();
  assert.equal(await evaluate('document.querySelector(".lp-content").textContent.includes("进程同步习题")'), false);
  await click('408', '.lp-subject-nav');
  await click('操作系统', '.lp-subsection-nav');
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("进程同步习题")'), 'imported 408 task in its own tab');
  if (process.env.LIFEPILOT_SCREENSHOT_DIR) {
    const image = await new Promise((done, fail) => {
      const requestId = ++id;
      const timeout = setTimeout(() => { ws.removeEventListener('message', listener); fail(Error('Screenshot timeout')); }, 5000);
      function listener(event) {
        const reply = JSON.parse(event.data);
        if (reply.id !== requestId) return;
        clearTimeout(timeout);
        ws.removeEventListener('message', listener);
        if (reply.error) fail(Error(reply.error.message));
        else done(reply.result.data);
      }
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ id: requestId, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    await writeFile(join(process.env.LIFEPILOT_SCREENSHOT_DIR, 'week.png'), Buffer.from(image, 'base64'));
  }
  await click('考研数学', '.lp-subject-nav');
  await click('编辑知识');
  await fill('title', '极限和连续');
  await fill('target', '90');
  await save();
  await click('新增周池任务');
  await fill('title', '极限课程');
  await fill('kind', 'course');
  await fill('minutes', '30');
  await fill('target', '10');
  await save();

  await click('每日');
  await click('生成当日计划');
  await click('专题学习', '.lp-subject-nav');
  await click('每周复盘', '.lp-subsection-nav');
  await click('从周池选择');
  await until(() => evaluate('activeWindow.document.querySelector(\'.lp-modal [data-field="item"] select option:checked\')?.textContent?.includes("专题数学任务")'), 'current subsection prioritized in pool');
  await save();
  await until(() => evaluate('document.querySelector(".lp-task h3")?.textContent === "专题数学任务"'), 'custom subsection carried into daily plan');
  await click('考研数学', '.lp-subject-nav');
  await click('从周池选择');
  await fill('cover', 'yes');
  await save();
  await click('确认计划（旧词不计）');
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("原始计划与调整记录")'), 'plan confirmed');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".lp-task > .lp-actions button")].map(b => b.textContent)'), ['记录成果']);
  await click('记录成果', '.lp-task');
  assert.equal(await evaluate('activeWindow.document.querySelectorAll(".lp-modal input[type=number], .lp-modal input[type=text], .lp-modal textarea").length'), 0);
  assert.equal(await evaluate('activeWindow.document.querySelector(\'.lp-modal [data-field="units"]\').hidden'), true);
  await fill('progress', 'partial');
  assert.equal(await evaluate('activeWindow.document.querySelector(\'.lp-modal [data-field="units"]\').hidden'), false);
  await fill('units', '7');
  await fill('recall', 'yes');
  await fill('actual', '15');
  await save();
  assert.equal(await evaluate('document.querySelector(".lp-task progress")?.value'), 0.7);
  await until(() => evaluate('app.vault.getMarkdownFiles().some(f => f.path.startsWith("LifePilot/Data/day/"))'), 'revision indexed by Obsidian');
  assert.deepEqual(await evaluate('window.lifePilotTempEvents'), []);
  mcp = new Client({ name: 'lifepilot-obsidian-smoke', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/dsh/main.mjs'), '--root', join(vault, 'LifePilot', 'Data'), '--proposals'],
    stderr: 'pipe'
  }));
  const date = await evaluate('document.querySelector(".lp-top time").dateTime');
  assert.equal(await evaluate('document.querySelector(".lp-top input[type=date]") === null'), true);
  const dayResponse = await mcp.callTool({ name: 'today', arguments: { date } });
  assert.equal(dayResponse.isError, undefined);
  const tasks = JSON.parse(dayResponse.content[0].text).tasks;
  assert.equal(tasks[0].completion, 0.7);
  const suggestion = await mcp.callTool({
    name: 'propose', arguments: { date, change: { action: 'progress', task: tasks[0].id, result: { units: 8, recalled: true, actual: 15 } } }
  });
  assert.equal(suggestion.isError, undefined);
  await click('刷新', '.lp-stale');
  await click('接受');
  await until(() => evaluate('document.querySelector(".lp-task progress")?.value === 0.8'), 'MCP proposal accepted by Obsidian');
  await click('移动到栏目', '.lp-task');
  const topic = await evaluate('[...activeWindow.document.querySelectorAll(\'.lp-modal [data-field="section"] option\')].find(o => o.textContent === "专题学习").value');
  await fill('section', topic);
  await save();
  await until(() => evaluate('document.querySelector(".lp-task progress")?.value === 0.8'), 'move preserves recorded completion');
  await click('移动到栏目', '.lp-task');
  await fill('section', '');
  await save();
  await until(() => evaluate('document.querySelector(".lp-task progress")?.value === 0.8'), 'task returned to its subject');
  await click('记一下今天');
  assert.equal(await evaluate('activeWindow.document.querySelectorAll(".lp-modal input:not([type=radio]), .lp-modal textarea").length'), 0);
  await fill('sleep', '420');
  await fill('sleep', '419');
  await fill('sleep', '420');
  await save();
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("睡眠 420 分钟")'), 'sleep stepper saved');
  const uri = 'obsidian://lifepilot?op=sleep&vault=TestVault&date=' + date + '&minutes=450';
  await evaluate('app.workspace.protocolHandler.execCapacitorUrl(' + JSON.stringify(uri) + ')');
  await until(() => evaluate('activeWindow.document.querySelector(".lp-modal .modal-title")?.textContent === "导入睡眠时长"'), 'sleep URI confirmation');
  assert.match(await evaluate('activeWindow.document.querySelector(".lp-modal .lp-form").textContent'), /450 分钟/);
  await save();
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("睡眠 450 分钟")'), 'sleep URI value saved');
  console.log('PASS Obsidian URI: renderer parsed the link, requested confirmation and saved the selected day');
  await click('记一下今天');
  await fill('fulfillment', 'notNeeded');
  await fill('messages', 'yes');
  await fill('chat', 'yes');
  await fill('scrolling', 'yes');
  await fill('fitness', 'recovery');
  await fill('settle', 'yes');
  await fill('journal', 'yes');
  await save();
  await click('报告');
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("学习 15 分钟 · 睡眠 450 分钟")'), 'weekly report updated');
  await click('数据与设置');
  await click('开启设备提醒');
  await until(() => evaluate('app.plugins.plugins.lifepilot.preferences.reminders === true'), 'device settings saved');
  await click('导出业务备份');
  await until(async () => (await readdir(join(vault, 'LifePilot', 'Exports'))).some(n => n.endsWith('.json')), 'backup exported');
  await click('每日');
  if (daylineSource) {
    await mkdir(join(vault, 'TestJournal'), { recursive: true });
    await writeFile(join(vault, 'TestJournal', date + '.md'), '# Dayline existing fixture\n');
    await until(() => evaluate('!!app.vault.getFileByPath("TestJournal/' + date + '.md")'), 'existing Dayline note indexed');
  }
  await click('打开日记');
  const journalFile = daylineSource ? join(vault, 'TestJournal', date + '.md') : join(vault, 'LifePilot', 'Journal', date + '.md');
  const journalText = daylineSource ? /Dayline existing fixture/ : /今天做到了什么/;
  assert.match(await until(async () => readFile(journalFile, 'utf8'), 'journal opened'), journalText);
  if (daylineSource) await until(() => evaluate('app.workspace.getActiveFile()?.path === "TestJournal/' + date + '.md" || app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view.file?.path === "TestJournal/' + date + '.md")'), 'existing Dayline note opened');
  if (daylineSource) {
    const historical = '2025-03-02';
    await evaluate('app.plugins.plugins.lifepilot.open("today", "' + historical + '")');
    await click('打开日记');
    assert.equal(await until(async () => (await readdir(join(vault, 'TestJournal'))).includes(historical + '.md'), 'Dayline created the selected day'), true);
  }
  assert.equal(await readFile(join(vault, 'sentinel.md'), 'utf8'), '# Existing fixture\n');
  console.log('PASS Windows Obsidian: date and time selection, week goals/pool, task result steppers, tap-only check-in, MCP approval, journal, reports, export, original note preserved');
  if (fns) {
    const directory = join(vault, 'LifePilot', 'Data', 'day');
    const readRevisions = async () => Promise.all((await readdir(directory)).filter(name => name.startsWith(date + '--') && name.endsWith('.md'))
      .map(async name => {
        const body = await readFile(join(directory, name), 'utf8');
        return { name, body, ...JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) };
      }));
    const revisions = await readRevisions();
    const parents = new Set(revisions.flatMap(r => r.parents));
    const head = revisions.find(r => !parents.has(r.id));
    const relative = 'LifePilot/Data/day/';
    const headers = { Authorization: 'Bearer ' + restToken, 'X-Client': 'webgui', 'Content-Type': 'application/json' };
    const getNote = async name => {
      const params = new URLSearchParams({ vault: fns.vault, path: relative + name });
      const response = await fetch(fns.api + '/api/note?' + params, { headers });
      return (await response.json()).data?.content;
    };
    await until(async () => (await getNote(head.name)) === head.body, 'FNS uploaded day revision');
    assert.deepEqual(await evaluate('window.lifePilotSyncTrace'), { messages: [], errors: [] });
    assert.equal(await evaluate('app.vault.getAllLoadedFiles().some(f => f.path.includes(".lifepilot-staging"))'), false);
    console.log('PASS FNS atomic save: Markdown uploaded, no temporary attachment actions or error 459');
    await evaluate('app.plugins.plugins["fast-note-sync"].websocket.unRegister()');
    await until(() => evaluate('!app.plugins.plugins["fast-note-sync"].websocket.isAuth'), 'FNS disconnected');
    await click('记一下今天');
    await fill('sleep', '460');
    await save();
    const localBranch = (await readRevisions()).find(r => r.parents.includes(head.id));
    assert.ok(localBranch, 'offline edit was saved in Obsidian');
    const id = randomUUID();
    const remoteName = date + '--' + id + '.md';
    const remoteRevision = { schema: 1, kind: 'day', key: date, id, parents: [head.id],
      at: new Date().toISOString(), data: { ...head.data, behavior: { ...head.data.behavior, sleep: 480 } } };
    const body = head.body.slice(0, head.body.indexOf('{')) + JSON.stringify(remoteRevision, null, 2)
      + head.body.slice(head.body.lastIndexOf('}') + 1);
    const sent = await fetch(fns.api + '/api/note', { method: 'POST', headers, body: JSON.stringify({
      vault: fns.vault, path: relative + remoteName, content: body, ctime: Date.now(), mtime: Date.now(), createOnly: true
    }) });
    const result = await sent.json();
    assert.ok(sent.ok && result.code <= 2, 'FNS fixture write failed with code ' + result.code);
    await evaluate('app.plugins.plugins["fast-note-sync"].websocket.triggerReconnect()');
    await until(async () => (await readFile(join(directory, remoteName), 'utf8')) === body, 'FNS downloaded parallel day revision');
    await click('数据与设置');
    await click('采用此版本');
    await save();
    await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("当前未发现冲突")'), 'FNS conflict resolved in Obsidian');
    const merged = (await readRevisions()).find(r => r.parents.includes(id) && r.parents.includes(localBranch.id));
    assert.ok(merged, 'merge keeps both revisions as parents');
    await until(async () => (await getNote(merged.name)) === merged.body, 'FNS uploaded merged revision');
    console.log('PASS Fast Note Sync: local revision uploaded, offline branch saved, parallel server revision downloaded, Obsidian merge uploaded');
  }
  const virtualDates = Array.from({ length: 7 }, (_, index) => '2025-03-0' + (3 + index));
  const open = (tab, key) => evaluate('app.plugins.plugins.lifepilot.open(' + JSON.stringify(tab) + ', ' + JSON.stringify(key) + ')');
  await open('week', virtualDates[0]);
  await click('新增周池任务');
  await fill('title', '数学练习验收');
  await fill('kind', 'exercise');
  await fill('category', 'practice');
  await fill('minutes', '10');
  await fill('target', '10');
  await save();
  await click('考研英语', '.lp-subject-nav');
  await click('新增周池任务');
  await fill('title', '专项练习验收');
  await fill('subject', 'english');
  await fill('kind', 'training');
  await save();
  await until(() => evaluate('Array.from(document.querySelectorAll(".lp-content h3")).some(el => el.textContent === "专项训练")'), 'specialty task grouped');
  const durations = [];
  for (const [index, key] of virtualDates.entries()) {
    await open('today', key);
    if (index === 2 || index === 6) {
      await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("生成当日计划")'), 'virtual rest day has no generated record');
      continue;
    }
    const planningStart = performance.now();
    await click('生成当日计划');
    await click('编辑学习安排');
    await fill('availability', '90');
    await save();
    if (index === 0) {
      await click('从周池选择');
      await fill('cover', 'yes');
      await save();
      await click('设置词汇量与估时');
      await fill('old', '300');
      await fill('newMinutes', '60');
      await fill('reviewMinutes', '30');
      await save();
    }
    await click(index === 0 ? '确认今日计划' : '确认计划（旧词不计）');
    await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("原始计划与调整记录")'), 'virtual plan confirmed');
    const planning = performance.now() - planningStart;
    if (index === 0) {
      await click('408', '.lp-subject-nav');
      await click('调整', '.lp-task');
      await fill('title', '408 临时换题');
      await fill('reason', '临时有事');
      await save();
      await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("临时有事")'), 'virtual schedule change preserved');
    }
    await click('考研数学', '.lp-subject-nav');
    for (const [taskIndex, units] of (index === 0 ? [7, 1, 120, 150, 0] : [1, 1, 120, null, 1]).entries()) {
      if (units === null) continue;
      await click(['考研数学', '408', '考研英语', '考研英语', 'LeetCode'][taskIndex], '.lp-subject-nav');
      const scope = '.lp-task:nth-child(' + (taskIndex === 3 ? 2 : 1) + ' of .lp-task)';
      await click('记录成果', scope);
      if (index !== 0 || taskIndex === 1 || taskIndex === 2) {
        await fill('progress', 'all');
      } else {
        await fill('progress', units === 0 ? 'none' : 'partial');
        if (units !== 0) await fill('units', String(units));
      }
      await save();
      if (index !== 0 || taskIndex === 1 || taskIndex === 2)
        await until(() => evaluate('document.querySelector(' + JSON.stringify(scope + ' progress') + ')?.value === 1'), 'full completion saved');
    }
    if (index === 0) assert.equal(await evaluate('document.querySelector(".lp-score").textContent.includes("34.5 / 45")'), true);
    const settlingStart = performance.now();
    await click('记一下今天');
    await fill('bedtime', 'onTime');
    await fill('bedPhone', 'none');
    await fill('gettingUp', 'prompt');
    await fill('studyStart', 'onTime');
    await fill('sleep', '450');
    await fill('fulfillment', 'notNeeded');
    await fill('messages', 'yes');
    await fill('chat', 'yes');
    await fill('scrolling', 'yes');
    await fill('fitness', index % 2 ? 'done' : 'recovery');
    await fill('settle', 'yes');
    await fill('journal', 'no');
    await save();
    assert.equal(await evaluate('document.querySelector(".lp-score").textContent.includes("履约（当天无安排）　不适用")'), true);
    durations.push([Math.round(planning), Math.round(performance.now() - settlingStart)]);
  }
  await open('reports', virtualDates[0]);
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("5 个记录日")'), 'five virtual records on weekly report');
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("训练 3/3 天 · 恢复日 2 天")'), 'fitness days summarized separately');
  await open('week', virtualDates[0]);
  await click('考研数学', '.lp-subject-nav');
  await until(() => evaluate('document.querySelector(".lp-content")?.textContent.includes("数学练习验收 · 10 分钟 · 70%")'), 'week pool progress after virtual trial');
  await open('reports', '2025-03-10');
  await until(() => evaluate('document.querySelector(".lp-content .lp-card")?.textContent.includes("0 个记录日")'), 'following week excludes previous week');
  await open('today', '2025-03-10');
  await click('记一下今天');
  await fill('gettingUp', 'prompt');
  await save();
  await until(() => evaluate('document.querySelector(".lp-score")?.textContent.includes("起床后的状态　5 / 5")'), 'tap-only check-in on a fresh day');
  assert.equal(await evaluate('document.querySelector(".lp-disclosure").open'), false);
  console.log('PASS Virtual week: 5/7 saved days, 34.5/45 fixture, adjustment audit, weekly progress and boundary', JSON.stringify(durations));
  await evaluate('app.plugins.plugins.lifepilot.open("today", ' + JSON.stringify(date) + ')');
  const expected = await until(() => evaluate('document.querySelector(".lp-score strong")?.textContent'), 'score rendered before restart');
  const closed = new Promise(done => child.once('exit', done));
  try {
    await evaluate('setTimeout(() => { if (activeWindow !== window) activeWindow.close(); window.close(); }, 0); true');
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) throw error;
  }
  await Promise.race([closed, delay(4000)]);
  if (child.exitCode === null) {
    child.kill();
    await closed;
  }
  ws.close();
  child = launch();
  await connectRenderer();
  await until(() => evaluate('typeof app !== "undefined" && app.vault?.getName() === "TestVault" && !!app.plugins?.manifests?.lifepilot'), 'test Vault re-opened');
  await evaluate(`[...document.querySelectorAll('.modal button')].find(b =>
    /信任仓库作者并启用插件|trust author|trust this vault/i.test(b.textContent))?.click()`);
  await until(async () => {
    const status = await evaluate(`typeof app === "undefined" ? null : {
      vault: app.vault?.getName(), loaded: !!app.plugins?.plugins?.lifepilot,
      modals: [...document.querySelectorAll('.modal-title')].map(el => el.textContent)
    }`);
    if (!status?.loaded) throw Error(JSON.stringify(status));
    return true;
  }, 'plugin loaded after restarting Obsidian');
  await until(() => evaluate('app.plugins.plugins.lifepilot.preferences.reminders === true'), 'device settings reloaded');
  await evaluate('new Promise(done => app.workspace.onLayoutReady(done))');
  await evaluate('app.plugins.plugins.lifepilot.open("today", ' + JSON.stringify(date) + ')');
  assert.equal(await until(() => evaluate('document.querySelector(".lp-score strong")?.textContent'), 'score rendered after restart'), expected);
  assert.equal(await evaluate('document.querySelector(".lp-task progress")?.value'), 0.8);
  await click('专题学习', '.lp-subject-nav');
  await click('每周复盘', '.lp-subsection-nav');
  await until(() => evaluate('document.querySelector(".lp-task h3")?.textContent === "专题数学任务"'), 'custom task hierarchy persisted after restart');
  await click('记录成果', '.lp-task');
  await fill('progress', 'all');
  await save();
  await click('周计划');
  await click('专题学习', '.lp-subject-nav');
  await until(() => evaluate('document.querySelector(".lp-section-progress")?.textContent.includes("栏目得分 8.3 / 20")'), 'main section score includes subsection results');
  await click('每周复盘', '.lp-subsection-nav');
  await until(() => evaluate('document.querySelector(".lp-section-progress")?.textContent.includes("栏目得分 5 / 10")'), 'child section score calculated');
  await evaluate('app.plugins.disablePluginAndSave("lifepilot")');
  await until(() => evaluate('!app.plugins.plugins.lifepilot'), 'LifePilot disabled');
  assert.equal(await readFile(join(vault, 'sentinel.md'), 'utf8'), '# Existing fixture\n');
  assert.match(await readFile(journalFile, 'utf8'), journalText);
  console.log('PASS Restart and disable: saved settings, results, score and original notes retained');
} finally {
  await mcp?.close();
  ws?.close();
  child.kill();
}
