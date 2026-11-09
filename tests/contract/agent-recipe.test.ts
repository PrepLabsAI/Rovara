// Plan 3 Task 4: overlays, structural recipe checks, coding programs, digests and diffs.
import { describe, expect, it } from "vitest";
import {
  EMPTY_RECIPE,
  RecipeOverlaySchema,
  ResolvedRecipeSchema,
  applyOverlay,
  codingProgram,
  diffRecipes,
  formatRecipeProblem,
  overlayPaths,
  overlayProblems,
  recipeDigest,
  recipeProblems,
  recipeRunner,
  type RecipeOverlay,
  type ResolvedRecipe,
  type ResolvedStep,
} from "../../packages/contracts/src/agent-recipe-node.js";

const MIXING = "steps: a recipe can't mix coding steps and agent steps; link the two agents in a chain instead";
const PULL_REQUEST = "steps: a pull request step needs a check step and a review step with both reviewers after the last build step";

const NO_INSTRUCTIONS = { instructions: [] };

function build(id = "build", settings: Record<string, unknown> = {}): ResolvedStep {
  return { id, name: id, kind: "build", settings: { ...NO_INSTRUCTIONS, ...settings } };
}
function plan(settings: Record<string, unknown> = {}): ResolvedStep {
  return { id: "plan", name: "Plan", kind: "plan", settings: { ...NO_INSTRUCTIONS, ...settings } };
}
function check(id = "check"): ResolvedStep {
  return { id, name: id, kind: "check", settings: { ...NO_INSTRUCTIONS } };
}
function review(id: string, reviewers: Array<"code" | "security">, onFindings?: { backTo: string; maxRounds: number }): ResolvedStep {
  return { id, name: id, kind: "review", reviewers, ...(onFindings ? { onFindings } : {}), settings: { ...NO_INSTRUCTIONS } };
}
function pullRequest(): ResolvedStep {
  return { id: "pull_request", name: "Pull request", kind: "pull_request", settings: { ...NO_INSTRUCTIONS } };
}
function agentStep(id = "agent", workspace: "none" | "read" = "none", settings: Record<string, unknown> = {}): ResolvedStep {
  return { id, name: id, kind: "agent", workspace, settings: { ...NO_INSTRUCTIONS, ...settings } };
}
function approval(id = "approval"): ResolvedStep {
  return { id, name: id, kind: "approval", prompt: "Go on?", settings: { ...NO_INSTRUCTIONS } };
}
function recipeOf(steps: ResolvedStep[], extra: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
  return { ...structuredClone(EMPTY_RECIPE), steps, ...extra };
}

/** Rovara Code's built-in version 1, as Task 5 defines it. */
function rovaraCode(): ResolvedRecipe {
  return recipeOf([plan(), build(), check(), review("review", ["code", "security"], { backTo: "build", maxRounds: 3 }), pullRequest()]);
}

const LAYER = { agentId: "agt_0123456789abcdefghij", name: "Payments Expert", version: 1 as const, builtin: false };
const BASE_LAYER = { agentId: "rovara-code" as const, name: "Rovara Code", version: 1 as const, builtin: true };
const MODEL_A = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const MODEL_B = { provider: "openai", modelId: "gpt-5.4" };

function messages(recipe: ResolvedRecipe): string[] {
  return recipeProblems(recipe).map(formatRecipeProblem);
}

describe("EMPTY_RECIPE", () => {
  it("has no steps or tools, a person trigger, prepare autonomy and no mentions, and parses", () => {
    expect(EMPTY_RECIPE.steps).toEqual([]);
    expect(EMPTY_RECIPE.tools).toEqual([]);
    expect(EMPTY_RECIPE.triggers).toEqual([{ kind: "person" }]);
    expect(EMPTY_RECIPE.autonomy).toBe("prepare");
    expect(EMPTY_RECIPE.allowMentions).toBe(false);
    expect(ResolvedRecipeSchema.safeParse(EMPTY_RECIPE).success).toBe(true);
  });
});

