#!/usr/bin/env node
// Draws an `answer` post frame by frame: scene.html in a headless Chrome over the DevTools protocol (Node's built-in
// WebSocket, no library), seeked to each frame's time and screenshotted at 1080x1920. Deterministic: every frame is the
// page at exactly t = i / fps, so nothing drops. CPU only, no network: the page loads nothing from outside.
//   node frames.mjs --spec spec.json --font <InterVariable.ttf> --out <dir> [--fps 30] [--times 1.5,6,12]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(args.out);
const FPS = Number(args.fps ?? 30);
const CHROME = args.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const html = fs.readFileSync(path.join(HERE, 'scene.html'), 'utf8').replace('INTER_URL', pathToFileURL(path.resolve(args.font)).href);
const page = path.join(out, 'scene.html');
fs.writeFileSync(page, html);
const spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-answer-'));
const chromeArgs = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=540,960',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
  // GitHub's Ubuntu runners block the user namespaces Chrome's sandbox needs; the page is our own file and loads nothing else.
  // /dev/shm is small on runners and there is no GPU: both are common reasons headless Chrome dies at start.
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []), 'about:blank'];
let chrome, chromeErr = '', chromeExit = null;
function startChrome() {
  chromeErr = ''; chromeExit = null;
  chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (d) => { chromeErr = (chromeErr + d).slice(-2000); });
  chrome.on('exit', (code, sig) => { chromeExit = sig || code; });
  chrome.on('error', (e) => { chromeExit = e.message; });
}
// Waits up to 60 s for Chrome to write its port; says why when it does not (exit code and Chrome's own stderr)
async function waitForPort(portFile) {
  for (let i = 0; i < 600 && !fs.existsSync(portFile); i++) {
    if (chromeExit !== null) break;
    await sleep(100);
  }
  if (fs.existsSync(portFile)) return fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  throw new Error(`Chrome wrote no DevToolsActivePort (${chromeExit !== null ? `exited: ${chromeExit}` : 'still running after 60 s'}). `
    + `Chrome stderr: ${chromeErr.trim().slice(-800) || '(empty)'}`);
}
startChrome();

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msg = { id: ++id, method, params };
  pending.set(msg.id, { resolve, reject, method });
  ws.send(JSON.stringify(msg));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

async function main() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port;
  try { port = await waitForPort(portFile); } catch (e) {
    console.error(`frames: first start failed, retrying once: ${e.message}`);
    chrome.kill();
    await sleep(1000);
    startChrome();
    port = await waitForPort(portFile);
  }
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    if (!target) await sleep(100);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 540, height: 960, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: pathToFileURL(page).href });
  for (let i = 0; i < 100 && !(await evaluate('typeof window.load === "function"').catch(() => false)); i++) await sleep(100);
  const seconds = await evaluate(`window.load(${JSON.stringify(spec)})`);
  // --times 1.5,6,12 draws only those moments (a review sheet); otherwise every frame
  const times = args.times ? String(args.times).split(',').map(Number) : Array.from({ length: Math.ceil(seconds * FPS) }, (_, i) => i / FPS);
  const n = times.length;
  for (let i = 0; i < n; i++) {
    await evaluate(`window.seek(${times[i].toFixed(4)})`);
    if (args.times) await sleep(400);  // let any hotlinked image finish loading
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93, captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify({ frames: n, seconds }));
}

main()
  .catch((e) => { console.error(`frames: ${e.message}`); process.exitCode = 1; })
  .finally(() => {
    try { ws?.close(); } catch {}
    chrome.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1500);
  });
