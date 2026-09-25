import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const page = await browser.newPage();

await page.goto("https://www.google.com", {
  waitUntil: "domcontentloaded",
});

console.log("[page] loaded");
console.log("[page] title:", await page.title());

const ariaSnapshot = await page.ariaSnapshot({
  mode: "ai",
  depth: 4,
  boxes: true,
});

console.log("\n[aria] semantic tree:\n");
console.log(ariaSnapshot);

await page.screenshot({
  path: "artifacts/03-aria.png",
  fullPage: true,
});

console.log("\n[screenshot] saved");
await browser.close();

console.log("[browser] closed");