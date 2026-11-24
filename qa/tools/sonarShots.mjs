// Screenshots of the local SonarQube project pages (for the report). node tools/sonarShots.mjs <password>
import { Builder, By } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { writeFileSync } from 'node:fs';
const d = await new Builder().forBrowser('chrome').setChromeOptions(new chrome.Options().addArguments('--headless=new', '--window-size=1500,1100')).build();
const S = 'http://localhost:9000';
try {
  await d.get(`${S}/sessions/new`);
  await d.sleep(2000);
  // Sign in through the same endpoint the login form posts to; the session cookie lands in the browser.
  const status = await d.executeAsyncScript(`const done = arguments[arguments.length - 1];
    fetch('/api/authentication/login', { method: 'POST', body: new URLSearchParams({ login: 'admin', password: arguments[0] }) })
      .then((r) => done(r.status), (e) => done(String(e)));`, process.argv[2]);
  if (status !== 200) throw new Error(`login failed: ${status}`);
  const pages = {
    'sonar-overview': `${S}/dashboard?id=cheesybeez-pos&codeScope=overall`,
    'sonar-measures': `${S}/component_measures?id=cheesybeez-pos&metric=Maintainability&view=list`,
    'sonar-issues': `${S}/project/issues?id=cheesybeez-pos&issueStatuses=OPEN%2CCONFIRMED&facetMode=count&types=BUG`,
    'sonar-parser': `${S}/project/issues?id=cheesybeez-pos&files=src%2Fdomain%2Fparser.ts&issueStatuses=OPEN%2CCONFIRMED`,
  };
  const dismiss = async () => {
    for (const label of ['Later', 'Dismiss', 'Got it', 'Close']) {
      for (const b of await d.findElements(By.xpath(`//button[normalize-space(.)="${label}"]`))) { try { await b.click(); await d.sleep(500); } catch {} }
    }
    for (const b of await d.findElements(By.css('[aria-label="Dismiss"], [aria-label="Close"]'))) { try { await b.click(); } catch {} }
  };
  await d.get(pages['sonar-overview']); await d.sleep(5000); await dismiss(); await dismiss();
  await d.manage().window().setRect({ width: 1500, height: 1500 });
  for (const [name, url] of Object.entries(pages)) {
    await d.get(url); await d.sleep(5000); await dismiss(); await d.sleep(800);
    // Hide SonarQube's own tours, banners and promos so the numbers are visible.
    await d.executeScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (const el of document.querySelectorAll('[role=dialog], [role=menu], [class*=joyride], [class*=tooltip], [data-floating-ui-portal], [class*=Banner], [class*=banner]')) el.remove();
      for (const el of [...document.querySelectorAll('div')].filter((e) => /^Get the most out of SonarQube/.test(e.innerText ?? '') && e.offsetHeight < 300)) el.remove();
      for (const el of [...document.querySelectorAll('div')].filter((e) => /^(Keep your instance current|To benefit from more|You can replay the tour)/.test(e.innerText ?? '') && e.offsetHeight < 90)) el.remove(); document.activeElement?.blur();`);
    await d.sleep(500);
    writeFileSync(`evidence/shots/${name}.png`, await d.takeScreenshot(), 'base64');
  }
} finally { await d.quit(); }
