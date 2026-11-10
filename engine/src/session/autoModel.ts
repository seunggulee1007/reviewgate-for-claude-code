// MARK: wave5 w5-model — §43.4 auto model: which model a message goes out on, decided from the message alone (pure).
import { AUTO_MODEL_POLICIES, type AutoModelPolicy, type AutoModelReason, type ModelFamily, type ModelOption } from "../protocol.js";

/** What the engine knows about the message about to go out. */
export type AutoModelInput = {
  /** The user's own text (no review-gate prefix, no budget note). */
  text: string;
  policy: AutoModelPolicy;
  /** @-mentioned paths and attached images. */
  mentions?: number;
  attachments?: number;
  /** The session is in plan mode (planning benefits most from the strongest model). */
  planMode?: boolean;
  /** The first message after a plan was approved (the implementation turn). */
  planImplementation?: boolean;
  /** The previous turn failed, its changes were rejected / rewound, or this message requests changes. */
  retry?: "failed" | "rewound" | "rejected" | "changes_requested" | null;
  /** The family the previous turn ran on: a bare "계속" / "go on" keeps it. */
  previousFamily?: ModelFamily | null;
};

export type AutoModelDecision = { family: ModelFamily; reason: AutoModelReason };

/** A message longer than this is a big request on its own. */
export const AUTO_LONG_MESSAGE_CHARS = 1000;
/** Balanced: a simple request this short goes to haiku. */
export const AUTO_VERY_SHORT_CHARS = 60;
/** Cost: a simple request up to this long goes to haiku; any other request up to `AUTO_COST_SHORT_CHARS` without a build verb too. */
export const AUTO_SIMPLE_CHARS = 200;
export const AUTO_COST_SHORT_CHARS = 40;

const DESIGN = [
  /설계|아키텍처|아키텍쳐|트레이드\s?오프|장단점|접근\s?방식/,
  /구조(를|을|도)?\s?(잡|바꾸|바꿔|개선|재구성|다시|설계|나누)/,
  /방향(을|성)?\s?(잡|정해|정하|제안)|어떤\s?(방식|방법|구조)(이|가)\s?(나|좋|맞)/,
  /\b(design|architect|architecture|trade-?offs?|pros and cons|approach(es)?)\b/i,
];
const DEBUG = [
  /원인|디버그|디버깅|버그|에러|오류|예외|실패(해|하|가|했|한|합)|안\s?(돼|되|됨|됩)|재현|스택\s?트레이스|크래시|깨져|깨지|터져|터지|먹통|NPE/,
  /\b(debug|debugging|root cause|investigate|fail|fails|failing|failed|failure|crash|crashes|crashing|broken|regression|flaky|stack ?trace|bug|bugs)\b|exception|doesn'?t work|not working/i,
];
const REFACTOR = [
  /리팩터|리팩토링|리펙토링|구조\s?개선|중복\s?제거|추출해|모듈화|분리해|일반화/,
  /\b(refactor|refactoring|restructure|restructuring|decouple|deduplicate)\b|\bextract (a |an |the )?(method|class|function|module|service|interface)\b/i,
];
const WHY = [/왜|어째서/, /\bwhy\b|\bhow come\b/i];
const WIDE = [
  /(프로젝트|코드베이스|코드|모듈|레포|저장소|시스템|서비스)\s?(전체|전반)|전체\s?(코드|구조|프로젝트|모듈|파일|소스)|모든\s?(파일|클래스|모듈|서비스|곳|패키지)|여러\s?(파일|모듈|클래스|서비스|패키지|곳)|전반적|일괄|마이그레이션|전면/,
  /\b(across the (codebase|code ?base|repo|repository|project|modules?)|entire (codebase|project|repo|repository|module|app)|every file|all (the )?files|whole (codebase|project|repo|repository|module|app)|multiple (files|modules|services|packages)|codebase-wide|repo-wide|migrate|migration)\b/i,
];
const TRIVIAL = [
  /오타|맞춤법|철자|이름.{0,40}(바꿔|바꾸|변경|수정)|리네임|포맷|포매팅|포메팅|들여쓰기|공백|줄\s?바꿈|세미콜론|import\s?(문)?\s?정리|주석(을|만)?\s?(달아|추가|지워|삭제|수정)/,
  /\b(typo|typos|spelling|rename|reformat|format|formatting|indent|indentation|whitespace|lint|prettier)\b/i,
];
const BUILD_VERB = /추가|구현|만들|작성|생성|개발|붙여|넣어|\b(implement|add|create|build|write|generate)\b/i;
const QUICK_KO = /(알려\s?(줘|주세요|줄래)|뭐야|뭐지|뭔데|뭔가요|뭐예요|뭐에요|인가요|인지|있어|있나요|되나요|어디야|몇\s?개야)[.!~]?\s*$/;
const QUICK_EN = /^(what|where|which|who|when|is|are|does|do|did|can|could|how many|how much)\b[^\n]*\?\s*$/i;
const CONTINUE = /^(계속\s?(해|하자|해서|해\s?줘|진행\s?(해|해\s?줘)?)?|진행\s?(해|하자|해\s?줘|시켜)?|그렇게\s?(해|하자|해\s?줘|진행해)|좋아(요)?|ㅇㅇ|응|네|예|ok|okay|go on|go ahead|continue|proceed|yes|yep|lgtm|sounds good|다음(으로)?|다음\s?단계(\s?진행해)?)[.!~\s]*$/i;

