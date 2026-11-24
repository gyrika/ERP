/**
 * Evidence screenshots: renders a captured terminal log as a terminal window (headless Chrome)
 *   node tools/shot.mjs <log.txt> <out.png> "<window title>" [first line] [last line]
 * or a live page:  node tools/shot.mjs --url <url> <out.png> [width] [height]
 */
import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const opts = new chrome.Options().addArguments('--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1.5');
const driver = await new Builder().forBrowser('chrome').setChromeOptions(opts).build();
try {
  if (args[0] === '--url') {
    const [, url, out, w = '1400', h = '900'] = args;
    await driver.manage().window().setRect({ width: +w, height: +h });
    await driver.get(url);
    await driver.sleep(2500);
    writeFileSync(out, await driver.takeScreenshot(), 'base64');
  } else {
    const [log, out, title, from, to] = args;
    let lines = readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    if (from) lines = lines.slice(Number(from) - 1, to ? Number(to) : undefined);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const color = (l) => /# BUG-|# TODO/.test(l) ? '#e8a94b' : /✖|not ok|FAIL|fail [1-9]|Error|error:/.test(l) ? '#ff6b6b' : /# TODO|todo [1-9]|﹣|warn/.test(l) ? '#e8a94b' : /✔|^ok |PASS|passed|pass [1-9]|✓/.test(l) ? '#5fd38d' : '#d6d6d6';
    const body = lines.map((l) => `<div style="color:${color(l)}">${esc(l) || '&nbsp;'}</div>`).join('');
    const html = `<html><body style="margin:0;background:#1e1e1e;font:13px/1.45 'DejaVu Sans Mono',monospace">
<div style="background:#323232;color:#bbb;padding:7px 12px;font:13px sans-serif"><span style="color:#ff5f56">●</span> <span style="color:#ffbd2e">●</span> <span style="color:#27c93f">●</span>&nbsp;&nbsp; ${esc(title)} — gyrika@ubuntu: ~/ERP</div>
<div id="t" style="padding:10px 14px;white-space:pre;display:inline-block;min-width:900px">${body}</div></body></html>`;
    const file = join(tmpdir(), `shot-${process.pid}.html`);
    writeFileSync(file, html);
    await driver.manage().window().setRect({ width: 1200, height: 800 });
    await driver.get(pathToFileURL(file).href);
    const { w, h } = await driver.executeScript('const t=document.body;return {w:Math.max(1000,t.scrollWidth),h:t.scrollHeight}');
    await driver.manage().window().setRect({ width: Math.min(w + 20, 1800), height: Math.min(h + 140, 6000) });
    const el = await driver.findElement({ css: 'body' });
    writeFileSync(out, await el.takeScreenshot(), 'base64');
  }
} finally { await driver.quit(); }
