// End-to-end test: two real Chromium browsers with fake camera/mic, talking through the server.
// Usage:  DEV_LOGIN=true PORT=8099 node server.js &   then   node tests/e2e.mjs
// Requires: npm i -D playwright (or a global Playwright install).
import { chromium, devices } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8099';
const OUT = process.env.OUT || path.join(os.tmpdir(), 'ps-e2e');
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
let step = 0;
const ok = msg => console.log(`  ✓ ${++step}. ${msg}`);
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function makeFile(name, size) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, crypto.randomBytes(size));
  return p;
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required'],
});

async function person(name, opts = {}) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|Failed to load resource/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`); });
  await page.goto(BASE);
  await page.fill('#dev-name', name);
  await page.click('#dev-form button[type=submit]');
  await page.waitForSelector('#view-home:not([hidden])');
  return { ctx, page, name };
}

const shot = (p, n) => p.page.screenshot({ path: path.join(OUT, `${n}.png`) });

async function select(a, b) {
  await a.page.click(`.person:has-text("${b.name}")`);
}
async function waitConnected(p) {
  await p.page.waitForFunction(() => document.querySelector('#call-meta')?.textContent.includes('Encrypted'), null, { timeout: 30000 });
}
async function videoSize(p, sel) {
  return p.page.$eval(sel, v => ({ w: v.videoWidth, h: v.videoHeight, hidden: v.hidden, paused: v.paused }));
}
async function waitVideo(p, sel) {
  await p.page.waitForFunction(s => { const v = document.querySelector(s); return v && !v.hidden && v.videoWidth > 0; }, sel, { timeout: 20000 });
}
async function remoteAudioLive(p) {
  return p.page.$eval('#remote-audio', a => !!a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live'));
}
async function hangup(a, b) {
  await a.page.click('#c-end');
  await a.page.waitForSelector('#view-home:not([hidden])');
  await b.page.waitForSelector('#view-home:not([hidden])', { timeout: 10000 });
}
async function pickFiles(p, trigger, files) {
  const [chooser] = await Promise.all([p.page.waitForEvent('filechooser'), p.page.click(trigger)]);
  await chooser.setFiles(files);
}
async function saveAndHash(p, fileName) {
  const link = p.page.locator(`#call-files .xfer:has-text("${fileName}") a[download]`).first();
  await link.waitFor({ timeout: 60000 });
  const [dl] = await Promise.all([p.page.waitForEvent('download'), link.click()]);
  const dest = path.join(OUT, `got-${p.name}-${fileName}`);
  await dl.saveAs(dest);
  return sha(fs.readFileSync(dest));
}

