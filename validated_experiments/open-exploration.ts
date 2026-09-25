import {
  localBrowser,
  Stagehand,
} from "@browserbasehq/stagehand";

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  startShopFlow,
} from "./shopflow.js";

type CandidateAction = {
  selector: string;
  description?: string;
  method?: string;
  arguments?: unknown[];
};

type State = {
  id: string;
  title: string;
  url: string;
  screenshot: string;
};

type ExplorationStep = {
  step: number;
  stateBefore: State;
  action: CandidateAction;
  stateAfter: State;
  durationMs: number;
};

type ExplorationResult = {
  experiment: "S4";
  goal: string;
  maxSteps: number;
  steps: ExplorationStep[];
  statesVisited: number;
  completed: boolean;
  stoppedReason: string;
  createdAt: string;
};

function shortHash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

async function captureState(
  page: {
    url(): Promise<string>;
    title(): Promise<string>;
    screenshot(options: {
      path: string;
      fullPage: boolean;
    }): Promise<void>;
  },
  screenshotDir: string,
): Promise<State> {
  const url = await page.url();
  const title = await page.title();

  const id =
    `state_${shortHash(
      `${new URL(url).pathname}:${title}`,
    )}`;

  const screenshot =
    path.join(
      screenshotDir,
      `${id}-${Date.now()}.png`,
    );

  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });

  return {
    id,
    title,
    url,
    screenshot,
  };
}

function isNavigationNoise(
  description: string,
): boolean {
  const normalized =
    description.toLowerCase();

  return (
    normalized.includes("home") &&
    !normalized.includes("product") ||
    normalized === "products" ||
    normalized.includes("main navigation") ||
    normalized.includes("navigation")
  );
}

async function main(): Promise<void> {
  const apiKey =
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.",
    );
  }

  const shopflow =
    await startShopFlow();

  const artifactDir =
    path.resolve(
      "artifacts/meu-demo/open-exploration",
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

  let browser:
    | Awaited<
        ReturnType<
          typeof localBrowser.launch
        >
      >
    | undefined;

  let stagehand:
    | Awaited<
        ReturnType<
          typeof Stagehand.create
        >
      >
    | undefined;

  const goal =
    "Explore this application and discover useful workflows.";

  const maxSteps = 5;

  const steps: ExplorationStep[] =
    [];

  const visitedStates =
    new Set<string>();

  try {
    console.log(
      "[s4] launching Stagehand v4",
    );

    browser =
      await localBrowser.launch({
        headless: false,
      });

    stagehand =
      await Stagehand.create({
        browser,
        model: {
          modelName:
            "openai/gpt-5.4-mini",
          apiKey,
        },
      });

    const pages =
      await browser.context.pages();

    if (pages.length === 0) {
      throw new Error(
        "No Stagehand page available.",
      );
    }

    const page = pages[0];

    const startUrl =
      `${shopflow.url}/`;

    await page.goto(startUrl);

    console.log(
      `[s4] goal="${goal}"`,
    );

    let currentState =
      await captureState(
        page,
        screenshotDir,
      );

    visitedStates.add(
      currentState.id,
    );

    let stoppedReason =
      "max steps reached";

    for (
      let step = 1;
      step <= maxSteps;
      step++
    ) {
      console.log(
        `\n[s4] step=${step} state=${currentState.title}`,
      );

      // ---------------------------------------------
      // Discover candidate actions
      // ---------------------------------------------

      const observation =
        await stagehand.observe(
          [
            "Find meaningful user actions",
            "that can lead to useful application",
            "state changes or workflows.",
            "Ignore global navigation such as",
            "Home, Products, footer links, and",
            "language/settings links.",
            "Prefer actions such as View Product,",
            "Add to Cart, Wishlist, Checkout,",
            "Buy Now, Continue, Submit, or similar.",
          ].join(" "),
        );

      const candidates =
        (observation.data ??
          []) as CandidateAction[];

      console.log(
        `[s4] candidates=${candidates.length}`,
      );

      if (candidates.length === 0) {
        stoppedReason =
          "no actionable candidates";

        break;
      }

      // ---------------------------------------------
      // Filter navigation noise
      // ---------------------------------------------

      const useful =
        candidates.filter(
          (candidate) => {
            const description =
              candidate.description ??
              "";

            return !isNavigationNoise(
              description,
            );
          },
        );

      console.log(
        `[s4] useful candidates=${useful.length}`,
      );

      if (useful.length === 0) {
        stoppedReason =
          "no meaningful actions";

        break;
      }

      // ---------------------------------------------
      // Try candidates until one moves us into a
      // previously unseen state.
      // ---------------------------------------------

      let progressed = false;

      for (const candidate of useful) {
        const description =
          candidate.description ??
          candidate.selector;

        console.log(
          `[s4] considering=${description}`,
        );

        const started =
          Date.now();

        try {
          await page
            .locator(
              candidate.selector,
            )
            .click();

          const durationMs =
            Date.now() - started;

          const nextState =
            await captureState(
              page,
              screenshotDir,
            );

          console.log(
            `[s4] result=${nextState.title}`,
          );

          if (
            visitedStates.has(
              nextState.id,
            )
          ) {
            console.log(
              `[s4] state already visited → trying another candidate`,
            );

            // Return to current state if possible.
            await page.goto(
              currentState.url,
            );

            continue;
          }

          steps.push({
            step,
            stateBefore:
              currentState,
            action: candidate,
            stateAfter:
              nextState,
            durationMs,
          });

          visitedStates.add(
            nextState.id,
          );

          currentState =
            nextState;

          progressed = true;

          console.log(
            `[s4] NEW STATE discovered=${nextState.id}`,
          );

          break;
        } catch (error) {
          console.log(
            `[s4] candidate failed: ${String(error)}`,
          );

          try {
            await page.goto(
              currentState.url,
            );
          } catch {
            // Continue exploration attempt.
          }
        }
      }

      if (!progressed) {
        stoppedReason =
          "all candidates led to known states or failed";

        break;
      }
    }

    const result: ExplorationResult =
      {
        experiment: "S4",
        goal,
        maxSteps,
        steps,
        statesVisited:
          visitedStates.size,
        completed:
          steps.length > 0,
        stoppedReason,
        createdAt:
          new Date().toISOString(),
      };

    await fs.writeFile(
      path.join(
        artifactDir,
        "s4-exploration.json",
      ),
      JSON.stringify(
        result,
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      "\n[s4] =================================",
    );

    console.log(
      `[s4] states visited=${result.statesVisited}`,
    );

    console.log(
      `[s4] steps=${result.steps.length}`,
    );

    console.log(
      `[s4] stopped=${result.stoppedReason}`,
    );

    console.log(
      `[s4] evidence=${artifactDir}`,
    );

    console.log(
      "[s4] =================================",
    );

    if (steps.length === 0) {
      throw new Error(
        "Open exploration discovered no states.",
      );
    }

    console.log(
      "[s4] PASS — MEU autonomously explored a bounded workflow",
    );
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (error) {
        console.error(
          "[s4] Stagehand close failed:",
          error,
        );
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error(
          "[s4] browser close failed:",
          error,
        );
      }
    }

    await shopflow.close();
  }
}

main().catch(
  (error: unknown) => {
    console.error(
      "[s4] failed:",
      error,
    );

    process.exit(1);
  },
);