const RETRY_REASON: Record<NonNullable<AutoModelInput["retry"]>, AutoModelReason> = {
  failed: "after_failure",
  rewound: "after_revert",
  rejected: "after_revert",
  changes_requested: "changes_requested",
};

const any = (res: RegExp[], text: string): boolean => res.some((r) => r.test(text));

/** `settings.modelAutoPolicy`, unknown / absent = `balanced`. */
export function autoModelPolicy(raw: unknown): AutoModelPolicy {
  return typeof raw === "string" && (AUTO_MODEL_POLICIES as readonly string[]).includes(raw) ? (raw as AutoModelPolicy) : "balanced";
}

/**
 * §43.4: the family a message goes out on. opus for planning, the plan's implementation, a retry, design, debugging,
 * refactoring, "why", a wide scope, a long message or many attachments — the strongest reason named — when the policy's
 * threshold is met (balanced / quality: one reason; cost: two, a plan counting as two). haiku only for simple requests
 * (a typo, a rename, formatting, a short factual question): balanced when very short, cost when simple or short;
 * quality never. A bare "계속" / "go on" keeps the previous family. Everything else: sonnet (quality: opus).
 */
export function decideAutoModel(input: AutoModelInput): AutoModelDecision {
  const text = input.text.trim();
  const reasons: AutoModelReason[] = [];
  if (input.planImplementation) reasons.push("plan_implementation");
  if (input.planMode) reasons.push("plan_mode");
  if (input.retry) reasons.push(RETRY_REASON[input.retry]);
  if (any(DESIGN, text)) reasons.push("design");
  if (any(DEBUG, text)) reasons.push("debug");
  if (any(REFACTOR, text)) reasons.push("refactor");
  if (any(WHY, text)) reasons.push("why");
  if (any(WIDE, text)) reasons.push("wide_scope");
  if (text.length > AUTO_LONG_MESSAGE_CHARS) reasons.push("long_message");
  const mentions = input.mentions ?? 0;
  const attachments = input.attachments ?? 0;
  if (attachments >= 3 || mentions + attachments >= 5) reasons.push("attachments");
  const strength = reasons.reduce((n, r) => n + (r === "plan_mode" || r === "plan_implementation" ? 2 : 1), 0);
  const threshold = input.policy === "cost" ? 2 : 1;
  if (strength >= threshold) return { family: "opus", reason: reasons[0]! };
  if (strength === 0 && input.previousFamily && CONTINUE.test(text)) return { family: input.previousFamily, reason: "continuation" };
  const oneLine = !text.includes("\n");
  const trivial = any(TRIVIAL, text);
  const quick = !trivial && oneLine && !BUILD_VERB.test(text) && (QUICK_EN.test(text) || /[?？]\s*$/.test(text) || QUICK_KO.test(text));
  const simple: AutoModelReason | null = trivial ? "trivial_edit" : quick ? "quick_question" : null;
  switch (input.policy) {
    case "quality":
      return simple && text.length <= AUTO_SIMPLE_CHARS ? { family: "sonnet", reason: "simple_task" } : { family: "opus", reason: "quality_policy" };
    case "cost":
      if (strength > 0) return { family: "sonnet", reason: "cost_policy" };
      if (simple && text.length <= AUTO_SIMPLE_CHARS) return { family: "haiku", reason: simple };
      if (oneLine && text.length <= AUTO_COST_SHORT_CHARS && !BUILD_VERB.test(text)) return { family: "haiku", reason: "short_message" };
      return { family: "sonnet", reason: "standard" };
    default:
      if (simple && oneLine && text.length <= AUTO_VERY_SHORT_CHARS) return { family: "haiku", reason: simple };
      return { family: "sonnet", reason: "standard" };
  }
}

/** The family of a model value or id (`opus`, `claude-sonnet-5-5`, `claude-3-5-haiku-…`); null for any other model. */
export function modelFamily(id: string | null | undefined): ModelFamily | null {
  if (!id) return null;
  if (/opus/i.test(id)) return "opus";
  if (/sonnet/i.test(id)) return "sonnet";
  if (/haiku/i.test(id)) return "haiku";
  return null;
}

/** major * 1000 + minor of an id (`claude-opus-4-1-20250805` → 4001); -1 when it carries none. */
function versionOf(id: string): number {
  const nums = id.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").match(/\d+/g);
  if (!nums || nums.length === 0) return -1;
  return Number(nums[0]) * 1000 + Number(nums[1] ?? 0);
}

/**
 * §43.4: the option `value` auto sends for a family — the newest the session offers (an alias the CLI did not resolve
 * counts as the newest of its family), a plain context window before a `[1m]` variant; never `default`. null when the
 * session offers none of that family.
 */
export function pickFamilyModel(family: ModelFamily, models: readonly ModelOption[]): string | null {
  const of = models.filter((m) => m.value !== "default" && (modelFamily(m.value) === family || modelFamily(m.resolvedModel) === family));
  const plain = of.filter((m) => !m.value.includes("[") && !(m.resolvedModel ?? "").includes("["));
  const pool = plain.length > 0 ? plain : of;
  let best: { value: string; v: number } | null = null;
  for (const m of pool) {
    const v = m.resolvedModel ? versionOf(m.resolvedModel) : m.value.toLowerCase() === family ? Number.POSITIVE_INFINITY : versionOf(m.value);
    if (!best || v > best.v || (v === best.v && m.value.length < best.value.length)) best = { value: m.value, v };
  }
  return best?.value ?? null;
}