try {
  console.log(`Testing ${BASE}`);
  await (async () => {
    const pg = await (await browser.newContext()).newPage();
    await pg.goto(BASE); await pg.waitForSelector('#view-login:not([hidden])');
    await pg.screenshot({ path: path.join(OUT, '01-login-desktop.png') });
    await pg.context().close();
  })();

  const A = await person('Asha');
  const B = await person('Bilal');
  await A.page.waitForSelector('.person:has-text("Bilal")');
  await B.page.waitForSelector('.person:has-text("Asha")');
  ok('both people signed in and see each other online');
  await select(A, B);
  await shot(A, '02-home-desktop');

  // ---------------- video call
  await A.page.click('[data-start=video]');
  await B.page.waitForSelector('[data-answer]');
  await shot(B, '03-incoming-desktop');
  await B.page.click('[data-answer]');
  await waitConnected(A); await waitConnected(B);
  await waitVideo(A, '#v-main'); await waitVideo(B, '#v-main');
  ok(`video call connected both ways (A sees ${JSON.stringify(await videoSize(A, '#v-main'))}, B sees ${JSON.stringify(await videoSize(B, '#v-main'))})`);
  if (!(await remoteAudioLive(A)) || !(await remoteAudioLive(B))) throw new Error('remote audio missing');
  ok('remote audio tracks are live on both sides');
  const codeA = await A.page.textContent('#btn-safety b'), codeB = await B.page.textContent('#btn-safety b');
  if (!codeA || codeA !== codeB) throw new Error(`safety codes differ: ${codeA} vs ${codeB}`);
  ok(`safety codes match on both screens (${codeA})`);

  // mute + camera off reflected remotely
  await A.page.click('#c-cam');
  await B.page.waitForFunction(() => document.querySelector('#v-main').hidden, null, { timeout: 10000 });
  ok('turning the camera off hides it for the other person');
  await A.page.click('#c-cam');
  await waitVideo(B, '#v-main');
  ok('turning the camera back on shows it again');

  // ---------------- screen share inside the call
  await A.page.click('#c-screen');
  await B.page.waitForFunction(() => !document.querySelector('#v-remote-cam').hidden && document.querySelector('#v-main').videoWidth > 0, null, { timeout: 20000 });
  const scr = await videoSize(B, '#v-main');
  ok(`screen share received: main stage shows A's screen ${scr.w}x${scr.h}, A's camera moves to the corner`);
  await shot(B, '04-call-screen-desktop');
  await A.page.click('#c-screen');
  await B.page.waitForFunction(() => document.querySelector('#v-remote-cam').hidden, null, { timeout: 10000 });
  ok('stopping the screen share returns the stage to the camera');

  // ---------------- file transfer during the call (both directions)
  const big = makeFile('photo-archive.bin', 24 * 1024 * 1024 + 123);
  await A.page.click('#c-files');
  await pickFiles(A, '#files-panel [data-action=pick-files]', [big]);
  const acc = B.page.locator('[data-accept-file]').first();
  await acc.waitFor({ timeout: 15000 });
  const t0 = Date.now();
  await acc.click();
  const gotHash = await saveAndHash(B, 'photo-archive.bin');
  const secs = (Date.now() - t0) / 1000;
  if (gotHash !== sha(fs.readFileSync(big))) throw new Error('file hash mismatch');
  ok(`24 MB file sent A→B, SHA-256 identical (${(24 / secs).toFixed(1)} MB/s)`);
  await A.page.waitForSelector('#call-files .xfer:has-text("Delivered and verified")', { timeout: 15000 });
  ok('sender sees "Delivered and verified"');
  const small = makeFile('notes.txt', 3000);
  await pickFiles(B, '#files-panel [data-action=pick-files]', [small]);
  await A.page.locator('[data-accept-file]').first().click({ timeout: 15000 });
  if ((await saveAndHash(A, 'notes.txt')) !== sha(fs.readFileSync(small))) throw new Error('reverse file hash mismatch');
  ok('file sent the other way B→A, hash identical');
  await shot(A, '05-call-files-desktop');

  // decline
  const nope = makeFile('declined.bin', 1000);
  await pickFiles(A, '#files-panel [data-action=pick-files]', [nope]);
  await B.page.locator('[data-decline-file]').first().click({ timeout: 15000 });
  await A.page.waitForSelector('#call-files .xfer:has-text("They declined")', { timeout: 10000 });
  ok('declining a file is reported to the sender');

  await hangup(B, A);
  ok('hang-up ends the call on both sides');

  // ---------------- voice call
  await select(A, B);
  await A.page.click('[data-start=voice]');
  await B.page.click('[data-answer]', { timeout: 15000 });
  await waitConnected(A); await waitConnected(B);
  if (!(await remoteAudioLive(A)) || !(await remoteAudioLive(B))) throw new Error('voice audio missing');
  if (!(await A.page.$eval('#v-main', v => v.hidden))) throw new Error('voice call should not show video');
  ok('voice call connected with live audio both ways and no video');
  await A.page.click('#c-mic');
  await B.page.waitForFunction(() => document.querySelector('#stage-status').textContent.includes('muted'), null, { timeout: 10000 });
  ok('muting is shown to the other person');
  await shot(B, '06-voice-desktop');
  await B.page.click('#c-cam');
  await waitVideo(A, '#v-main');
  ok('upgrading a voice call to video works without redialling');
  await hangup(A, B);

  // ---------------- decline + busy
  await select(A, B);
  await A.page.click('[data-start=voice]');
  await B.page.click('[data-decline]', { timeout: 15000 });
  await A.page.waitForSelector('#view-home:not([hidden])', { timeout: 10000 });
  ok('declined call returns the caller to the list');

  // ---------------- "Send files" from the list (file intent)
  const f1 = makeFile('report.pdf', 700 * 1024), f2 = makeFile('song.mp3', 5 * 1024 * 1024 + 7);
  await select(A, B);
  await pickFiles(A, '[data-start=file]', [f1, f2]);
  await B.page.waitForSelector('[data-answer]');
  const listed = await B.page.textContent('.file-preview');
  if (!listed.includes('report.pdf') || !listed.includes('song.mp3')) throw new Error('incoming modal does not list files');
  await B.page.click('[data-answer]');
  if ((await saveAndHash(B, 'report.pdf')) !== sha(fs.readFileSync(f1))) throw new Error('report hash mismatch');
  if ((await saveAndHash(B, 'song.mp3')) !== sha(fs.readFileSync(f2))) throw new Error('song hash mismatch');
  ok('"Send files" from the list: receiver accepts once, both files arrive with matching hashes');
  await hangup(A, B);
  await B.page.waitForSelector('#received-list .xfer:has-text("song.mp3")');
  ok('received files stay available on the home screen after the call');

  // ---------------- "Share screen" from the list, watched on a phone
  const P = await person('Phone', { ...devices['iPhone 13'], permissions: ['camera', 'microphone'] });
  await A.page.waitForSelector('.person:has-text("Phone")');
  await P.page.screenshot({ path: path.join(OUT, '07-home-phone.png') });
  await P.page.click('.person:has-text("Asha")');
  await P.page.screenshot({ path: path.join(OUT, '08-sheet-phone.png') });
  await P.page.click('[data-action=close-line]');
  await select(A, P);
  await A.page.click('[data-start=screen]');
  await P.page.waitForSelector('[data-answer]');
  await P.page.screenshot({ path: path.join(OUT, '09-incoming-phone.png') });
  await P.page.click('[data-answer]');
  await waitConnected(P);
  await waitVideo(P, '#v-main');
  ok(`phone-sized viewer watches the shared screen (${JSON.stringify(await videoSize(P, '#v-main'))})`);
  await P.page.screenshot({ path: path.join(OUT, '10-screen-phone.png') });
  await P.page.click('#c-cam');
  await waitVideo(A, '#v-main');
  await P.page.screenshot({ path: path.join(OUT, '11-call-phone.png') });
  await P.page.click('#c-files');
  await P.page.screenshot({ path: path.join(OUT, '12-files-phone.png') });
  ok('phone turns on its camera during the screen share; sharer sees it');
  await hangup(P, A);

  // ---------------- key change warning
  await B.ctx.clearCookies();
  await B.page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('private-share-identity-v1'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await B.page.reload();
  await B.page.waitForSelector('#view-home:not([hidden])');
  await A.page.waitForSelector('.person:has-text("Bilal")');
  await select(A, B);
  await A.page.click('[data-start=voice]');
  await B.page.click('[data-answer]', { timeout: 15000 });
  await A.page.waitForSelector('.modal:has-text("Security key changed")', { timeout: 15000 });
  ok('a changed device key triggers the "Security key changed" warning');
  await A.page.click('.modal [data-yes]');
  await waitConnected(A);
  ok('trusting the new key connects the call');
  await hangup(A, B);
} catch (e) {
  errors.push(`FAILED at step ${step + 1}: ${e.stack || e.message}`);
}

await browser.close();
if (errors.length) { console.log('\nProblems:\n' + errors.map(e => '  ✗ ' + e).join('\n')); process.exit(1); }
console.log(`\nAll ${step} checks passed. Screenshots in ${OUT}`);
