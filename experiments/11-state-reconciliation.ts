import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

type ElementSummary = {
  role: string;
  name: string;
};

type UIObservation = {
  label: string;
  url: string;
  title: string;
  headings: string[];
  elements: ElementSummary[];
  screenshot: string;
};

type SignalScore = {
  url: number;
  headings: number;
  roles: number;
  names: number;
  total: number;
  decision: "SAME" | "UNCERTAIN" | "NEW";
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(values: string[]): Set<string> {
  return new Set(
    values
      .flatMap((value) =>
        normalize(value).split(/[^a-z0-9]+/),
      )
      .filter(Boolean),
  );
}

function jaccard(
  a: Set<string>,
  b: Set<string>,
): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }

  const intersection = [...a].filter((value) =>
    b.has(value),
  ).length;

  const union = new Set([...a, ...b]).size;

  return union === 0
    ? 0
    : intersection / union;
}

function compareStates(
  current: UIObservation,
  known: UIObservation,
): SignalScore {
  const currentUrl = new URL(current.url).pathname;
  const knownUrl = new URL(known.url).pathname;

  const url = currentUrl === knownUrl ? 1 : 0;

  const headings = jaccard(
    new Set(current.headings.map(normalize)),
    new Set(known.headings.map(normalize)),
  );

  const roles = jaccard(
    new Set(
      current.elements.map((element) =>
        normalize(element.role),
      ),
    ),
    new Set(
      known.elements.map((element) =>
        normalize(element.role),
      ),
    ),
  );

  const names = jaccard(
    tokenSet(
      current.elements.map((element) => element.name),
    ),
    tokenSet(
      known.elements.map((element) => element.name),
    ),
  );

  /*
   * Cheap heuristic only.
   *
   * We intentionally do NOT use:
   * - CSS classes
   * - DOM nesting
   * - coordinates
   * - element IDs
   * - screenshot pixels
   * - LLM reasoning
   *
   * This is the baseline reconciler we want to challenge.
   */
  const total =
    url * 0.30 +
    headings * 0.25 +
    roles * 0.20 +
    names * 0.25;

  const decision =
    total >= 0.80
      ? "SAME"
      : total >= 0.55
        ? "UNCERTAIN"
        : "NEW";

  return {
    url,
    headings,
    roles,
    names,
    total,
    decision,
  };
}

async function observe(
  page: Page,
  label: string,
): Promise<UIObservation> {
  const title = await page.title();
  const url = page.url();

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
    .evaluateAll((nodes): ElementSummary[] =>
      nodes
        .map((node) => {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);

          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden";

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
            }[element.tagName] ?? element.tagName.toLowerCase());

          const name =
            element.getAttribute("aria-label") ||
            element.getAttribute("placeholder") ||
            element.innerText.trim() ||
            "";

          const cleanName = name
            .replace(/\s+/g, " ")
            .trim();

          if (!cleanName) {
            return null;
          }

          return {
            role,
            name: cleanName,
          };
        })
        .filter(
          (element): element is ElementSummary =>
            element !== null,
        ),
    );

  const screenshot =
    `artifacts/11-${label}.png`;

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  console.log(
    `[observe] ${label} | url=${new URL(url).pathname} | headings=${headings.length} | elements=${elements.length}`,
  );

  return {
    label,
    url,
    title,
    headings,
    elements,
    screenshot,
  };
}

function printComparison(
  current: UIObservation,
  known: UIObservation,
): void {
  const score = compareStates(
    current,
    known,
  );

  console.log(
    `\n[reconcile] ${known.label} ← ${current.label}`,
  );

  console.log(
    `  url:      ${score.url.toFixed(2)}`,
  );

  console.log(
    `  headings: ${score.headings.toFixed(2)}`,
  );

  console.log(
    `  roles:    ${score.roles.toFixed(2)}`,
  );

  console.log(
    `  names:    ${score.names.toFixed(2)}`,
  );

  console.log(
    `  total:    ${score.total.toFixed(2)}`,
  );

  console.log(
    `  decision: ${score.decision}`,
  );
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
    width: 1100,
    height: 700,
  },
});

// ==================================================
// OBSERVATION 1
// BASELINE CHECKOUT
// ==================================================

await page.goto("http://localhost:3000/checkout");

await page.setContent(`
  <main>
    <h1>Checkout</h1>
    <h2>MacBook Pro</h2>

    <p>₹1,89,000</p>

    <button>
      Checkout
    </button>
  </main>
`);

console.log("\n[state] Observation 1: Checkout");

const observation1 = await observe(
  page,
  "01-checkout",
);

