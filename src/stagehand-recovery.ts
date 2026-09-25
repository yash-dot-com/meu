import {
  localBrowser,
  Stagehand,
} from "@browserbasehq/stagehand";

import fs from "node:fs/promises";
import path from "node:path";

import { startShopFlow } from "./shopflow.js";

type RecoveryEvidence = {
  experiment: "S2";
  intent: string;

  deterministic: {
    targetName: string;
    found: boolean;
    strategy: string;
  };

  stagehand: {
    success: boolean;
    message: string | null;
    actionDescription: string | null;
    actions: unknown[];
  };

  result: {
    url: string;
    title: string;
    verified: boolean;
    durationMs: number;
  };

  screenshots: {
    before: string;
    after: string;
  };

  recordedAt: string;
};

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.",
    );
  }

  const shopflow = await startShopFlow();

  const artifactDir = path.resolve(
    "artifacts/meu-demo/stagehand",
  );

  await fs.mkdir(artifactDir, {
    recursive: true,
  });

  let browser:
    | Awaited<
        ReturnType<typeof localBrowser.launch>
      >
    | undefined;

  let stagehand:
    | Awaited<
        ReturnType<typeof Stagehand.create>
      >
    | undefined;

  try {
    console.log("[s2] launching Stagehand v4");

    browser = await localBrowser.launch({
      headless: false,
    });

    stagehand = await Stagehand.create({
      browser,
      model: {
        modelName: "openai/gpt-5.4-mini",
        apiKey,
      },
    });

    const pages =
      await browser.context.pages();

    if (pages.length === 0) {
      throw new Error(
        "Stagehand created no browser pages.",
      );
    }

    const page = pages[0];

    const cartUrl =
      `${shopflow.url}/cart?mutation=1`;

    console.log(
      `[s2] opening mutated cart: ${cartUrl}`,
    );

    await page.goto(cartUrl);

    const title = await page.title();

    console.log(
      `[s2] page title=${title}`,
    );

    const beforeScreenshot =
      path.join(
        artifactDir,
        "before-recovery.png",
      );

    await page.screenshot({
      path: beforeScreenshot,
      fullPage: true,
    });

    // -----------------------------------------------
    // 1. Deterministic lookup
    // -----------------------------------------------

    console.log(
      '[s2] deterministic lookup: "Checkout"',
    );

    const links = page.locator("a");

    const linkCount = await links.count();

    let exactTargetFound = false;

    for (let index = 0; index < linkCount; index++) {
      const link = links.nth(index);
      const text = (await link.innerText()).trim();

      if (text === "Checkout") {
        exactTargetFound = true;
        break;
      }
    }

    console.log(
      `[s2] deterministic target found=${exactTargetFound}`,
    );

    if (exactTargetFound) {
      throw new Error(
        "Mutation failed: Checkout is still present.",
      );
    }

    console.log(
      '[s2] "Checkout" target unavailable',
    );

    // -----------------------------------------------
    // 2. Stagehand AI recovery
    // -----------------------------------------------

    console.log(
      "[s2] escalating to Stagehand AI",
    );

    const started = Date.now();

    const result = await stagehand.act(
      "Click the link that continues the checkout process from the cart.",
    );

    const durationMs =
      Date.now() - started;

    const success =
      result.data?.success === true;

    console.log(
      `[s2] Stagehand success=${success}`,
    );

    console.log(
      `[s2] message=${result.data?.message ?? "none"}`,
    );

    console.log(
      `[s2] description=${
        result.data?.actionDescription ??
        "none"
      }`,
    );

    const actions =
      result.data?.actions ?? [];

    if (actions.length > 0) {
      const firstAction = actions[0] as {
        method?: string;
        selector?: string;
      };

      console.log(
        `[s2] method=${firstAction.method ?? "unknown"}`,
      );

      console.log(
        `[s2] selector=${firstAction.selector ?? "unknown"}`,
      );
    }

    // -----------------------------------------------
    // 3. Verification
    // -----------------------------------------------

    const finalUrl =
      await page.url();

    const finalTitle =
      await page.title();

    const afterScreenshot =
      path.join(
        artifactDir,
        "after-recovery.png",
      );

    await page.screenshot({
      path: afterScreenshot,
      fullPage: true,
    });

    const verified =
      success &&
      finalTitle === "Checkout";

    console.log(
      `[s2] finalUrl=${finalUrl}`,
    );

    console.log(
      `[s2] finalTitle=${finalTitle}`,
    );

    console.log(
      `[s2] verification=${
        verified ? "PASS" : "FAIL"
      }`,
    );

    const evidence: RecoveryEvidence = {
      experiment: "S2",

      intent:
        "Continue checkout from cart",

      deterministic: {
        targetName: "Checkout",
        found: exactTargetFound,
        strategy:
          'Stagehand v4 page.locator("a") + innerText()',
      },

      stagehand: {
        success,
        message:
          result.data?.message ?? null,
        actionDescription:
          result.data?.actionDescription ??
          null,
        actions,
      },

      result: {
        url: finalUrl,
        title: finalTitle,
        verified,
        durationMs,
      },

      screenshots: {
        before: beforeScreenshot,
        after: afterScreenshot,
      },

      recordedAt:
        new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(
        artifactDir,
        "s2-evidence.json",
      ),
      JSON.stringify(
        evidence,
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      `[s2] evidence saved to ${artifactDir}`,
    );

    if (!verified) {
      throw new Error(
        "S2 verification failed.",
      );
    }

    console.log(
      "[s2] PASS — Playwright-style deterministic lookup failed and Stagehand AI recovered the target",
    );
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (error) {
        console.error(
          "[s2] Stagehand close failed:",
          error,
        );
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error(
          "[s2] browser close failed:",
          error,
        );
      }
    }

    await shopflow.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    "[s2] failed:",
    error,
  );

  process.exit(1);
});