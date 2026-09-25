import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

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

type UIState = {
  id: string;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
  ariaSnapshot: string;
  interactiveElements: InteractiveElement[];
  screenshot: string;
  fingerprint: string;
};

function createFingerprint(
  url: string,
  title: string,
  ariaSnapshot: string,
  elements: InteractiveElement[],
): string {
  // Coordinates are intentionally excluded.
  // Layout movement should NOT create a new state identity.

  const normalizedAria = ariaSnapshot
    .replace(/\[ref=[^\]]+\]/g, "")
    .replace(/\[box=[^\]]+\]/g, "")
    .replace(/\[cursor=[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedElements = elements.map((element) => ({
    tag: element.tag,
    role: element.role,
    name: element.name,
    type: element.type,
    visible: element.visible,
    disabled: element.disabled,
  }));

  const identity = JSON.stringify({
    url,
    title,
    aria: normalizedAria,
    elements: normalizedElements,
  });

  return createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 16);
}

async function captureState(page: import("playwright").Page): Promise<UIState> {
  console.log("[state] capturing...");

  const title = await page.title();
  const url = page.url();

  const viewport = page.viewportSize();

  if (!viewport) {
    throw new Error("Viewport size unavailable");
  }

  console.log("[state] title:", title);
  console.log("[state] url:", url);

  // Semantic representation.
  const ariaSnapshot = await page.ariaSnapshot({
    mode: "ai",
    depth: 10,
    boxes: true,
  });

  console.log(
    "[state] aria snapshot length:",
    ariaSnapshot.length,
  );

  // Interactive elements.
  const interactiveElements = await page
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
        .filter(
          (element) =>
            element.visible &&
            element.name.length > 0,
        ),
    );

  console.log(
    "[state] interactive elements:",
    interactiveElements.length,
  );

  const fingerprint = createFingerprint(
    url,
    title,
    ariaSnapshot,
    interactiveElements,
  );

  console.log("[state] fingerprint:", fingerprint);

  const screenshotPath = `artifacts/state-${fingerprint}.png`;

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  console.log("[state] screenshot:", screenshotPath);

  return {
    id: `state_${fingerprint}`,
    url,
    title,
    viewport,
    ariaSnapshot,
    interactiveElements,
    screenshot: screenshotPath,
    fingerprint,
  };
}

await mkdir("artifacts", { recursive: true });

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

const state = await captureState(page);

console.log("\n[state] summary");
console.log({
  id: state.id,
  title: state.title,
  url: state.url,
  interactiveElements: state.interactiveElements.length,
  screenshot: state.screenshot,
  fingerprint: state.fingerprint,
});

console.log("\n[state] first 8 interactive elements:");

for (const [index, element] of state.interactiveElements
  .slice(0, 8)
  .entries()) {
  console.log(
    `${index + 1}. ${element.role} "${element.name}"`,
  );
}

console.log("\n[aria] first 20 lines:\n");

console.log(
  state.ariaSnapshot
    .split("\n")
    .slice(0, 20)
    .join("\n"),
);

await browser.close();

console.log("\n[browser] closed");