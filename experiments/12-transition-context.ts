import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

type Action = {
  name: string;
  role: string;
  targetState: string;
};

type State = {
  id: string;
  label: string;
  heading: string;
  actions: Action[];
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(
  a: string,
  b: string,
): number {
  const aTokens = new Set(
    normalize(a)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

  const bTokens = new Set(
    normalize(b)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

  if (aTokens.size === 0 && bTokens.size === 0) {
    return 1;
  }

  const intersection = [...aTokens].filter((token) =>
    bTokens.has(token),
  ).length;

  const union = new Set([
    ...aTokens,
    ...bTokens,
  ]).size;

  return union === 0
    ? 0
    : intersection / union;
}

function compareStates(
  current: State,
  known: State,
): void {
  const headingSimilarity = similarity(
    current.heading,
    known.heading,
  );

  const currentActions = current.actions.map(
    (action) => action.name,
  );

  const knownActions = known.actions.map(
    (action) => action.name,
  );

  const actionSimilarity = similarity(
    currentActions.join(" "),
    knownActions.join(" "),
  );

  const currentTargets = current.actions.map(
    (action) => action.targetState,
  );

  const knownTargets = known.actions.map(
    (action) => action.targetState,
  );

  const targetSimilarity = similarity(
    currentTargets.join(" "),
    knownTargets.join(" "),
  );

  const score =
    headingSimilarity * 0.30 +
    actionSimilarity * 0.30 +
    targetSimilarity * 0.40;

  const decision =
    score >= 0.80
      ? "SAME"
      : score >= 0.55
        ? "UNCERTAIN"
        : "NEW";

  console.log(
    `\n[compare] ${current.label} vs ${known.label}`,
  );

  console.log(
    `  heading similarity: ${headingSimilarity.toFixed(2)}`,
  );

  console.log(
    `  action similarity:  ${actionSimilarity.toFixed(2)}`,
  );

  console.log(
    `  target similarity:  ${targetSimilarity.toFixed(2)}`,
  );

  console.log(
    `  total:              ${score.toFixed(2)}`,
  );

  console.log(
    `  decision:            ${decision}`,
  );
}

async function captureState(
  page: Page,
  label: string,
  actions: Action[],
): Promise<State> {
  const heading =
    await page.locator("h1").innerText();

  await page.screenshot({
    path: `artifacts/12-${label}.png`,
    fullPage: true,
  });

  console.log(
    `[observe] ${label} | heading="${heading}" | actions=${actions.length}`,
  );

  return {
    id: label,
    label,
    heading,
    actions,
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

// ==================================================
// STATE A
// CHECKOUT → PAYMENT
// ==================================================

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

console.log("\n[state] A: Checkout");

const stateA = await captureState(
  page,
  "A-checkout",
  [
    {
      name: "Checkout",
      role: "button",
      targetState: "payment",
    },
  ],
);

// ==================================================
// STATE B
// SEMANTICALLY EQUIVALENT
// REVIEW ORDER → PAYMENT
// ==================================================

await page.setContent(`
  <main>
    <h1>Review Order</h1>

    <h2>MacBook Pro</h2>

    <p>₹1,89,000</p>

    <button>
      Proceed to Payment
    </button>
  </main>
`);

console.log(
  "\n[state] B: Review Order / Proceed to Payment",
);

const stateB = await captureState(
  page,
  "B-review-order",
  [
    {
      name: "Proceed to Payment",
      role: "button",
      targetState: "payment",
    },
  ],
);

// ==================================================
// STATE C
// SIMILAR SURFACE, DIFFERENT BEHAVIOR
// CHECKOUT → HOME
// ==================================================

await page.setContent(`
  <main>
    <h1>Checkout</h1>

    <h2>MacBook Pro</h2>

    <p>₹1,89,000</p>

    <button>
      Cancel Order
    </button>
  </main>
`);

console.log(
  "\n[state] C: Checkout / Cancel Order",
);

const stateC = await captureState(
  page,
  "C-cancel-order",
  [
    {
      name: "Cancel Order",
      role: "button",
      targetState: "home",
    },
  ],
);

// ==================================================
// STATE D
// SAME CHECKOUT STATE, EXTRA UI ACTION
// ==================================================

await page.setContent(`
  <main>
    <h1>Checkout</h1>

    <h2>MacBook Pro</h2>

    <p>₹1,89,000</p>

    <button>
      Proceed to Payment
    </button>

    <button>
      Back to Cart
    </button>
  </main>
`);

console.log(
  "\n[state] D: Checkout with additional action",
);

const stateD = await captureState(
  page,
  "D-checkout-extra-action",
  [
    {
      name: "Proceed to Payment",
      role: "button",
      targetState: "payment",
    },
    {
      name: "Back to Cart",
      role: "button",
      targetState: "cart",
    },
  ],
);

// ==================================================
// COMPARISONS
// ==================================================

console.log(
  "\n==============================",
);

console.log("[reconciliation]");

console.log(
  "==============================",
);

compareStates(
  stateB,
  stateA,
);

compareStates(
  stateC,
  stateA,
);

compareStates(
  stateD,
  stateA,
);

// ==================================================
// SUMMARY
// ==================================================

console.log("\n[result]");

console.log(
  "A = baseline checkout → payment",
);

console.log(
  "B = renamed/rephrased checkout → payment",
);

console.log(
  "C = similar checkout surface → home",
);

console.log(
  "D = checkout → payment + another branch",
);

console.log(
  "\n[insight] State identity is not just appearance.",
);

console.log(
  "[insight] Transition behavior is another important signal.",
);

await browser.close();

console.log("\n[browser] closed");