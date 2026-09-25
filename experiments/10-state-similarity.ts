import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

type Snapshot = {
  fingerprint: string;
  url: string;
  title: string;
  aria: string;
};

function fingerprintState(
  url: string,
  title: string,
  ariaSnapshot: string,
): string {
  // Remove volatile information.
  const normalized = ariaSnapshot
    .replace(/\[ref=[^\]]+\]/g, "")
    .replace(/\[box=[^\]]+\]/g, "")
    .replace(/\[cursor=[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const input = JSON.stringify({
    url,
    title,
    aria: normalized,
  });

  return createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, 16);
}

async function captureState(
  page: Page,
  label: string,
): Promise<Snapshot> {
  const title = await page.title();
  const url = page.url();

  const ariaSnapshot = await page.ariaSnapshot({
    mode: "ai",
    depth: 10,
    boxes: true,
  });

  const fingerprint = fingerprintState(
    url,
    title,
    ariaSnapshot,
  );

  await page.screenshot({
    path: `artifacts/10-${label}.png`,
    fullPage: true,
  });

  console.log(
    `[capture] ${label}: ${fingerprint}`,
  );

  return {
    fingerprint,
    url,
    title,
    aria: ariaSnapshot,
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

      <style>
        body {
          font-family: system-ui, sans-serif;
          padding: 40px;
        }

        .actions {
          margin-top: 30px;
        }

        button {
          padding: 10px 18px;
          font-size: 16px;
        }
      </style>
    </head>

    <body>
      <main>
        <h1>MacBook Pro</h1>

        <p>₹1,89,000</p>

        <div class="actions">
          <button>Checkout</button>
        </div>
      </main>
    </body>
  </html>
`);

console.log("[page] baseline loaded");

const stateA = await captureState(
  page,
  "state-a-baseline",
);

// --------------------------------------------------
// STATE B — LAYOUT MUTATION
// --------------------------------------------------

await page.evaluate(() => {
  const button = document.querySelector("button");

  if (!button) {
    throw new Error("Checkout button not found");
  }

  button.style.position = "absolute";
  button.style.left = "700px";
  button.style.top = "450px";
});

console.log("[mutation] button moved");
console.log("[mutation] meaning unchanged");

const stateB = await captureState(
  page,
  "state-b-layout-change",
);

console.log(
  "\n[compare] A === B:",
  stateA.fingerprint === stateB.fingerprint,
);

// --------------------------------------------------
// STATE C — DOM STRUCTURE MUTATION
// --------------------------------------------------

await page.evaluate(() => {
  document.body.innerHTML = `
    <div>
      <section>
        <article>
          <header>
            <h1>MacBook Pro</h1>
            <p>₹1,89,000</p>
          </header>

          <div>
            <div>
              <div>
                <button>Checkout</button>
              </div>
            </div>
          </div>
        </article>
      </section>
    </div>
  `;
});

console.log("[mutation] DOM structure changed");
console.log("[mutation] user-visible meaning unchanged");

const stateC = await captureState(
  page,
  "state-c-dom-change",
);

console.log(
  "[compare] A === C:",
  stateA.fingerprint === stateC.fingerprint,
);

// --------------------------------------------------
// SUMMARY
// --------------------------------------------------

console.log("\n[result]");
console.log({
  baseline: stateA.fingerprint,
  layoutChanged: stateB.fingerprint,
  domChanged: stateC.fingerprint,
});

await browser.close();

console.log("\n[browser] closed");