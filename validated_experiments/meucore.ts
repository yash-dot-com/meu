import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { startShopFlow } from "./shopflow.js";

type SemanticElement = {
  role: string;
  name?: string;
  ref?: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
};

type Observation = {
  url: string;
  title: string;
  headings: string[];
  interactive: SemanticElement[];
};

type StateRecord = {
  id: string;
  observation: Observation;
  screenshot: string;
};

type TransitionRecord = {
  id: string;
  fromState: string;
  toState: string;
  action: string;
  target: string;
  success: boolean;
  durationMs: number;
};

type EvidenceEvent = {
  id: string;
  action: string;
  target: string;
  beforeState: string;
  afterState: string;
  screenshotBefore: string;
  screenshotAfter: string;
  verified: boolean;
  durationMs: number;
};

function shortHash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

async function getAriaTree(
  page: Page,
): Promise<unknown> {
  const pageWithJson = page as Page & {
    ariaSnapshotJSON?: (options?: {
      mode?: "ai" | "default";
      depth?: number;
      boxes?: boolean;
    }) => Promise<unknown>;
  };

  if (
    typeof pageWithJson.ariaSnapshotJSON !==
    "function"
  ) {
    throw new Error(
      "Playwright ariaSnapshotJSON() is unavailable",
    );
  }

  return pageWithJson.ariaSnapshotJSON({
    mode: "ai",
    depth: 6,
    boxes: false,
  });
}

function flattenTree(node: unknown): SemanticElement[] {
  const result: SemanticElement[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;

    if (typeof record.role === "string") {
      const element: SemanticElement = {
        role: record.role,
      };

      if (typeof record.name === "string") {
        element.name = record.name;
      }

      if (typeof record.ref === "string") {
        element.ref = record.ref;
      }

      if (typeof record.disabled === "boolean") {
        element.disabled = record.disabled;
      }

      if (typeof record.checked === "boolean") {
        element.checked = record.checked;
      }

      if (typeof record.expanded === "boolean") {
        element.expanded = record.expanded;
      }

      if (typeof record.selected === "boolean") {
        element.selected = record.selected;
      }

      if (typeof record.pressed === "boolean") {
        element.pressed = record.pressed;
      }

      result.push(element);
    }

    if (Array.isArray(record.children)) {
      visit(record.children);
    }
  }

  visit(node);

  return result;
}

async function observe(
  page: Page,
): Promise<Observation> {
  const tree = await getAriaTree(page);
  const elements = flattenTree(tree);

  const interactiveRoles = new Set([
    "button",
    "link",
    "checkbox",
    "combobox",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
    "option",
    "tab",
    "menuitem",
  ]);

  const interactive = elements.filter((element) =>
    interactiveRoles.has(element.role),
  );

  const headings = elements
    .filter((element) => element.role === "heading")
    .map((element) => element.name ?? "")
    .filter(Boolean);

  return {
    url: page.url(),
    title: await page.title(),
    headings,
    interactive,
  };
}

function stateFingerprint(
  observation: Observation,
): string {
  const normalized = {
    path: new URL(observation.url).pathname,
    title: observation.title,
    headings: observation.headings,
    interactive: observation.interactive.map(
      ({
        role,
        name,
        disabled,
        checked,
        expanded,
        selected,
        pressed,
      }) => ({
        role,
        name,
        disabled,
        checked,
        expanded,
        selected,
        pressed,
      }),
    ),
  };

  return shortHash(JSON.stringify(normalized));
}

async function captureState(
  page: Page,
  screenshotDir: string,
): Promise<StateRecord> {
  const observation = await observe(page);

  const fingerprint = stateFingerprint(
    observation,
  );

  const screenshotPath = path.join(
    screenshotDir,
    `${fingerprint}.png`,
  );

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  return {
    id: `state_${fingerprint}`,
    observation,
    screenshot: screenshotPath,
  };
}

