import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

type State = {
  id: string;
  heading: string;
  actions: string[];
  screenshot: string;
};

type Transition = {
  from: State;
  action: string;
  to: State;
};

function hash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function captureState(
  page: Page,
  label: string,
): Promise<State> {
  const heading = (
    await page.locator("h1").innerText()
  ).trim();

  const actions = await page
    .getByRole("button")
    .allTextContents()
    .then((values) =>
      values
        .map((value) => normalize(value))
        .filter(Boolean),
    );

  const signature = JSON.stringify({
    heading: normalize(heading),
    actions: [...actions].sort(),
  });

  const id = `state_${hash(signature)}`;

  const screenshot =
    `artifacts/13-${label}.png`;

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  console.log(
    `[observe] ${label} | heading="${heading}" | actions=${actions.length} | id=${id}`,
  );

  return {
    id,
    heading,
    actions,
    screenshot,
  };
}

async function runScenario(
  page: Page,
  label: string,
  html: string,
  actionName: string,
): Promise<Transition> {
  await page.setContent(html);

  console.log(`\n[scenario] ${label}`);

  const before = await captureState(
    page,
    `${label}-before`,
  );

  const button = page.getByRole("button", {
    name: actionName,
  });

  console.log(
    `[action] "${actionName}" count=${await button.count()}`,
  );

  await button.click();

  console.log(
    `[action] "${actionName}" executed`,
  );

  const after = await captureState(
    page,
    `${label}-after`,
  );

  return {
    from: before,
    action: actionName,
    to: after,
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
// SCENARIO A
// Checkout → Payment
// ==================================================

const transitionA = await runScenario(
  page,
  "A-checkout",
  `
    <main>
      <h1>Checkout</h1>

      <p>MacBook Pro</p>

      <button id="action">
        Checkout
      </button>
    </main>
  `,
  "Checkout",
);

// Replace the resulting state manually in the
// browser so we can observe a real destination.
await page.setContent(`
  <main>
    <h1>Payment</h1>

    <p>MacBook Pro</p>

    <button>
      Pay Now
    </button>
  </main>
`);

const destinationA = await captureState(
  page,
  "A-payment",
);

transitionA.to = destinationA;

// ==================================================
// SCENARIO B
// Review Order → Payment
// ==================================================

const transitionB = await runScenario(
  page,
  "B-review-order",
  `
    <main>
      <section>
        <article>
          <h1>Review Order</h1>

          <p>MacBook Pro</p>

          <button id="action">
            Proceed to Payment
          </button>
        </article>
      </section>
    </main>
  `,
  "Proceed to Payment",
);

await page.setContent(`
  <main>
    <div>
      <h1>Payment</h1>

      <section>
        <p>MacBook Pro</p>

        <button>
          Pay Now
        </button>
      </section>
    </div>
  </main>
`);

const destinationB = await captureState(
  page,
  "B-payment",
);

transitionB.to = destinationB;

// ==================================================
// SCENARIO C
// Checkout → Home
// ==================================================

const transitionC = await runScenario(
  page,
  "C-cancel",
  `
    <main>
      <h1>Checkout</h1>

      <p>MacBook Pro</p>

      <button id="action">
        Cancel Order
      </button>
    </main>
  `,
  "Cancel Order",
);

await page.setContent(`
  <main>
    <h1>ShopFlow</h1>

    <p>Welcome back.</p>

    <button>
      Browse Products
    </button>
  </main>
`);

const destinationC = await captureState(
  page,
  "C-home",
);

transitionC.to = destinationC;

// ==================================================
// LEARNED TRANSITION SIGNATURES
// ==================================================

console.log("\n==============================");
console.log("[learned transitions]");
console.log("==============================");

function printTransition(
  transition: Transition,
): void {
  console.log(
    `${transition.from.id} --"${transition.action}"--> ${transition.to.id}`,
  );

  console.log(
    `  ${transition.from.heading} → ${transition.to.heading}`,
  );
}

printTransition(transitionA);
printTransition(transitionB);
printTransition(transitionC);

// ==================================================
// BEHAVIORAL COMPARISON
// ==================================================

console.log("\n==============================");
console.log("[behavior comparison]");
console.log("==============================");

const sameDestinationAB =
  transitionA.to.id === transitionB.to.id;

const sameDestinationAC =
  transitionA.to.id === transitionC.to.id;

console.log(
  "[A vs B] same destination:",
  sameDestinationAB,
);

console.log(
  "[A vs C] same destination:",
  sameDestinationAC,
);

console.log("\n[result]");

console.log(
  "A and B should converge on Payment",
);

console.log(
  "C should converge on Home",
);

console.log(
  "\n[insight] Transition behavior is learned from observation.",
);

await browser.close();

console.log("\n[browser] closed");