// ==================================================
// OBSERVATION 2
// SAME MEANING, DIFFERENT WORDING
// ==================================================

await page.setContent(`
  <div class="application">
    <section>
      <article>
        <header>
          <h1>Review Order</h1>
          <h2>MacBook Pro</h2>
          <p>₹1,89,000</p>
        </header>

        <footer>
          <button>
            Proceed to Payment
          </button>
        </footer>
      </article>
    </section>
  </div>
`);

await page.evaluate(() => {
  history.replaceState(
    {},
    "",
    "/checkout",
  );
});

console.log(
  "\n[state] Observation 2: Review Order",
);

const observation2 = await observe(
  page,
  "02-review-order",
);

// ==================================================
// OBSERVATION 3
// SAME MEANING, RADICALLY DIFFERENT DOM
// ==================================================

await page.setContent(`
  <div>
    <section>
      <div>
        <article>

          <div>
            <header>
              <div>
                <div>
                  <h1>Review Order</h1>
                </div>
              </div>
            </header>
          </div>

          <div>
            <div>
              <div>
                <h2>MacBook Pro</h2>
              </div>
            </div>
          </div>

          <div>
            <div>
              <div>
                <span>₹1,89,000</span>
              </div>
            </div>
          </div>

          <div>
            <footer>
              <div>
                <div>
                  <button>
                    Proceed to Payment
                  </button>
                </div>
              </div>
            </footer>
          </div>

        </article>
      </div>
    </section>
  </div>
`);

await page.evaluate(() => {
  history.replaceState(
    {},
    "",
    "/checkout",
  );
});

console.log(
  "\n[state] Observation 3: Same checkout, different DOM",
);

const observation3 = await observe(
  page,
  "03-dom-mutation",
);

// ==================================================
// OBSERVATION 4
// SAME MEANING, DIFFERENT LAYOUT
// ==================================================

await page.setContent(`
  <main>

    <aside>
      <button>
        Proceed to Payment
      </button>
    </aside>

    <section>
      <div>
        <h1>Review Order</h1>
      </div>

      <div>
        <article>
          <h2>MacBook Pro</h2>
          <p>₹1,89,000</p>
        </article>
      </div>

    </section>

  </main>
`);

await page.evaluate(() => {
  history.replaceState(
    {},
    "",
    "/checkout",
  );
});

console.log(
  "\n[state] Observation 4: Same checkout, different layout",
);

const observation4 = await observe(
  page,
  "04-layout-change",
);

// ==================================================
// OBSERVATION 5
// GENUINELY DIFFERENT STATE
// ==================================================

await page.setContent(`
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
`);

await page.evaluate(() => {
  history.replaceState(
    {},
    "",
    "/cart",
  );
});

console.log(
  "\n[state] Observation 5: Cart",
);

const observation5 = await observe(
  page,
  "05-cart",
);

// ==================================================
// OBSERVATION 6
// GENUINELY DIFFERENT STATE
// ==================================================

await page.setContent(`
  <main>

    <h1>Payment</h1>

    <h2>Order Summary</h2>

    <p>
      MacBook Pro
    </p>

    <label>
      Card Number

      <input
        aria-label="Card Number"
      />
    </label>

    <button>
      Pay Now
    </button>

  </main>
`);

await page.evaluate(() => {
  history.replaceState(
    {},
    "",
    "/payment",
  );
});

console.log(
  "\n[state] Observation 6: Payment",
);

const observation6 = await observe(
  page,
  "06-payment",
);

// ==================================================
// COMPARE EVERYTHING AGAINST CHECKOUT
// ==================================================

console.log(
  "\n==============================",
);

console.log(
  "[reconciliation] Baseline = Observation 1",
);

console.log(
  "==============================",
);

printComparison(
  observation2,
  observation1,
);

printComparison(
  observation3,
  observation1,
);

printComparison(
  observation4,
  observation1,
);

printComparison(
  observation5,
  observation1,
);

printComparison(
  observation6,
  observation1,
);

// ==================================================
// SUMMARY
// ==================================================

console.log("\n[result]");

console.log(
  "Observation 1 = baseline Checkout",
);

console.log(
  "Observation 2 = same intent, wording changed",
);

console.log(
  "Observation 3 = same intent, DOM changed",
);

console.log(
  "Observation 4 = same intent, layout changed",
);

console.log(
  "Observation 5 = Cart",
);

console.log(
  "Observation 6 = Payment",
);

console.log(
  "\n[important] This is only the cheap reconciler.",
);

console.log(
  "[important] UNCERTAIN cases will eventually go to Codex.",
);

await browser.close();

console.log("\n[browser] closed");