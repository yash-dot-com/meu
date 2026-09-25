import { chromium } from "playwright";

type InteractiveElement = {
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  visible: boolean;
  disabled: boolean;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const page = await browser.newPage({
  viewport: {
    width: 1280,
    height: 720,
  },
});

await page.goto("https://www.google.com", {
  waitUntil: "domcontentloaded",
});

console.log("[page] loaded");
console.log("[page] title:", await page.title());
console.log("[page] url:", page.url());

const elements = await page
  .locator(`
    a,
    button,
    input,
    textarea,
    select,
    [contenteditable="true"],
    [role="button"],
    [role="link"],
    [role="textbox"],
    [role="combobox"],
    [role="checkbox"],
    [role="radio"],
    [role="switch"],
    [role="tab"],
    [role="menuitem"],
    [role="option"]
  `)
  .evaluateAll((nodes): InteractiveElement[] =>
    nodes
      .map((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);

        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";

        const role =
          element.getAttribute("role") ||
          ({
            A: "link",
            BUTTON: "button",
            TEXTAREA: "textbox",
            SELECT: "combobox",
          }[element.tagName] ?? null);

        const rawName =
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.innerText.trim() ||
          "";

        const cleanName = rawName.replace(/\s+/g, " ").trim();

        const name =
          cleanName.length > 120
            ? `${cleanName.slice(0, 120)}…`
            : cleanName;

        const disabled =
          element instanceof HTMLButtonElement ||
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement
            ? element.disabled
            : false;

        return {
          tag: element.tagName.toLowerCase(),
          role,
          name,
          type:
            element instanceof HTMLInputElement
              ? element.type
              : null,
          visible,
          disabled,
          box: visible
            ? {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }
            : null,
        };
      })
      .filter((element) => element.visible && element.name.length > 0),
  );

console.log(`\n[observe] interactive elements: ${elements.length}\n`);

for (const [index, element] of elements.entries()) {
  console.log(
    `${index + 1}. ${element.role ?? element.tag} "${element.name}"`,
  );

  console.log(
    `   box=${JSON.stringify(element.box)} disabled=${element.disabled}`,
  );
}

await page.screenshot({
  path: "artifacts/04-interactive.png",
  fullPage: true,
});

console.log("\n[screenshot] saved");

await browser.close();

console.log("[browser] closed");