async function main(): Promise<void> {
  const shopflow = await startShopFlow();

  const artifactsDir =
    path.resolve("artifacts/meu-demo");

  const screenshotDir = path.join(
    artifactsDir,
    "screenshots",
  );

  await fs.mkdir(screenshotDir, {
    recursive: true,
  });

  const browser = await chromium.launch({
    headless: false,
  });

  const page = await browser.newPage();

  const states = new Map<string, StateRecord>();
  const transitions: TransitionRecord[] = [];
  const events: EvidenceEvent[] = [];

  try {
    console.log(
      `[meu] ShopFlow: ${shopflow.url}`,
    );

    console.log("[meu] starting checkout test");

    await page.goto(shopflow.url, {
      waitUntil: "domcontentloaded",
    });

    let currentState = await captureState(
      page,
      screenshotDir,
    );

    states.set(currentState.id, currentState);

    async function performAction(
      action: string,
      target: string,
      clickTarget: () => Promise<void>,
      verify: () => Promise<boolean>,
    ): Promise<void> {
      const before = currentState;
      const started = Date.now();

      console.log(
        `[action] ${action} "${target}"`,
      );

      let verified = false;

      try {
        await clickTarget();

        verified = await verify();

        const after = await captureState(
          page,
          screenshotDir,
        );

        states.set(after.id, after);

        const durationMs =
          Date.now() - started;

        transitions.push({
          id: `transition_${shortHash(
            `${before.id}:${after.id}:${action}:${target}`,
          )}`,
          fromState: before.id,
          toState: after.id,
          action,
          target,
          success: verified,
          durationMs,
        });

        events.push({
          id: `event_${shortHash(
            `${started}:${action}:${target}`,
          )}`,
          action,
          target,
          beforeState: before.id,
          afterState: after.id,
          screenshotBefore:
            before.screenshot,
          screenshotAfter:
            after.screenshot,
          verified,
          durationMs,
        });

        currentState = after;

        console.log(
          `[verify] ${verified ? "PASS" : "FAIL"} → ${after.observation.title}`,
        );
      } catch (error) {
        console.error(
          `[action] failed: ${String(error)}`,
        );

        throw error;
      }
    }

    await performAction(
      "navigate",
      "Products",
      async () => {
        await page.getByRole("link", {
          name: "Products",
          exact: true,
        }).click();
      },
      async () => {
        return (await page.title()) === "Products";
      },
    );

    await performAction(
      "navigate",
      "View Product",
      async () => {
        await page.getByRole("link", {
          name: "View Product",
          exact: true,
        }).first().click();
      },
      async () => {
        return (await page.title()) ===
          "MacBook Pro";
      },
    );

    await performAction(
      "navigate",
      "Add to Cart",
      async () => {
        await page.getByRole("link", {
          name: "Add to Cart",
          exact: true,
        }).click();
      },
      async () => {
        return (await page.title()) === "Cart";
      },
    );

    await performAction(
      "navigate",
      "Checkout",
      async () => {
        await page.getByRole("link", {
          name: "Checkout",
          exact: true,
        }).click();
      },
      async () => {
        return (await page.title()) ===
          "Checkout";
      },
    );

    await performAction(
      "navigate",
      "Checkout",
      async () => {
        await page.getByRole("link", {
          name: "Checkout",
          exact: true,
        }).click();
      },
      async () => {
        return (await page.title()) ===
          "Payment";
      },
    );

    await performAction(
      "navigate",
      "Pay Now",
      async () => {
        await page.getByRole("link", {
          name: "Pay Now",
          exact: true,
        }).click();
      },
      async () => {
        return (await page.title()) ===
          "Order Confirmed";
      },
    );

    const run = {
      id: `run_${Date.now()}`,
      intent: "Test the checkout flow",
      application: "ShopFlow",
      status: "PASSED",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      finalState: currentState.id,
      stateCount: states.size,
      transitionCount: transitions.length,
      evidenceCount: events.length,
    };

    await fs.writeFile(
      path.join(artifactsDir, "run.json"),
      JSON.stringify(run, null, 2),
    );

    await fs.writeFile(
      path.join(artifactsDir, "states.json"),
      JSON.stringify(
        [...states.values()],
        null,
        2,
      ),
    );

    await fs.writeFile(
      path.join(artifactsDir, "transitions.json"),
      JSON.stringify(
        transitions,
        null,
        2,
      ),
    );

    await fs.writeFile(
      path.join(artifactsDir, "events.json"),
      JSON.stringify(
        events,
        null,
        2,
      ),
    );

    console.log(
      `[meu] PASSED states=${states.size} transitions=${transitions.length} evidence=${events.length}`,
    );

    console.log(
      `[meu] artifacts: ${artifactsDir}`,
    );
  } finally {
    await browser.close();
    await shopflow.close();
  }
}

main().catch((error: unknown) => {
  console.error("[meu] failed:", error);
  process.exit(1);
});