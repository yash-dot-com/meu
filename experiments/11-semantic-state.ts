import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

type SemanticElement = {
  role: string;
  name: string;
  type: string | null;
};

type SemanticState = {
  fingerprint: string;
  title: string;
  headings: string[];
  elements: SemanticElement[];
};

function hash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

async function captureSemanticState(
  page: Page,
  label: string,
): Promise<SemanticState> {
  const title = await page.title();

  const headings = await page
    .locator("h1, h2, h3")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean),
    );

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
    .evaluateAll((nodes): SemanticElement[] =>
      nodes
        .map((node) => {
          const element = node as HTMLElement;

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();

          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden";

          if (!visible) {
            return null;
          }

          const explicitRole =
            element.getAttribute("role");

          const role =
            explicitRole ||
            ({
              A: "link",
              BUTTON: "button",
              TEXTAREA: "textbox",
              SELECT: "combobox",
            }[element.tagName] ?? element.tagName.toLowerCase());

          const name =
            element.getAttribute("aria-label") ||
            element.getAttribute("placeholder") ||
            element.innerText.trim();

          const cleanName = name
            .replace(/\s+/g, " ")
            .trim();

          if (!cleanName) {
            return null;
          }

          return {
            role,
            name: cleanName,
            type:
              element instanceof HTMLInputElement
                ? element.type
                : null,
          };
        })
        .filter(
          (element): element is SemanticElement =>
            element !== null,
        ),
    );

  /*
   * IMPORTANT:
   *
   * We intentionally exclude:
   * - coordinates
   * - CSS classes
   * - element IDs
   * - DOM nesting
   * - styles
   *
   * The goal is to describe WHAT the page exposes,
   * not HOW the page happens to be implemented.
   */
  const semanticRepresentation = {
    title,
    headings,
    elements,
  };

  const fingerprint = hash(
    JSON.stringify(semanticRepresentation),
  );

  await page.screenshot({
    path: `artifacts/11-${label}.png`,
    fullPage: true,
  });

  console.log(
    `[capture] ${label}: ${fingerprint}`,
  );

  console.log(
    `[capture] headings: ${headings.join(" | ")}`,
  );

  console.log(
    `[capture] interactive: ${elements.length}`,
  );

  return {
    fingerprint,
    title,
    headings,
    elements,
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

// --------------------------------------------------
// STATE A — BASELINE
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>
      <main>
        <h1>MacBook Pro</h1>
        <p>₹1,89,000</p>

        <button>
          Checkout
        </button>
      </main>
    </body>
  </html>
`);

console.log("[page] baseline loaded");

const stateA = await captureSemanticState(
  page,
  "A-baseline",
);

// --------------------------------------------------
// STATE B — RADICALLY DIFFERENT DOM
// SAME USER-VISIBLE MEANING
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>

      <div class="app">

        <section>

          <article>

            <header>
              <div>
                <h1>MacBook Pro</h1>
              </div>

              <aside>
                <span>
                  ₹1,89,000
                </span>
              </aside>
            </header>

            <footer>

              <div>
                <div>

                  <div>
                    <button>
                      Checkout
                    </button>
                  </div>

                </div>
              </div>

            </footer>

          </article>

        </section>

      </div>

    </body>
  </html>
`);

console.log("\n[mutation] DOM radically restructured");
console.log("[mutation] user-visible meaning unchanged");

const stateB = await captureSemanticState(
  page,
  "B-dom-change",
);

console.log(
  "\n[compare] A === B:",
  stateA.fingerprint === stateB.fingerprint,
);

// --------------------------------------------------
// STATE C — DIFFERENT APPLICATION STATE
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>

      <main>

        <h1>Your Cart</h1>

        <article>
          <h2>MacBook Pro</h2>

          <p>
            Quantity: 1
          </p>

          <p>
            Total: ₹1,89,000
          </p>

          <button>
            Continue Shopping
          </button>

          <button>
            Proceed to Payment
          </button>

        </article>

      </main>

    </body>
  </html>
`);

console.log("\n[mutation] application state changed");
console.log("[mutation] Product -> Cart");

const stateC = await captureSemanticState(
  page,
  "C-new-state",
);

console.log(
  "\n[compare] A === C:",
  stateA.fingerprint === stateC.fingerprint,
);

// --------------------------------------------------
// SUMMARY
// --------------------------------------------------

console.log("\n[result]");

console.log({
  baseline: stateA.fingerprint,
  sameMeaningDifferentDOM: stateB.fingerprint,
  differentApplicationState: stateC.fingerprint,
});

console.log("\n[expectation]");

console.log(
  "A === B should ideally be true",
);

console.log(
  "A === C should ideally be false",
);

await browser.close();

console.log("\n[browser] closed");