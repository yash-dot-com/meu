import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const page = await browser.newPage();

await page.goto("https://www.google.com/");

console.log("[page] loaded");
console.log("[page] title:", await page.title());
console.log("[page] url:", page.url());

// Links
const links = await page.locator("a").evaluateAll((elements) =>
  elements.map((element) => ({
    text: element.textContent?.trim() ?? "",
    href: (element as HTMLAnchorElement).href,
  })),
);

// Buttons
const buttons = await page.locator("button").evaluateAll((elements) =>
  elements.map((element) => ({
    text: element.textContent?.trim() ?? "",
  })),
);

// Inputs
const inputs = await page.locator("input").evaluateAll((elements) =>
  elements.map((element) => ({
    type: (element as HTMLInputElement).type,
    name: (element as HTMLInputElement).name,
    placeholder: (element as HTMLInputElement).placeholder,
  })),
);

console.log("[observe] links:", links);
console.log("[observe] buttons:", buttons);
console.log("[observe] inputs:", inputs);

await page.screenshot({
  path: "artifacts/02-observe.png",
  fullPage: true,
});

console.log("[screenshot] saved");

await browser.close();

console.log("[browser] closed");