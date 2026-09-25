import { chromium, type Page } from "playwright";
import fs from "node:fs/promises";

type SemanticElement = {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  url?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
  cursor?: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type CompactObservation = {
  url: string;
  title: string;
  interactive: SemanticElement[];
  headings: SemanticElement[];
  landmarks: SemanticElement[];
};

const INTERACTIVE_ROLES = new Set([
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

const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "search",
  "form",
]);

function flattenAriaTree(node: unknown): SemanticElement[] {
  const results: SemanticElement[] = [];

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

      if (typeof record.text === "string") {
        element.text = record.text;
      }

      if (typeof record.ref === "string") {
        element.ref = record.ref;
      }

      if (typeof record.url === "string") {
        element.url = record.url;
      }

      if (typeof record.placeholder === "string") {
        element.placeholder = record.placeholder;
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

      if (typeof record.cursor === "string") {
        element.cursor = record.cursor;
      }

      if (
        record.box &&
        typeof record.box === "object"
      ) {
        const box = record.box as Record<string, unknown>;

        if (
          typeof box.x === "number" &&
          typeof box.y === "number" &&
          typeof box.width === "number" &&
          typeof box.height === "number"
        ) {
          element.box = {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          };
        }
      }

      results.push(element);
    }

    if (Array.isArray(record.children)) {
      visit(record.children);
    }
  }

  visit(node);

  return results;
}

async function getAriaSnapshot(page: Page): Promise<unknown> {
  const pageWithJson = page as Page & {
    ariaSnapshotJSON?: (options?: {
      mode?: "ai" | "default";
      depth?: number;
      boxes?: boolean;
    }) => Promise<unknown>;
  };

  if (typeof pageWithJson.ariaSnapshotJSON === "function") {
    console.log("[aria] using ariaSnapshotJSON");

    return pageWithJson.ariaSnapshotJSON({
      mode: "ai",
      depth: 6,
      boxes: true,
    });
  }

  console.log("[aria] ariaSnapshotJSON unavailable; using ariaSnapshot");

  return page.ariaSnapshot({
    mode: "ai",
    depth: 6,
    boxes: true,
  });
}

async function observe(page: Page): Promise<CompactObservation> {
  const ariaTree = await getAriaSnapshot(page);

  const elements = flattenAriaTree(ariaTree);

  const interactive = elements.filter((element) =>
    INTERACTIVE_ROLES.has(element.role),
  );

  const headings = elements.filter(
    (element) => element.role === "heading",
  );

  const landmarks = elements.filter((element) =>
    LANDMARK_ROLES.has(element.role),
  );

  return {
    url: page.url(),
    title: await page.title(),
    interactive,
    headings,
    landmarks,
  };
}

async function main(): Promise<void> {
  const targetUrl =
    process.argv[2] ?? "https://example.com";

  const browser = await chromium.launch({
    headless: false,
  });

  const page = await browser.newPage();

  try {
    console.log(`[observe] opening ${targetUrl}`);

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const rawHtmlLength = await page.evaluate(() => {
      return document.documentElement.outerHTML.length;
    });

    const ariaTree = await getAriaSnapshot(page);
    const observation = await observe(page);

    const ariaJson = JSON.stringify(ariaTree);
    const compactJson = JSON.stringify(observation);
    const prettyJson = JSON.stringify(observation, null, 2);

    const compactReduction =
      rawHtmlLength > 0
        ? ((rawHtmlLength - compactJson.length) /
            rawHtmlLength) *
          100
        : 0;

    await fs.mkdir("artifacts", {
      recursive: true,
    });

    await fs.writeFile(
      "artifacts/17b-aria-tree.json",
      JSON.stringify(ariaTree, null, 2),
      "utf8",
    );

    await fs.writeFile(
      "artifacts/17b-compact-observation.json",
      prettyJson,
      "utf8",
    );

    console.log(
      `[observe] interactive=${observation.interactive.length} headings=${observation.headings.length} landmarks=${observation.landmarks.length}`,
    );

    console.log(
      `[observe] rawHTML=${rawHtmlLength} chars aria=${ariaJson.length} chars compact=${compactJson.length} chars`,
    );

    console.log(
      `[observe] compact reduction=${compactReduction.toFixed(1)}%`,
    );

    console.log(
      "[observe] saved E17-B artifacts",
    );

    console.log("\n--- COMPACT ARIA OBSERVATION ---");
    console.log(prettyJson);

    console.log("\n[observe] done");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error("[observe] failed:", error);
  process.exit(1);
});