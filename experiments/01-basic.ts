import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
});

const page = await browser.newPage();

await page.goto("https://example.com");

console.log("Title:", await page.title());
console.log("URL:", page.url());

await page.screenshot({
  path: "artifacts/example.png",
  fullPage: true,
});

await browser.close();