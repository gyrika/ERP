/**
 * /get: the page a shop owner opens to install CheesyBeez. One button, always the newest
 * release (read from GitHub, cached by Cloudflare for 10 minutes), the three steps that
 * avoid surprises, and on a phone, a nudge to open it on the shop's computer instead.
 */
const LATEST = 'https://api.github.com/repos/gyrika/ERP/releases/latest';
const RELEASES = 'https://github.com/gyrika/ERP/releases/latest';

export interface Release { version: string; url: string; sizeMb: number }

export const latestRelease = async (http: typeof fetch = fetch): Promise<Release | null> => {
  try {
    const r = await http(LATEST, {
      headers: { 'user-agent': 'CheesyBeez-Cloud', accept: 'application/vnd.github+json' },
      // Cloudflare keeps GitHub's answer for 10 minutes: fast for the owner, gentle on GitHub.
      cf: { cacheTtl: 600, cacheEverything: true },
    } as RequestInit);
    if (!r.ok) return null;
    const rel = (await r.json()) as { tag_name?: string; assets?: { name: string; size: number; browser_download_url: string }[] };
    const exe = rel.assets?.find((a) => /^CheesyBeez-Setup-.*\.exe$/.test(a.name));
    if (!rel.tag_name || !exe) return null;
    return { version: rel.tag_name.replace(/^v/, ''), url: exe.browser_download_url, sizeMb: Math.round(exe.size / 1_048_576) };
  } catch {
    return null;
  }
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const downloadPage = (rel: Release | null): string => {
  const href = rel ? esc(rel.url) : RELEASES;
  const meta = rel ? `Windows 10 or 11 · ${rel.sizeMb} MB · version ${esc(rel.version)}` : 'Windows 10 or 11';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Get CheesyBeez</title>
<meta name="description" content="The POS for your shop: counter, kitchen and your phone, in one.">
<meta property="og:title" content="CheesyBeez for your shop">
<meta property="og:description" content="Counter, kitchen and your phone, in one. Download for Windows.">
<meta property="og:image" content="/icons/icon-512.png">
<link rel="icon" type="image/png" href="/icons/favicon-32.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap">
<style>
/* One honeycomb cell, one button, three steps: the whole job of the page. */
:root{--bg:#F2F1EF;--card:#FFF;--fg:#1C1C1E;--muted:#6E6D72;--line:#E3E1DE;--honey:#E8A94B;--honey-ink:#9A5F12;--ink:#1C1C1E}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B0C;--card:#1C1C1E;--fg:#F5F5F7;--muted:#A1A1A6;--line:#2C2C2E;--honey-ink:#E8A94B;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 "DM Sans",system-ui,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:clamp(24px,6vw,64px) 20px 56px;display:flex;flex-direction:column;gap:clamp(32px,6vw,56px)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.brand img{width:32px;height:32px;border-radius:8px}
.hero{display:grid;grid-template-columns:1fr auto;gap:40px;align-items:center}
.hero img.big{width:clamp(120px,22vw,200px);height:auto;border-radius:28%;box-shadow:0 24px 60px rgba(232,169,75,.28),0 2px 8px rgba(0,0,0,.12)}
h1{margin:0 0 14px;font-size:clamp(36px,7vw,60px);line-height:1.04;letter-spacing:-.04em;font-weight:600;text-wrap:balance}
h1 span{color:var(--honey-ink)}
.lead{margin:0 0 28px;font-size:clamp(17px,2.4vw,20px);color:var(--muted);max-width:30em}
.get{display:inline-flex;align-items:center;gap:12px;min-height:60px;padding:0 30px;border-radius:16px;background:var(--ink);color:#fff;font-weight:600;font-size:18px;text-decoration:none;transition:transform .15s ease,box-shadow .15s ease;box-shadow:0 10px 30px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){.get{background:var(--honey);color:#1C1C1E}}
.get:hover{transform:translateY(-1px);box-shadow:0 14px 36px rgba(0,0,0,.22)}
.get:focus-visible{outline:3px solid var(--honey);outline-offset:3px}
.meta{margin:12px 0 0;font-size:14px;color:var(--muted)}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;list-style:none;margin:0;padding:0;counter-reset:s}
.steps li{background:var(--card);border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:6px;counter-increment:s}
.steps li::before{content:counter(s);width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--honey);color:#1C1C1E;font-weight:600;font-size:15px;margin-bottom:6px}
.steps b{font-size:17px}
.steps span{color:var(--muted);font-size:15px}
.phone{display:none;background:var(--card);border-radius:18px;padding:20px 22px;gap:12px;flex-direction:column}
.phone p{margin:0}
.copy{align-self:flex-start;min-height:48px;padding:0 20px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-weight:600;cursor:pointer}
.foot{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;color:var(--muted);font-size:15px;border-top:1px solid var(--line);padding-top:24px}
.foot b{display:block;color:var(--fg);font-weight:600;margin-bottom:2px}
@media (max-width:720px){.hero{grid-template-columns:1fr}.hero img.big{order:-1;width:96px}.steps,.foot{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.get{transition:none}}
</style></head><body>
<div class="wrap">
  <div class="brand"><img src="/icons/icon-192.png" alt="">CheesyBeez</div>
  <section class="hero">
    <div>
      <h1>The POS for your shop. <span>Counter, kitchen and your phone, in one.</span></h1>
      <p class="lead">Take orders in seconds, send them to the kitchen screen, print the receipt, and see your day on your phone from anywhere.</p>
      <div id="pc"><a class="get" href="${href}">Download for Windows</a><p class="meta">${meta}</p></div>
      <div class="phone" id="phone">
        <p><b>Open this page on the shop's computer.</b> CheesyBeez is installed there; your phone app comes from the QR code at the end of setup.</p>
        <button class="copy" id="copy" type="button">Copy the link</button>
      </div>
    </div>
    <img class="big" src="/icons/icon-512.png" alt="CheesyBeez">
  </section>
  <ol class="steps">
    <li><b>Download</b><span>Open the file when it has downloaded.</span></li>
    <li><b>Run anyway</b><span>If Windows says "Windows protected your PC", click <i>More info</i>, then <i>Run anyway</i>, then <i>Yes</i>.</span></li>
    <li><b>Set up your shop</b><span>Your shop, your printer, your staff, then scan the QR code with your phone. About five minutes.</span></li>
  </ol>
  <div class="foot">
    <div><b>Works without internet</b>Selling never stops when the connection does.</div>
    <div><b>Keeps itself up to date</b>New versions install by themselves at night.</div>
    <div><b>Your sales, kept safe</b>A copy goes to the cloud whenever the internet is up.</div>
  </div>
</div>
<script>
// On a phone there is nothing to install here: say where to go instead.
if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  document.getElementById('pc').style.display = 'none';
  document.getElementById('phone').style.display = 'flex';
}
document.getElementById('copy').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Copied'; }
  catch { e.target.textContent = location.href; }
});
</script></body></html>`;
};
