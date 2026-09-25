import {
  chromium,
} from "playwright";

import fs from "node:fs/promises";
import path from "node:path";

import {
  MEURuntime,
} from "./meu-runtime.js";

import {
  startShopFlow,
} from "./shopflow.js";

async function main(): Promise<void> {
  const shopflow =
    await startShopFlow();

  const artifactDir =
    path.resolve(
      "artifacts/meu-demo/runtime",
    );

  const memoryPath =
    path.join(
      artifactDir,
      "memory.json",
    );

  const screenshotDir =
    path.join(
      artifactDir,
      "screenshots",
    );

  await fs.mkdir(
    screenshotDir,
    {
      recursive: true,
    },
  );

  const runtime =
    new MEURuntime({
      memoryPath,
      screenshotDir,
    });

  await runtime.load();

  // Start clean for this validation.
  runtime.clear();

  const browser =
    await chromium.launch({
      headless: false,
    });

  const page =
    await browser.newPage();

  try {
    console.log(
      `[validation] ShopFlow=${shopflow.url}`,
    );

    // ------------------------------------------------
    // STEP 1 — Observe Product
    // ------------------------------------------------

    await page.goto(
      `${shopflow.url}/product/1`,
    );

    const productState1 =
      await runtime.captureState(
        page,
      );

    console.log(
      `[state] first Product ID=${productState1.id}`,
    );

    // ------------------------------------------------
    // STEP 2 — Learn Add to Cart transition
    // ------------------------------------------------

    const addToCart =
      page.getByRole("link", {
        name: "Add to Cart",
        exact: true,
      }).first();

    if (
      !(await addToCart.count())
    ) {
      throw new Error(
        "Add to Cart was not found",
      );
    }

    const href =
      await addToCart.getAttribute(
        "href",
      );

    const resolvedPath =
      href
        ? new URL(
            href,
            page.url(),
          ).pathname
        : undefined;

    runtime.learnTarget({
      intent: "Add to Cart",
      role: "link",
      name: "Add to Cart",
      href:
        href ?? undefined,
      path: resolvedPath,
    });

    const beforeState =
      productState1;

    const started =
      Date.now();

    await addToCart.click();

    const cartState =
      await runtime.captureState(
        page,
      );

    const durationMs =
      Date.now() - started;

    runtime.recordTransition({
      fromState:
        beforeState.id,
      toState:
        cartState.id,
      intent:
        "Add to Cart",
      target:
        "Add to Cart",
      executor:
        "playwright",
      recovered:
        false,
      verified:
        cartState.title ===
        "Cart",
      durationMs,
    });

    console.log(
      `[transition] ${beforeState.id} → ${cartState.id}`,
    );

    // ------------------------------------------------
    // STEP 3 — Return to Product
    // ------------------------------------------------

    await page.goto(
      `${shopflow.url}/product/1`,
    );

    const productState2 =
      await runtime.captureState(
        page,
      );

    console.log(
      `[state] second Product ID=${productState2.id}`,
    );

    const sameState =
      productState1.id ===
      productState2.id;

    console.log(
      `[validation] same Product state=${sameState}`,
    );

    if (!sameState) {
      throw new Error(
        "Canonical state identity is inconsistent",
      );
    }

    // ------------------------------------------------
    // STEP 4 — Read graph knowledge
    // ------------------------------------------------

    const knownActions =
      runtime.getKnownActions(
        productState2.id,
      );

    console.log(
      `[graph] known actions=${knownActions.join(", ") || "none"}`,
    );

    if (
      !knownActions.includes(
        "Add to Cart",
      )
    ) {
      throw new Error(
        "Canonical graph did not recognize Add to Cart",
      );
    }

    // ------------------------------------------------
    // STEP 5 — Discover unexplored Product actions
    // ------------------------------------------------
    //
    // main a = product actions.
    // This deliberately avoids global nav.
    //

    const productLinks =
      page.locator(
        "main a",
      );

    const count =
      await productLinks.count();

    const availableActions: string[] =
      [];

    for (
      let index = 0;
      index < count;
      index++
    ) {
      const link =
        productLinks.nth(
          index,
        );

      const name =
        (
          await link.innerText()
        ).trim();

      if (
        name &&
        !availableActions.includes(
          name,
        )
      ) {
        availableActions.push(
          name,
        );
      }
    }

    console.log(
      `[exploration] available=${availableActions.join(", ")}`,
    );

    const unexplored =
      availableActions.filter(
        (action) =>
          !knownActions.includes(
            action,
          ),
      );

    console.log(
      `[exploration] unexplored=${unexplored.join(", ") || "none"}`,
    );

    if (
      !unexplored.includes(
        "Wishlist",
      )
    ) {
      throw new Error(
        "Wishlist was not identified as an unexplored branch",
      );
    }

    // ------------------------------------------------
    // STEP 6 — Save
    // ------------------------------------------------

    await runtime.save();

    const run =
      runtime.startRun(
        "ShopFlow",
        "Validate canonical runtime",
      );

    runtime.recordEvent({
      runId: run.id,
      type:
        "exploration",
      fromState:
        productState2.id,
      metadata: {
        knownActions,
        availableActions,
        unexplored,
      },
    });

    runtime.finishRun(
      run.id,
      "PASSED",
    );

    await runtime.save();

    console.log(
      "\n[validation] ===============================",
    );

    console.log(
      "[validation] PASS",
    );

    console.log(
      `[validation] canonical Product state=${productState1.id}`,
    );

    console.log(
      `[validation] known=${knownActions.join(", ")}`,
    );

    console.log(
      `[validation] unexplored=${unexplored.join(", ")}`,
    );

    console.log(
      `[validation] memory=${memoryPath}`,
    );

    console.log(
      "[validation] ===============================",
    );
  } finally {
    await browser.close();
    await shopflow.close();
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "[validation] failed:",
      error,
    );

    process.exit(1);
  },
);