describe("recipeProblems", () => {
  it("accepts Rovara Code's built-in version 1", () => {
    expect(recipeProblems(rovaraCode())).toEqual([]);
  });

  it("needs at least one step", () => {
    const problems = recipeProblems(recipeOf([]));
    expect(problems).toEqual([{ path: "steps", message: "a recipe needs at least one step" }]);
    expect(problems.map(formatRecipeProblem)).toEqual(["steps: a recipe needs at least one step"]);
  });

  it("refuses duplicate step ids", () => {
    const problems = recipeProblems(recipeOf([build("same"), check("same"), review("review", ["code", "security"])]));
    expect(problems.some((problem) => problem.path === "steps.1.id")).toBe(true);
  });

  it("limits a plan step's tools to the read-only set and names the step and the tool", () => {
    const problems = recipeProblems(recipeOf([plan({ tools: ["read", "bash"] }), build()]));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe("steps.0.settings.tools");
    expect(problems[0]?.message).toContain("plan");
    expect(problems[0]?.message).toContain("bash");
  });

  it("allows bash on a build step and refuses it on a review step", () => {
    expect(recipeProblems(recipeOf([build("build", { tools: ["read", "bash", "write"] })]))).toEqual([]);
    const problems = recipeProblems(recipeOf([build(), review("review", ["code"], undefined)].map((step, index) => (index === 1 ? { ...step, settings: { instructions: [], tools: ["write"] } } : step))));
    expect(problems.some((problem) => problem.path === "steps.1.settings.tools" && problem.message.includes("write"))).toBe(true);
  });

  it("refuses bash on an agent step, and a workspace tool when the step has no workspace", () => {
    const bash = recipeProblems(recipeOf([agentStep("agent", "read", { tools: ["bash"] })]));
    expect(bash).toHaveLength(1);
    expect(bash[0]?.message).toContain("bash");
    const noWorkspace = recipeProblems(recipeOf([agentStep("agent", "none", { tools: ["read"] })]));
    expect(noWorkspace).toHaveLength(1);
    expect(recipeProblems(recipeOf([agentStep("agent", "read", { tools: ["read", "grep"] })]))).toEqual([]);
  });

  it("allows connector tool patterns on an agent step", () => {
    expect(recipeProblems(recipeOf([agentStep("agent", "none", { tools: ["linear__get_*", "search"] })]))).toEqual([]);
  });

  it("refuses tools on a check step, and settings other than a timeout", () => {
    const step = { ...check(), settings: { instructions: [], tools: ["read"], model: MODEL_A } } as unknown as ResolvedStep;
    const problems = recipeProblems(recipeOf([build(), step]));
    expect(problems.some((problem) => problem.path === "steps.1.settings.tools")).toBe(true);
    expect(problems.some((problem) => problem.path === "steps.1.settings.model")).toBe(true);
  });

  it("refuses a tools list that the layers narrowed to nothing", () => {
    const problems = recipeProblems(recipeOf([build("build", { tools: [] })]));
    expect(problems.some((problem) => problem.path === "steps.0.settings.tools")).toBe(true);
  });

  describe("sequences", () => {
    it("accepts the eight-step custom sequence", () => {
      const recipe = recipeOf([
        build("tests"),
        build("code"),
        check("check_one"),
        review("review_one", ["code", "security"]),
        build("docs"),
        check("check_two"),
        review("review_two", ["code", "security"]),
        pullRequest(),
      ]);
      expect(recipeProblems(recipe)).toEqual([]);
    });

    it("refuses a pull request step with no check step", () => {
      expect(messages(recipeOf([build(), review("review", ["code", "security"]), pullRequest()]))).toContain(PULL_REQUEST);
    });

    it("refuses a pull request step whose review has one reviewer", () => {
      expect(messages(recipeOf([build(), check(), review("review", ["security"]), pullRequest()]))).toContain(PULL_REQUEST);
    });

    it("refuses a pull request step whose check and review come before the last build", () => {
      const recipe = recipeOf([build("first"), check(), review("review", ["code", "security"]), build("second"), pullRequest()]);
      expect(messages(recipe)).toContain(PULL_REQUEST);
    });

    it("refuses a recipe that mixes coding and agent steps", () => {
      expect(messages(recipeOf([agentStep(), build()]))).toContain(MIXING);
    });

    it("refuses an approval step in a coding recipe", () => {
      expect(messages(recipeOf([approval(), build()]))).toContain(MIXING);
    });

    it("accepts an agent recipe with an approval step", () => {
      expect(recipeProblems(recipeOf([agentStep("look"), approval(), agentStep("act", "read")]))).toEqual([]);
    });

    it("needs a build step and puts a plan first", () => {
      expect(recipeProblems(recipeOf([plan(), check()])).some((problem) => problem.message.includes("build"))).toBe(true);
      const late = recipeProblems(recipeOf([build(), plan()]));
      expect(late.some((problem) => problem.path === "steps.1")).toBe(true);
    });

    it("allows one plan and one pull request, the pull request last", () => {
      const twoPlans = recipeProblems(recipeOf([plan(), { ...plan(), id: "plan_two" }, build()]));
      expect(twoPlans.some((problem) => problem.path === "steps.1")).toBe(true);
      const early = recipeProblems(recipeOf([build(), check(), review("review", ["code", "security"]), pullRequest(), check("late")]));
      expect(early.some((problem) => problem.path === "steps.3")).toBe(true);
      const twice = recipeProblems(recipeOf([build(), check(), review("review", ["code", "security"]), pullRequest(), { ...pullRequest(), id: "pr_two" }]));
      expect(twice.some((problem) => problem.path === "steps.4")).toBe(true);
    });

    it("needs onFindings.backTo to name an earlier build step", () => {
      expect(recipeProblems(recipeOf([build(), review("review", ["code"], { backTo: "build", maxRounds: 2 })]))).toEqual([]);
      for (const backTo of ["missing", "check", "later"]) {
        const recipe = recipeOf([build(), check(), review("review", ["code"], { backTo, maxRounds: 2 }), build("later")]);
        expect(recipeProblems(recipe).some((problem) => problem.path === "steps.2.onFindings.backTo"), backTo).toBe(true);
      }
    });
  });

  describe("differentCompanyFrom", () => {
    it("names another, earlier step and sits only on review or agent steps", () => {
      expect(recipeProblems(recipeOf([build(), review("review", ["code"], undefined)].map((step, index) => (index === 1 ? { ...step, settings: { instructions: [], differentCompanyFrom: "build" } } : step)) as ResolvedStep[]))).toEqual([]);
      const unknown = recipeProblems(recipeOf([build(), { ...review("review", ["code"]), settings: { instructions: [], differentCompanyFrom: "nobody" } } as ResolvedStep]));
      expect(unknown.some((problem) => problem.path === "steps.1.settings.differentCompanyFrom")).toBe(true);
      const self = recipeProblems(recipeOf([build(), { ...review("review", ["code"]), settings: { instructions: [], differentCompanyFrom: "review" } } as ResolvedStep]));
      expect(self.some((problem) => problem.path === "steps.1.settings.differentCompanyFrom")).toBe(true);
      const wrongKind = recipeProblems(recipeOf([build("first"), build("second", { differentCompanyFrom: "first" })]));
      expect(wrongKind.some((problem) => problem.path === "steps.1.settings.differentCompanyFrom")).toBe(true);
      const onAgent = recipeProblems(recipeOf([agentStep("first"), agentStep("second", "none", { differentCompanyFrom: "first" })]));
      expect(onAgent).toEqual([]);
    });
  });

  it("no longer refuses event and schedule triggers: Plan 4 launches all three kinds (the specs themselves are checked by the schema)", () => {
    const recipe = recipeOf([build()], { triggers: [{ kind: "person" }, { kind: "event", source: "github", type: "pull_request.opened" }, { kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", missed: "run_once" }] as unknown as ResolvedRecipe["triggers"] });
    expect(recipeProblems(recipe).filter((problem) => problem.path === "triggers")).toEqual([]);
  });
});

describe("recipe problem messages", () => {
  it("never repeat their path", () => {
    const recipes = [
      recipeOf([]),
      recipeOf([agentStep(), build()]),
      recipeOf([build("same"), check("same"), plan(), { ...plan(), id: "p2" }, pullRequest(), build("late")]),
      recipeOf([build(), review("review", ["code"], { backTo: "missing", maxRounds: 2 })]),
      recipeOf([plan({ tools: ["bash"] }), { ...check(), settings: { instructions: [], model: MODEL_A } } as unknown as ResolvedStep, build("b", { differentCompanyFrom: "nobody" })]),
      recipeOf([build()], { triggers: [{ kind: "schedule" }] as unknown as ResolvedRecipe["triggers"] }),
    ];
    const problems = recipes.flatMap((recipe) => recipeProblems(recipe));
    expect(problems.length).toBeGreaterThan(8);
    for (const problem of problems) {
      expect(problem.message.startsWith(problem.path), problem.message).toBe(false);
      expect(problem.message.startsWith("steps"), problem.message).toBe(false);
      expect(problem.message.startsWith("triggers"), problem.message).toBe(false);
    }
  });
});

describe("recipeRunner", () => {
  it("is coding for coding steps and agent_steps otherwise", () => {
    expect(recipeRunner(rovaraCode())).toBe("coding");
    expect(recipeRunner(recipeOf([agentStep()]))).toBe("agent_steps");
    expect(recipeRunner(EMPTY_RECIPE)).toBe("agent_steps");
  });
});

describe("applyOverlay", () => {
  it("returns a recipe that parses and appends the layer to the chain, leaving the base alone", () => {
    const base = rovaraCode();
    const before = structuredClone(base);
    const resolved = applyOverlay(base, { instructions: "Be brief." }, LAYER);
    expect(ResolvedRecipeSchema.safeParse(resolved).success).toBe(true);
    expect(resolved.chain).toEqual([LAYER]);
    expect(base).toEqual(before);
    const child = applyOverlay(resolved, {}, { ...BASE_LAYER });
    expect(child.chain).toEqual([LAYER, BASE_LAYER]);
  });

  it("keeps a reordered step's base settings by id and kind", () => {
    const base = recipeOf([plan(), build("build", { model: MODEL_A, instructions: [{ agentName: "Rovara Code", text: "base" }] }), check(), review("review", ["code", "security"], { backTo: "build", maxRounds: 3 })]);
    const overlay: RecipeOverlay = {
      sequence: [
        { id: "check", name: "check", kind: "check" },
        { id: "build", name: "Build it", kind: "build" },
        { id: "other", name: "other", kind: "review", reviewers: ["code"] },
        { id: "plan", name: "plan", kind: "review", reviewers: ["security"] },
      ],
    };
    const resolved = applyOverlay(base, overlay, LAYER);
    expect(resolved.steps.map((step) => step.id)).toEqual(["check", "build", "other", "plan"]);
    const kept = resolved.steps[1];
    expect(kept?.name).toBe("Build it");
    expect(kept?.settings).toEqual({ model: MODEL_A, instructions: [{ agentName: "Rovara Code", text: "base" }] });
    // Same id but a different kind starts from nothing.
    expect(resolved.steps[3]?.settings).toEqual({ instructions: [] });
    expect(ResolvedRecipeSchema.safeParse(resolved).success).toBe(true);
  });

  it("builds sequence steps from scratch when the base has none", () => {
    const overlay: RecipeOverlay = { sequence: [{ id: "build", name: "build", kind: "build", settings: { instructions: "Write tests first.", model: MODEL_A } }] };
    const resolved = applyOverlay(EMPTY_RECIPE, overlay, LAYER);
    expect(resolved.steps[0]?.settings).toEqual({ model: MODEL_A, instructions: [{ agentName: "Payments Expert", text: "Write tests first." }] });
  });

  it("patches a step: scalars replace, null clears, instructions append a layer", () => {
    const base = recipeOf([build("build", { model: MODEL_A, thinkingLevel: "high", instructions: [{ agentName: "Rovara Code", text: "base" }] })]);
    const resolved = applyOverlay(base, { steps: { build: { model: MODEL_B, thinkingLevel: null, instructions: "child", stepBudgetUsd: 5 } } }, LAYER);
    expect(resolved.steps[0]?.settings).toEqual({
      model: MODEL_B,
      stepBudgetUsd: 5,
      instructions: [{ agentName: "Rovara Code", text: "base" }, { agentName: "Payments Expert", text: "child" }],
    });
  });

  it("clears a model with null", () => {
    const base = recipeOf([build("build", { model: MODEL_A, fallbackModel: MODEL_B })]);
    const resolved = applyOverlay(base, { steps: { build: { model: null } } }, LAYER);
    expect(resolved.steps[0]?.settings).toEqual({ fallbackModel: MODEL_B, instructions: [] });
  });

  it("resolves two instruction layers in chain order", () => {
    const first = applyOverlay(EMPTY_RECIPE, { instructions: "first", sequence: [{ id: "build", name: "b", kind: "build" }] }, BASE_LAYER);
    const second = applyOverlay(first, { instructions: "second", steps: { build: { instructions: "second build" } } }, LAYER);
    expect(second.instructions).toEqual([{ agentName: "Rovara Code", text: "first" }, { agentName: "Payments Expert", text: "second" }]);
    expect(second.steps[0]?.settings.instructions).toEqual([{ agentName: "Payments Expert", text: "second build" }]);
  });

  it("intersects a coding step's tools with the base step's tools, and replaces them when the base has none", () => {
    const base = recipeOf([build("build", { tools: ["read", "edit", "bash"] }), review("review", ["code"], undefined)]);
    const narrowed = applyOverlay(base, { steps: { build: { tools: ["read", "bash", "write"] } } }, LAYER);
    expect(narrowed.steps[0]?.settings).toMatchObject({ tools: ["read", "bash"] });
    const fresh = applyOverlay(base, { steps: { review: { tools: ["read", "grep"] } } }, LAYER);
    expect(fresh.steps[1]?.settings).toMatchObject({ tools: ["read", "grep"] });
  });

  it("replaces an agent step's tools", () => {
    const base = recipeOf([agentStep("look", "none", { tools: ["linear__get_*"] })]);
    const resolved = applyOverlay(base, { steps: { look: { tools: ["jira__*"] } } }, LAYER);
    expect(resolved.steps[0]?.settings).toMatchObject({ tools: ["jira__*"] });
  });

  it("leaves unknown step ids out of the result and reports them as a problem, not a throw", () => {
    const base = rovaraCode();
    const overlay: RecipeOverlay = { steps: { nobody: { model: MODEL_A } } };
    expect(() => applyOverlay(base, overlay, LAYER)).not.toThrow();
    expect(applyOverlay(base, overlay, LAYER).steps).toEqual(base.steps);
    expect(overlayProblems(base, overlay)).toEqual([{ path: "steps.nobody", message: "no step has that id" }]);
    // The ids a new sequence defines count, the base's replaced ones do not.
    expect(overlayProblems(base, { sequence: [{ id: "build", name: "b", kind: "build" }], steps: { build: { model: MODEL_A } } })).toEqual([]);
    expect(overlayProblems(base, { sequence: [{ id: "build", name: "b", kind: "build" }], steps: { plan: { model: MODEL_A } } })).toHaveLength(1);
  });

  it("replaces tools and triggers, and unions alwaysAsk with the base", () => {
    const grant = { connector: { type: "linear" as const }, access: "read" as const };
    const base = recipeOf([build()], { tools: [{ connector: { type: "github" }, access: "read" }], approvals: { alwaysAsk: ["delete_*", "create_issue"] } });
    const resolved = applyOverlay(base, { tools: [grant], triggers: [{ kind: "person" }], approvals: { alwaysAsk: ["create_issue", "merge_*"] } }, LAYER);
    expect(resolved.tools).toEqual([grant]);
    expect(resolved.approvals.alwaysAsk).toEqual(["delete_*", "create_issue", "merge_*"]);
    const survives = applyOverlay(base, { approvals: { alwaysAsk: [] } }, LAYER);
    expect(survives.approvals.alwaysAsk).toEqual(["delete_*", "create_issue"]);
    expect(applyOverlay(base, {}, LAYER).approvals.alwaysAsk).toEqual(["delete_*", "create_issue"]);
  });

  it("keeps allowMentions false unless a layer sets it, and a child can set it back", () => {
    expect(applyOverlay(EMPTY_RECIPE, {}, LAYER).allowMentions).toBe(false);
    const on = applyOverlay(EMPTY_RECIPE, { allowMentions: true }, BASE_LAYER);
    expect(on.allowMentions).toBe(true);
    expect(applyOverlay(on, {}, LAYER).allowMentions).toBe(true);
    expect(applyOverlay(on, { allowMentions: false }, LAYER).allowMentions).toBe(false);
  });

  it("replaces autonomy", () => {
    expect(applyOverlay(EMPTY_RECIPE, {}, LAYER).autonomy).toBe("prepare");
    expect(applyOverlay(EMPTY_RECIPE, { autonomy: "run" }, LAYER).autonomy).toBe("run");
  });

  it("makes skills the base minus remove plus add, with no duplicates", () => {
    const skill = (n: string, digest = "a".repeat(64)) => ({ skillId: `skl_${n.repeat(20)}`, name: `skill-${n}`, description: `Skill ${n}`, digest });
    const base = recipeOf([build()], { skills: [skill("a"), skill("b")] });
    const lookup = (ref: { skillId: string; digest?: string | undefined }) => {
      const letter = ref.skillId.slice(4, 5);
      return skill(letter, ref.digest ?? "c".repeat(64));
    };
    const resolved = applyOverlay(base, { skills: { remove: [skill("a").skillId], add: [{ skillId: skill("b").skillId, digest: "d".repeat(64) }, { skillId: skill("c").skillId }] } }, LAYER, lookup);
    expect(resolved.skills.map((entry) => entry.skillId)).toEqual([skill("b").skillId, skill("c").skillId]);
    expect(resolved.skills[0]?.digest).toBe("d".repeat(64));
    expect(applyOverlay(base, { skills: { remove: [skill("a").skillId] } }, LAYER).skills).toEqual([skill("b")]);
  });

  it("needs a skill lookup to add a skill", () => {
    expect(() => applyOverlay(EMPTY_RECIPE, { skills: { add: [{ skillId: `skl_${"a".repeat(20)}` }] } }, LAYER)).toThrow(/skill/);
  });

  it("treats a null instructions as adding no layer", () => {
    expect(applyOverlay(EMPTY_RECIPE, { instructions: null }, LAYER).instructions).toEqual([]);
  });
});

describe("codingProgram", () => {
  it("is undefined for Rovara Code's recipe, whatever its step ids and settings", () => {
    expect(codingProgram(rovaraCode())).toBeUndefined();
    const renamed = recipeOf([plan({ model: MODEL_A }), build("implement"), check(), review("rev", ["security", "code"], { backTo: "implement", maxRounds: 3 }), pullRequest()]);
    expect(codingProgram(renamed)).toBeUndefined();
  });

  it("gives a program when two steps are reordered", () => {
    const recipe = recipeOf([plan(), build(), review("review", ["code", "security"], { backTo: "build", maxRounds: 3 }), check(), pullRequest()]);
    expect(codingProgram(recipe)).toEqual({
      steps: [
        { id: "plan", kind: "plan" },
        { id: "build", kind: "build" },
        { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } },
        { id: "check", kind: "check" },
        { id: "pull_request", kind: "pull_request" },
      ],
    });
  });

  it("gives a program when a review setting differs", () => {
    const fewerRounds = rovaraCode();
    fewerRounds.steps[3] = review("review", ["code", "security"], { backTo: "build", maxRounds: 1 });
    expect(codingProgram(fewerRounds)?.steps[3]).toEqual({ id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 1 } });
    const oneReviewer = rovaraCode();
    oneReviewer.steps[3] = review("review", ["code"], { backTo: "build", maxRounds: 3 });
    expect(codingProgram(oneReviewer)).toBeDefined();
    const noFindings = rovaraCode();
    noFindings.steps[3] = review("review", ["code", "security"]);
    expect(codingProgram(noFindings)?.steps[3]).toEqual({ id: "review", kind: "review", reviewers: ["code", "security"] });
  });

  it("gives a program for a custom sequence and none for an agent recipe", () => {
    const custom = recipeOf([build("tests"), build("code"), check(), review("review", ["code", "security"]), pullRequest()]);
    expect(codingProgram(custom)?.steps.map((step) => step.id)).toEqual(["tests", "code", "check", "review", "pull_request"]);
    expect(codingProgram(recipeOf([agentStep()]))).toBeUndefined();
    expect(codingProgram(EMPTY_RECIPE)).toBeUndefined();
  });
});

describe("recipeDigest", () => {
  it("is a SHA-256 hex digest that ignores key order and changes with content", () => {
    const recipe = rovaraCode();
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(recipe).reverse()))) as ResolvedRecipe;
    expect(recipeDigest(recipe)).toMatch(/^[a-f0-9]{64}$/);
    expect(recipeDigest(shuffled)).toBe(recipeDigest(recipe));
    expect(recipeDigest({ ...recipe, autonomy: "run" })).not.toBe(recipeDigest(recipe));
  });
});

