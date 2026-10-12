// MARK: wave5 w5-model — §43.4 auto model: the per-message decision (pure) and the model it maps to.
import { describe, expect, it } from "vitest";
import { autoModelPolicy, decideAutoModel, modelFamily, pickFamilyModel, type AutoModelInput } from "../src/session/autoModel.js";
import type { AutoModelPolicy, ModelOption } from "../src/protocol.js";
import { STATIC_MODELS } from "../src/session/models.js";

type Case = [text: string, family: "opus" | "sonnet" | "haiku", reason: string, extra?: Partial<AutoModelInput>];

const run = (policy: AutoModelPolicy, cases: Case[]): void => {
  for (const [text, family, reason, extra] of cases) {
    it(`${policy}: ${text.slice(0, 60) || "(signals)"} → ${family} (${reason})`, () => {
      expect(decideAutoModel({ text, policy, ...extra })).toMatchObject({ family, reason });
    });
  }
};

describe("§43.4 decideAutoModel — balanced (the default)", () => {
  run("balanced", [
    // opus: design, debugging, refactoring, "why", wide scope, size
    ["로그인 모듈 아키텍처를 어떻게 나눌지 설계해 줘", "opus", "design"],
    ["Design the caching layer for the order service", "opus", "design"],
    ["결제 API 를 동기로 둘지 이벤트로 바꿀지 트레이드오프 정리해 줘", "opus", "design"],
    ["What are the pros and cons of splitting this module?", "opus", "design"],
    ["이 테스트가 실패하는 원인 분석해 줘", "opus", "debug"],
    ["NPE 가 나는데 디버깅 해 줘", "opus", "debug"],
    ["The build is failing with a NullPointerException in OrderMapper, investigate", "opus", "debug"],
    ["배치가 가끔 안 돼요. 재현해서 고쳐 줘", "opus", "debug"],
    ["OrderService 를 리팩터링해서 결제 로직을 분리해 줘", "opus", "refactor"],
    ["Refactor the payment module into smaller services", "opus", "refactor"],
    ["중복 제거하고 공통 유틸로 추출해 줘", "opus", "refactor"],
    ["왜 여기서 트랜잭션을 새로 여는 거야?", "opus", "why"],
    ["Why do we cache the token twice?", "opus", "why"],
    ["프로젝트 전체에서 javax 를 jakarta 로 마이그레이션해 줘", "opus", "wide_scope"],
    ["src 아래 여러 파일에 걸쳐 로깅 방식을 통일해 줘", "opus", "wide_scope"],
    ["Update every file that imports the old logger", "opus", "wide_scope"],
    ["보고서를 만들어 줘. " + "요구사항을 자세히 적을게. ".repeat(80), "opus", "long_message"],
    ["이 스크린샷들 보고 화면 맞춰 줘", "opus", "attachments", { attachments: 3 }],
    ["이 파일들 보고 같은 패턴으로 맞춰 줘", "opus", "attachments", { mentions: 5 }],
    // the session's own signals
    ["로그인 개선", "opus", "plan_mode", { planMode: true }],
    ["Implement the approved plan at /p/plan.md.", "opus", "plan_implementation", { planImplementation: true }],
    ["다시 해 줘", "opus", "after_failure", { retry: "failed" }],
    ["다른 방법으로 해 줘", "opus", "after_revert", { retry: "rewound" }],
    ["이번엔 이름만 바꿔 줘", "opus", "after_revert", { retry: "rejected" }],
    ["[Review gate] Changes requested: a.ts:3 이 조건 빼 줘", "opus", "changes_requested", { retry: "changes_requested" }],
    // haiku: very short and simple
    ["오타 고쳐 줘: recieve → receive", "haiku", "trivial_edit"],
    ["Fix the typo in README", "haiku", "trivial_edit"],
    ["변수 이름 userNm 을 userName 으로 바꿔 줘", "haiku", "trivial_edit"],
    ["Rename getUsr to getUser", "haiku", "trivial_edit"],
    ["이 파일 포맷 맞춰 줘", "haiku", "trivial_edit"],
    ["import 정리해 줘", "haiku", "trivial_edit"],
    ["지금 브랜치 이름이 뭐야?", "haiku", "quick_question"],
    ["What does parseDate return?", "haiku", "quick_question"],
    // sonnet: everything else
    ["UserController 에 페이징 API 추가해 줘", "sonnet", "standard"],
    ["Add a unit test for the CSV parser", "sonnet", "standard"],
    ["로그인 폼에 비밀번호 확인 필드를 추가하고 맞지 않으면 안내 문구를 보여 줘", "sonnet", "standard"],
    ["전체 테스트 돌려 줘", "sonnet", "standard"],
    ["버튼 색을 파란색으로 바꾸고 hover 일 때 조금 어둡게 해 줘. 다크 모드에서도 보이게.", "sonnet", "standard"],
    // simple words in a longer request are no longer "very short"
    ["README 의 설치 절차에 오타가 몇 개 있는데 고치면서 macOS 와 Windows 각각의 설치 순서도 새로 정리해서 써 줘", "sonnet", "standard"],
  ]);
});

