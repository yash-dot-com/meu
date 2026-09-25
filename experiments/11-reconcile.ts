import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

type UIObservation = {
  label: string;
  url: string;
  title: string;
  headings: string[];
  elements: {
    role: string;
    name: string;
  }[];
};

type Score = {
  total: number;
  url: number;
  headings: number;
  roles: number;
  names: number;
  text: number;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^a-z0-9]+/)
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

  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;

  return union === 0 ? 0 : intersection / union;
}

function scoreObservation(
  current: UIObservation,
  known: UIObservation,
): Score {
  const currentHeadings = new Set(
    current.headings.map(normalize),
  );

  const knownHeadings = new Set(
    known.headings.map(normalize),
  );

  const headingScore = jaccard(
    currentHeadings,
    knownHeadings,
  );

  const currentRoles = new Set(
    current.elements.map((element) => element.role),
  );

  const knownRoles = new Set(
    known.elements.map((element) => element.role),
  );

  const roleScore = jaccard(
    currentRoles,
    knownRoles,
  );

  const currentNames = new Set(
    current.elements
      .map((element) => normalize(element.name))
      .filter(Boolean),
  );

  const knownNames = new Set(
    known.elements
      .map((element) => normalize(element.name))
      .filter(Boolean),
  );

  const nameScore = jaccard(
    currentNames,
    knownNames,
  );

  const currentText = tokenize(
    [
      current.title,
      ...current.headings,
      ...current.elements.map((element) => element.name),
    ].join(" "),
  );

  const knownText = tokenize(
    [
      known.title,
      ...known.headings,
      ...known.elements.map((element) => element.name),
    ].join(" "),
  );

  const textScore = jaccard(
    currentText,
    knownText,
  );

  const currentUrl = normalize(
    new URL(current.url).pathname,
  );

  const knownUrl = normalize(
    new URL(known.url).pathname,
  );

  const urlScore =
    currentUrl === knownUrl ? 1 : 0;

  /*
   * Weighted because not all signals are equally useful.
   *
   * URL       = strong signal
   * headings  = strong semantic landmark
   * roles     = structure of interaction
   * names     = useful but can change frequently
   * text      = supporting evidence
   */
  const total =
    urlScore * 0.25 +
    headingScore * 0.25 +
    roleScore * 0.20 +
    nameScore * 0.15 +
    textScore * 0.15;

  return {
    total,
    url: urlScore,
    headings: headingScore,
    roles: roleScore,
    names: nameScore,
    text: textScore,
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
    .evaluateAll((nodes) =>
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
        .filter(Boolean),
    );

  await page.screenshot({
    path: `artifacts/11-${label}.png`,
    fullPage: true,
  });

  console.log(
    `[observe] ${label} | headings=${headings.length} | elements=${elements.length}`,
  );

  return {
    label,
    url,
    title,
    headings,
    elements,
  };
}

function printScore(
  current: UIObservation,
  known: UIObservation,
): void {
  const score = scoreObservation(
    current,
    known,
  );

  console.log(`\n[compare] ${current.label} vs ${known.label}`);

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
    `  text:     ${score.text.toFixed(2)}`,
  );

  console.log(
    `  TOTAL:    ${score.total.toFixed(2)}`,
  );

  const decision =
    score.total >= 0.80
      ? "SAME"
      : score.total >= 0.55
        ? "UNCERTAIN"
        : "NEW";

  console.log(
    `  decision: ${decision}`,
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
    width: 1000,
    height: 700,
  },
});

// --------------------------------------------------
// A — ORIGINAL CHECKOUT
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>
      <main>
        <h1>Checkout</h1>

        <h2>MacBook Pro</h2>

        <p>₹1,89,000</p>

        <button>
          Checkout
        </button>
      </main>
    </body>
  </html>
`);

console.log("[state] A: original checkout");

const stateA = await observe(
  page,
  "A-original",
);

// --------------------------------------------------
// B — SAME MEANING, DIFFERENT UI WORDING
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>

      <div class="new-layout">

        <section>

          <article>

            <header>
              <h1>Checkout</h1>
              <h2>MacBook Pro</h2>
              <span>₹1,89,000</span>
            </header>

            <footer>
              <button>
                Proceed to Payment
              </button>
            </footer>

          </article>

        </section>

      </div>

    </body>
  </html>
`);

console.log(
  "\n[state] B: same meaning, different DOM and wording",
);

const stateB = await observe(
  page,
  "B-semantic-drift",
);

printScore(stateB, stateA);

// --------------------------------------------------
// C — COMPLETELY DIFFERENT STATE
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>

      <main>

        <h1>Order Confirmation</h1>

        <h2>Order #1042</h2>

        <p>
          Your order has been placed successfully.
        </p>

        <button>
          Continue Shopping
        </button>

      </main>

    </body>
  </html>
`);

console.log(
  "\n[state] C: different application state",
);

const stateC = await observe(
  page,
  "C-confirmation",
);

printScore(stateC, stateA);

// --------------------------------------------------
// D — SIMILAR SURFACE, DIFFERENT MEANING
// --------------------------------------------------

await page.setContent(`
  <!DOCTYPE html>

  <html>
    <head>
      <title>ShopFlow</title>
    </head>

    <body>

      <main>

        <h1>Checkout</h1>

        <h2>MacBook Pro</h2>

        <p>₹1,89,000</p>

        <button>
          Cancel Order
        </button>

      </main>

    </body>
  </html>
`);

console.log(
  "\n[state] D: similar surface, different action",
);

const stateD = await observe(
  page,
  "D-similar-surface",
);

printScore(stateD, stateA);

console.log("\n[result]");
console.log("A = known checkout state");
console.log("B = same meaning, representation changed");
console.log("C = genuinely different state");
console.log("D = similar surface, different behavior");

await browser.close();

console.log("\n[browser] closed");