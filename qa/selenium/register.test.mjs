/**
 * EC4206 3.6 Selenium UI automation of the Register (the cashier's screen).
 *   APP_URL=http://localhost:5179 node --test selenium/register.test.mjs
 * Screenshots of each step go to evidence/shots/ui-*.png.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Builder, By, Key, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const APP = process.env.APP_URL ?? 'http://localhost:5179/';
const SHOTS = new URL('../evidence/shots/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });
let d;
const shot = async (name) => writeFileSync(new URL(`ui-${name}.png`, SHOTS), await d.takeScreenshot(), 'base64');
const text = async () => d.findElement(By.css('body')).getText();
const net = async () => (await text()).match(/NET AMOUNT\s+([\d,]+)/)?.[1];
const typeOrder = async (order) => {
  await d.findElement(By.css('input[aria-label^="Type or search"]')).click();
  const box = await d.wait(until.elementLocated(By.css('input[aria-label="Type an order"]')), 5000);
  await d.sleep(300);
  await box.click();
  await box.sendKeys(order);
  await d.sleep(300);
  await d.actions().sendKeys(Key.ENTER).perform();
  await d.sleep(500);
};

before(async () => {
  d = await new Builder().forBrowser('chrome')
    .setChromeOptions(new chrome.Options().addArguments('--headless=new', '--window-size=1400,900', '--force-device-scale-factor=1')).build();
  await d.get(APP);
  await d.wait(until.elementLocated(By.css('input[aria-label^="Type or search"]')), 15000);
});
after(async () => d?.quit());

test('UI-01 the Register opens with an empty bill and PAY greyed, not hidden', async () => {
  assert.match(await text(), /Tap an item to start the bill/);
  const pay = await d.findElement(By.xpath('//button[starts-with(translate(normalize-space(.), "pay", "PAY"), "PAY")]'));
  assert.equal(await pay.isDisplayed(), true);
  assert.equal(await pay.isEnabled(), false);
  await shot('01-empty');
});

test('UI-02 tapping Margherita M adds Rs 1,450 to the bill', async () => {
  await d.findElement(By.xpath('//button[normalize-space(.)="M 1,450"]')).click();
  await d.sleep(400);
  assert.equal(await net(), '1,450');
  await shot('02-tap');
});

test('UI-03 typed shorthand adds 2 L Devilled Chicken (no onion) and a burger', async () => {
  await typeOrder('2 L devilled chicken no onion, burger');
  const t = await text();
  assert.match(t, /Devilled Chicken/);
  assert.match(t, /No onion/i);
  assert.equal(await net(), '6,900'); // 1,450 + 2 x 2,500 + 450
  await shot('03-typed');
});

test('UI-04 F2 then Enter pays exact cash and the bill moves to Paid today', async () => {
  await d.actions().sendKeys(Key.F2).perform();
  await d.sleep(600);
  assert.match(await text(), /Exact cash 6,900/);
  await shot('04-pay');
  await d.actions().sendKeys(Key.ENTER).perform();
  await d.sleep(800);
  const t = await text();
  assert.match(t, /SALES TODAY\s+6,900/);
  await shot('05-paid');
});