describe("diffRecipes", () => {
  it("returns nothing for equal recipes", () => {
    expect(diffRecipes(rovaraCode(), rovaraCode())).toEqual([]);
  });

  it("returns one path for one model change", () => {
    const before = recipeOf([plan(), build("build", { model: MODEL_A })]);
    const after = recipeOf([plan(), build("build", { model: MODEL_B })]);
    expect(diffRecipes(before, after)).toEqual(["/steps/1/settings/model"]);
  });

  it("reports a model set from nothing, and removed, at the setting", () => {
    const before = recipeOf([plan(), build()]);
    const after = recipeOf([plan(), build("build", { model: MODEL_A })]);
    expect(diffRecipes(before, after)).toEqual(["/steps/1/settings/model"]);
    expect(diffRecipes(after, before)).toEqual(["/steps/1/settings/model"]);
  });

  it("reports allowMentions, autonomy and appended steps", () => {
    const before = recipeOf([build()]);
    expect(diffRecipes(before, { ...before, allowMentions: true })).toEqual(["/allowMentions"]);
    expect(diffRecipes(before, { ...before, autonomy: "run" })).toEqual(["/autonomy"]);
    expect(diffRecipes(before, { ...before, steps: [...before.steps, check()] })).toEqual(["/steps/1"]);
    expect(diffRecipes(recipeOf([build(), check()]), before)).toEqual(["/steps/1"]);
  });

  it("reports array element changes by index", () => {
    const before = recipeOf([build()], { approvals: { alwaysAsk: ["delete_*", "create_*"] } });
    const after = recipeOf([build()], { approvals: { alwaysAsk: ["delete_*", "create_issue"] } });
    expect(diffRecipes(before, after)).toEqual(["/approvals/alwaysAsk/1"]);
  });

  it("ignores the chain but for the base's versions, reported as /base/version", () => {
    const own = { agentId: LAYER.agentId, name: "Payments Expert", builtin: false };
    const code = { agentId: "rovara-code" as const, name: "Rovara Code", builtin: true };
    const draft = recipeOf([build()], { chain: [{ ...code, version: 1 }, { ...own, version: "draft" }] });
    const published = recipeOf([build()], { chain: [{ ...code, version: 1 }, { ...own, version: 3 }] });
    expect(diffRecipes(draft, published)).toEqual([]);
    const moved = recipeOf([build()], { chain: [{ ...code, version: 2 }, { ...own, version: 3 }] });
    expect(diffRecipes(published, moved)).toEqual(["/base/version"]);
    const renamed = recipeOf([build()], { chain: [{ ...code, name: "Other", version: 1 }, { ...own, version: 3 }] });
    expect(diffRecipes(published, renamed)).toEqual([]);
  });

  it("escapes / and ~ in keys", () => {
    const before = recipeOf([build()]);
    const after = structuredClone(before);
    (after.steps[0] as { settings: Record<string, unknown> }).settings["a/b~c"] = 1;
    expect(diffRecipes(before, after)).toEqual(["/steps/0/settings/a~1b~0c"]);
  });
});

describe("overlayPaths", () => {
  it("lists what the overlay sets, down to each step setting", () => {
    const overlay = RecipeOverlaySchema.parse({
      instructions: "x",
      steps: { build: { model: MODEL_A, instructions: "y" }, review: {} },
      approvals: { alwaysAsk: [] },
      skills: { add: [] },
      allowMentions: false,
    });
    expect(overlayPaths(overlay)).toEqual(["/instructions", "/steps/build/model", "/steps/build/instructions", "/steps/review", "/approvals/alwaysAsk", "/skills/add", "/allowMentions"]);
    expect(overlayPaths({})).toEqual([]);
  });
});
