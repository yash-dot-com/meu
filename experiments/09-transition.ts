import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

type UIState = {
  id: string;
  url: string;
  title: string;
  screenshot: string;
  fingerprint: string;
};

type UITransition = {
  from: string;
  to: string;
  action: {
    type: string;
    target: string;
  };
  durationMs: number;
  success: boolean;
};

async function captureState(
  page: Page,
  label: string,
): Promise<UIState> {
  console.log(`[state] capturing: ${label}`);

  const title = await page.title();
  const url = page.url();

  const ariaSnapshot = await page.ariaSnapshot({
    mode: "ai",
    depth: 10,
    boxes: true,
  });

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
    .evaluateAll((nodes) =>
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

          if (!visible) {
            return null;
          }

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

          const name = rawName
            .replace(/\s+/g, " ")
            .trim();

          return {
            tag: element.tagName.toLowerCase(),
            role,
            name,
            type:
              element instanceof HTMLInputElement
                ? element.type
                : null,
            disabled:
              "disabled" in element
                ? Boolean(
                    (element as HTMLButtonElement).disabled,
                  )
                : false,
          };
        })
        .filter(Boolean),
    );

  const normalized = JSON.stringify({
    url,
    title,

    aria: ariaSnapshot
      .replace(/\[ref=[^\]]+\]/g, "")
      .replace(/\[box=[^\]]+\]/g, "")
      .replace(/\[cursor=[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),

    interactiveElements,
  });

  const fingerprint = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);

  const screenshot = `artifacts/${label}-${fingerprint}.png`;

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  console.log(`[state] ${label}: ${fingerprint}`);

  return {
    id: `state_${fingerprint}`,
    url,
    title,
    screenshot,
    fingerprint,
  };
}

await mkdir("artifacts", {
  recursive: true,
});

const browser = await chromium.launch({
  headless: false,
});

console.log("[browser] launched");

const page = await browser.newPage({
  viewport: {
    width: 1000,
    height: 700,
  },
});

await page.setContent(`
  <!DOCTYPE html>
  <html>
    <head>
      <title>ShopFlow</title>

      <style>
        body {
          font-family: system-ui, sans-serif;
          padding: 48px;
        }

        button {
          padding: 10px 18px;
          font-size: 16px;
          cursor: pointer;
        }

        #results {
          margin-top: 32px;
        }
      </style>
    </head>

    <body>
      <main>
        <h1>ShopFlow</h1>

        <p>Find a product</p>

        <input
          aria-label="Search"
          placeholder="Search products"
        />

        <button id="search-button">
          Search
        </button>

        <div id="results"></div>
      </main>
    </body>
  </html>
`);

console.log("[page] loaded");

await page.evaluate(() => {
  const button = document.getElementById("search-button");
  const results = document.getElementById("results");

  if (!button || !results) {
    throw new Error("ShopFlow elements not found");
  }

  button.addEventListener("click", () => {
    results.innerHTML = `
      <h2>Search results</h2>

      <article>
        <h3>MacBook Pro</h3>
        <p>₹1,89,000</p>

        <button>
          Add to Cart
        </button>
      </article>
    `;
  });
});

const before = await captureState(
  page,
  "before",
);

console.log("\n[state A]");
console.log("id:", before.id);
console.log("screenshot:", before.screenshot);

const searchButton = page.getByRole("button", {
  name: "Search",
});

console.log(
  "[action] target count:",
  await searchButton.count(),
);

const start = performance.now();

await searchButton.click();

const durationMs = Math.round(
  performance.now() - start,
);

console.log("[action] Search clicked");

const after = await captureState(
  page,
  "after",
);

console.log("\n[state B]");
console.log("id:", after.id);
console.log("screenshot:", after.screenshot);

const transition: UITransition = {
  from: before.id,
  to: after.id,
  action: {
    type: "click",
    target: "Search",
  },
  durationMs,
  success: true,
};

console.log("\n[transition]");
console.log(
  JSON.stringify(transition, null, 2),
);

console.log("\n[graph]");
console.log(
  `${before.id} --click("Search")--> ${after.id}`,
);

await browser.close();

console.log("\n[browser] closed");