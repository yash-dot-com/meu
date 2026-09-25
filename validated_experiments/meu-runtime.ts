import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

type AriaElement = {
  role: string;
  name?: string;
  ref?: string;
};

export type Observation = {
  url: string;
  title: string;
  headings: string[];
  interactive: AriaElement[];
};

export type StateRecord = {
  id: string;
  semanticKey: string;
  url: string;
  title: string;
  screenshot: string;
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
};

export type TargetMemory = {
  intent: string;
  role: string;
  names: string[];
  href?: string;
  path?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type TransitionRecord = {
  id: string;
  fromState: string;
  toState: string;
  intent: string;
  target: string;
  executor: "playwright" | "stagehand";
  recovered: boolean;
  verified: boolean;
  durationMs: number;
  createdAt: string;
};

export type EvidenceEvent = {
  id: string;
  runId: string;
  type:
    | "observe"
    | "action"
    | "verification"
    | "recovery"
    | "exploration";

  intent?: string;
  target?: string;
  executor?: "playwright" | "stagehand";

  fromState?: string;
  toState?: string;

  screenshotBefore?: string;
  screenshotAfter?: string;

  verified?: boolean;
  recovered?: boolean;

  metadata?: Record<string, unknown>;

  createdAt: string;
};

export type RunRecord = {
  id: string;
  application: string;
  intent: string;
  status:
    | "QUEUED"
    | "RUNNING"
    | "NEEDS_REVIEW"
    | "PASSED"
    | "FAILED";

  startedAt: string;
  finishedAt?: string;

  stateCount: number;
  transitionCount: number;
  recoveryCount: number;
  evidenceCount: number;
};

export type MEUMemory = {
  version: 1;

  targets: TargetMemory[];
  states: StateRecord[];
  transitions: TransitionRecord[];
  events: EvidenceEvent[];
  runs: RunRecord[];
};

export type RuntimeOptions = {
  memoryPath: string;
  screenshotDir: string;
};

function hash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

function createEmptyMemory(): MEUMemory {
  return {
    version: 1,
    targets: [],
    states: [],
    transitions: [],
    events: [],
    runs: [],
  };
}

export class MEURuntime {
  private readonly memoryPath: string;
  private readonly screenshotDir: string;

  private memory: MEUMemory =
    createEmptyMemory();

  constructor(options: RuntimeOptions) {
    this.memoryPath = path.resolve(
      options.memoryPath,
    );

    this.screenshotDir = path.resolve(
      options.screenshotDir,
    );
  }

  async load(): Promise<void> {
    await fs.mkdir(
      path.dirname(this.memoryPath),
      {
        recursive: true,
      },
    );

    await fs.mkdir(
      this.screenshotDir,
      {
        recursive: true,
      },
    );

    try {
      const raw = await fs.readFile(
        this.memoryPath,
        "utf8",
      );

      const parsed =
        JSON.parse(raw) as MEUMemory;

      if (parsed.version !== 1) {
        throw new Error(
          "Unsupported MEU memory version",
        );
      }

      this.memory = parsed;

      console.log(
        `[runtime] loaded states=${this.memory.states.length} transitions=${this.memory.transitions.length}`,
      );
    } catch {
      this.memory =
        createEmptyMemory();

      console.log(
        "[runtime] starting with empty memory",
      );
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(
      this.memoryPath,
      JSON.stringify(
        this.memory,
        null,
        2,
      ),
      "utf8",
    );
  }

  clear(): void {
    this.memory =
      createEmptyMemory();

    console.log(
      "[runtime] memory cleared",
    );
  }

  getMemory(): MEUMemory {
    return this.memory;
  }

  async observe(
    page: Page,
  ): Promise<Observation> {
    const pageWithJson =
      page as Page & {
        ariaSnapshotJSON?: (
          options?: {
            mode?: "ai" | "default";
            depth?: number;
            boxes?: boolean;
          },
        ) => Promise<unknown>;
      };

    if (
      typeof pageWithJson.ariaSnapshotJSON !==
      "function"
    ) {
      throw new Error(
        "Playwright ariaSnapshotJSON() is unavailable",
      );
    }

    const tree =
      await pageWithJson.ariaSnapshotJSON({
        mode: "ai",
        depth: 6,
        boxes: false,
      });

    const elements: AriaElement[] = [];

    const visit = (
      value: unknown,
    ): void => {
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }

        return;
      }

      if (
        !value ||
        typeof value !== "object"
      ) {
        return;
      }

      const record =
        value as Record<
          string,
          unknown
        >;

      if (
        typeof record.role === "string"
      ) {
        const element: AriaElement = {
          role: record.role,
        };

        if (
          typeof record.name ===
          "string"
        ) {
          element.name =
            record.name;
        }

        if (
          typeof record.ref ===
          "string"
        ) {
          element.ref =
            record.ref;
        }

        elements.push(element);
      }

      if (
        Array.isArray(record.children)
      ) {
        for (const child of record.children) {
          visit(child);
        }
      }
    };

    visit(tree);

    const interactiveRoles =
      new Set([
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

    const interactive =
      elements.filter(
        (element) =>
          interactiveRoles.has(
            element.role,
          ),
      );

    const headings =
      elements
        .filter(
          (element) =>
            element.role ===
            "heading",
        )
        .map(
          (element) =>
            element.name ?? "",
        )
        .filter(Boolean);

    return {
      url: await page.url(),
      title: await page.title(),
      headings,
      interactive,
    };
  }

  /**
   * Prototype canonical identity:
   *
   * We intentionally DO NOT include interactive names.
   * This means:
   *
   * Checkout
   * and
   * Proceed to Payment
   *
   * can still represent the same logical state when
   * URL/title/headings/interaction structure remain
   * otherwise equivalent.
   *
   * This is deliberately conservative for tonight's
   * prototype and will be refined post-hackathon.
   */
  canonicalStateKey(
    observation: Observation,
  ): string {
    const pathName =
      new URL(
        observation.url,
      ).pathname;

    const roleCounts =
      new Map<string, number>();

    for (
      const element of
      observation.interactive
    ) {
      roleCounts.set(
        element.role,
        (roleCounts.get(
          element.role,
        ) ?? 0) + 1,
      );
    }

    const normalized =
      {
        path: pathName,
        title:
          observation.title,
        headings:
          [...observation.headings]
            .sort(),
        roles:
          [...roleCounts.entries()]
            .sort(
              ([a], [b]) =>
                a.localeCompare(b),
            ),
      };

    return JSON.stringify(
      normalized,
    );
  }

  stateId(
    observation: Observation,
  ): string {
    return `state_${hash(
      this.canonicalStateKey(
        observation,
      ),
    )}`;
  }

  async captureState(
    page: Page,
  ): Promise<StateRecord> {
    const observation =
      await this.observe(page);

    const id =
      this.stateId(observation);

    const now =
      new Date().toISOString();

    const existing =
      this.memory.states.find(
        (state) =>
          state.id === id,
      );

    const screenshot =
      path.join(
        this.screenshotDir,
        `${id}-${Date.now()}.png`,
      );

    await page.screenshot({
      path: screenshot,
      fullPage: true,
    });

    if (existing) {
      existing.lastSeenAt = now;
      existing.visits += 1;
      existing.screenshot =
        screenshot;

      return existing;
    }

    const state: StateRecord = {
      id,
      semanticKey:
        this.canonicalStateKey(
          observation,
        ),
      url: observation.url,
      title: observation.title,
      screenshot,
      firstSeenAt: now,
      lastSeenAt: now,
      visits: 1,
    };

    this.memory.states.push(
      state,
    );

    return state;
  }

  learnTarget(
    target: {
      intent: string;
      role: string;
      name: string;
      href?: string;
      path?: string;
    },
  ): void {
    const now =
      new Date().toISOString();

    const existing =
      this.memory.targets.find(
        (item) =>
          item.intent ===
          target.intent,
      );

    if (existing) {
      if (
        target.name &&
        !existing.names.includes(
          target.name,
        )
      ) {
        existing.names.push(
          target.name,
        );
      }

      if (target.href) {
        existing.href =
          target.href;
      }

      if (target.path) {
        existing.path =
          target.path;
      }

      existing.lastSeenAt =
        now;

      return;
    }

    this.memory.targets.push({
      intent: target.intent,
      role: target.role,
      names: [target.name],
      ...(target.href
        ? { href: target.href }
        : {}),
      ...(target.path
        ? { path: target.path }
        : {}),
      firstSeenAt: now,
      lastSeenAt: now,
    });

    console.log(
      `[memory] learned "${target.intent}"`,
    );
  }

  getTarget(
    intent: string,
  ): TargetMemory | undefined {
    return this.memory.targets.find(
      (target) =>
        target.intent === intent,
    );
  }

  getKnownActions(
    stateId: string,
  ): string[] {
    return [
      ...new Set(
        this.memory.transitions
          .filter(
            (transition) =>
              transition.fromState ===
              stateId,
          )
          .map(
            (transition) =>
              transition.intent,
          ),
      ),
    ];
  }

  recordTransition(
    transition: Omit<
      TransitionRecord,
      "id" | "createdAt"
    >,
  ): TransitionRecord {
    const record: TransitionRecord =
      {
        ...transition,
        id: `transition_${hash(
          `${transition.fromState}:${transition.toState}:${transition.intent}:${Date.now()}`,
        )}`,
        createdAt:
          new Date().toISOString(),
      };

    this.memory.transitions.push(
      record,
    );

    return record;
  }

  recordEvent(
    event: Omit<
      EvidenceEvent,
      "id" | "createdAt"
    >,
  ): EvidenceEvent {
    const record: EvidenceEvent =
      {
        ...event,
        id: `event_${hash(
          `${event.runId}:${event.type}:${Date.now()}`,
        )}`,
        createdAt:
          new Date().toISOString(),
      };

    this.memory.events.push(
      record,
    );

    return record;
  }

  startRun(
    application: string,
    intent: string,
  ): RunRecord {
    const now =
      new Date().toISOString();

    const run: RunRecord = {
      id: `run_${Date.now()}`,
      application,
      intent,
      status: "RUNNING",
      startedAt: now,
      stateCount: 0,
      transitionCount: 0,
      recoveryCount: 0,
      evidenceCount: 0,
    };

    this.memory.runs.push(
      run,
    );

    return run;
  }

  finishRun(
    runId: string,
    status:
      | "PASSED"
      | "FAILED"
      | "NEEDS_REVIEW",
  ): RunRecord {
    const run =
      this.memory.runs.find(
        (item) =>
          item.id === runId,
      );

    if (!run) {
      throw new Error(
        `Run not found: ${runId}`,
      );
    }

    run.status = status;
    run.finishedAt =
      new Date().toISOString();

    run.stateCount =
      this.memory.states.length;

    run.transitionCount =
      this.memory.transitions.length;

    run.recoveryCount =
      this.memory.events.filter(
        (event) =>
          event.runId === runId &&
          event.recovered === true,
      ).length;

    run.evidenceCount =
      this.memory.events.filter(
        (event) =>
          event.runId === runId,
      ).length;

    return run;
  }
}