describe("§43.4 decideAutoModel — cost", () => {
  run("cost", [
    ["Design the caching layer for the order service", "sonnet", "cost_policy"],
    ["이 테스트가 실패하는 원인 분석해 줘", "sonnet", "cost_policy"],
    ["왜 실패하는지 디버깅하고 구조도 다시 설계해 줘", "opus", "design"],
    ["로그인 개선", "opus", "plan_mode", { planMode: true }],
    ["Implement the approved plan at /p/plan.md.", "opus", "plan_implementation", { planImplementation: true }],
    ["UserController 에 페이징 API 추가해 줘", "sonnet", "standard"],
    ["테스트 돌려 줘", "haiku", "short_message"],
    ["오타 고쳐 줘", "haiku", "trivial_edit"],
    ["Rename the `cfg` variable to `config` everywhere in this file and keep the comments as they are", "haiku", "trivial_edit"],
    ["이 클래스가 어디서 쓰이는지 알려 줘", "haiku", "quick_question"],
  ]);
});

describe("§43.4 decideAutoModel — quality", () => {
  run("quality", [
    ["Fix the typo in README", "sonnet", "simple_task"],
    ["지금 브랜치 이름이 뭐야?", "sonnet", "simple_task"],
    ["UserController 에 페이징 API 추가해 줘", "opus", "quality_policy"],
    ["Add a unit test for the CSV parser", "opus", "quality_policy"],
    ["Design the caching layer for the order service", "opus", "design"],
    ["다시 해 줘", "opus", "after_failure", { retry: "failed" }],
  ]);
});

describe("§43.4 decideAutoModel — rules", () => {
  it("the strongest reason is named first (plan > retry > design > debug > refactor > why > scope > size)", () => {
    expect(decideAutoModel({ text: "왜 실패하는지 원인 분석하고 리팩터링 방향을 설계해 줘", policy: "balanced" }).reason).toBe("design");
    expect(decideAutoModel({ text: "Refactor this and tell me why it broke", policy: "balanced", planImplementation: true }).reason).toBe("plan_implementation");
    expect(decideAutoModel({ text: "Design it", policy: "balanced", retry: "failed" }).reason).toBe("after_failure");
  });
  it("a bare \"계속\" / \"go on\" keeps the previous turn's family (any policy); without one it is an ordinary message", () => {
    expect(decideAutoModel({ text: "계속 진행해", policy: "balanced", previousFamily: "opus" })).toEqual({ family: "opus", reason: "continuation" });
    expect(decideAutoModel({ text: "ok, go on", policy: "cost", previousFamily: "opus" })).toMatchObject({ family: "haiku" });
    expect(decideAutoModel({ text: "go on", policy: "cost", previousFamily: "opus" })).toEqual({ family: "opus", reason: "continuation" });
    expect(decideAutoModel({ text: "그렇게 해 줘!", policy: "quality", previousFamily: "sonnet" })).toEqual({ family: "sonnet", reason: "continuation" });
    expect(decideAutoModel({ text: "계속", policy: "balanced" })).toEqual({ family: "sonnet", reason: "standard" });
    expect(decideAutoModel({ text: "계속해서 리팩터링해 줘", policy: "balanced", previousFamily: "haiku" })).toEqual({ family: "opus", reason: "refactor" });
  });
  it("an empty or whitespace message is standard work", () => {
    expect(decideAutoModel({ text: "   ", policy: "balanced" })).toMatchObject({ family: "sonnet", reason: "standard" });
  });
  it("unknown policies read as balanced", () => {
    expect(autoModelPolicy("quality")).toBe("quality");
    expect(autoModelPolicy("turbo")).toBe("balanced");
    expect(autoModelPolicy(undefined)).toBe("balanced");
  });
});

describe("§43.4 modelFamily / pickFamilyModel", () => {
  it("reads the family from aliases and ids", () => {
    expect(modelFamily("opus")).toBe("opus");
    expect(modelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(modelFamily("claude-3-5-haiku-20241022")).toBe("haiku");
    expect(modelFamily("claude-fable-5-1")).toBeNull();
    expect(modelFamily(null)).toBeNull();
  });
  it("the static list: the newest of each family", () => {
    expect(pickFamilyModel("opus", STATIC_MODELS)).toBe("claude-opus-5-5");
    expect(pickFamilyModel("sonnet", STATIC_MODELS)).toBe("claude-sonnet-5-5");
    expect(pickFamilyModel("haiku", STATIC_MODELS)).toBe("claude-haiku-5-5");
  });
  it("the CLI's list: the newest version, a plain context window before a 1M variant, an alias without a resolved id counts as newest", () => {
    const models: ModelOption[] = [
      { value: "default", displayName: "Default", description: "", resolvedModel: "claude-sonnet-5-5" },
      { value: "claude-opus-4-1-20250805", displayName: "Opus 4.1", description: "" },
      { value: "opus", displayName: "Opus", description: "", resolvedModel: "claude-opus-5-5" },
      { value: "opus[1m]", displayName: "Opus 1M", description: "", resolvedModel: "claude-opus-5-5[1m]" },
      { value: "sonnet", displayName: "Sonnet", description: "" },
      { value: "claude-sonnet-4-5-20250929", displayName: "Sonnet 4.5", description: "" },
      { value: "claude-3-5-haiku-20241022", displayName: "Haiku 3.5", description: "" },
      { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
    ];
    expect(pickFamilyModel("opus", models)).toBe("opus");
    expect(pickFamilyModel("sonnet", models)).toBe("sonnet");
    expect(pickFamilyModel("haiku", models)).toBe("claude-haiku-4-5-20251001");
  });
  it("a family the session does not offer: none (the caller falls back)", () => {
    expect(pickFamilyModel("haiku", [{ value: "claude-opus-5-5", displayName: "Opus", description: "" }])).toBeNull();
    expect(pickFamilyModel("opus", [{ value: "opus[1m]", displayName: "Opus 1M", description: "" }])).toBe("opus[1m]");
  });
});
