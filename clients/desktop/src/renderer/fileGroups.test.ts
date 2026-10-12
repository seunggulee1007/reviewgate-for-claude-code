// MARK: wave4b w4b-files — §40.2 (comp-14): the list grouped by folder or layer, the same cases as Core's FileGroupsTests.
import { describe, expect, it } from "vitest";
import { compactPath, groupFiles, layerOf, orderByGroups } from "./fileGroups";

const f = (path: string) => ({ path });
const acme = [
  "src/main/webapp/WEB-INF/jsp/user/orders/billing/refund/refundForm.jsp",
  "src/test/java/com/acme/orders/billing/InvoiceServiceTest.java",
  "src/main/resources/mapper/orders/billing/RefundMapper.xml",
  "src/main/java/com/acme/orders/billing/InvoiceServiceImpl.java",
  "src/main/java/com/acme/orders/billing/RefundController.java",
  "src/main/resources/application-dev.yml",
  "README.md",
];

describe("layerOf", () => {
  it("reads a Spring project's layers", () => {
    expect(acme.map(layerOf)).toEqual(["webapp", "test", "mapper", "service", "controller", "resources", "other"]);
    expect(layerOf("src/main/java/com/acme/orders/billing/dao/RefundDao.java")).toBe("mapper");
    expect(layerOf("src/main/java/com/acme/orders/billing/service/impl/Refund.java")).toBe("service");
    expect(layerOf("src/main/java/com/acme/orders/web/controller/Home.java")).toBe("controller");
    expect(layerOf("src/test/java/com/acme/RefundControllerTest.java")).toBe("test");
    expect(layerOf("engine/src/engine.ts")).toBe("other");
  });
});

describe("groupFiles", () => {
  it("keeps the incoming order inside a section and orders layers web → service → SQL", () => {
    const sections = groupFiles(acme.map(f), "layer");
    expect(sections.map((s) => s.key)).toEqual(["controller", "service", "mapper", "resources", "webapp", "test", "other"]);
    expect(orderByGroups(acme.map(f), "layer").map((x) => x.path)).toEqual(sections.flatMap((s) => s.files.map((x) => x.path)));
  });

  it("groups by folder in the order the folders first appear (risky first stays meaningful)", () => {
    const files = ["b/x.ts", "a/y.ts", "b/z.ts", "root.ts"].map(f);
    const sections = groupFiles(files, "folder");
    expect(sections.map((s) => [s.key, s.files.map((x) => x.path)])).toEqual([
      ["b", ["b/x.ts", "b/z.ts"]],
      ["a", ["a/y.ts"]],
      ["", ["root.ts"]],
    ]);
    expect(orderByGroups(files, "folder").map((x) => x.path)).toEqual(["b/x.ts", "b/z.ts", "a/y.ts", "root.ts"]);
  });

  it("is one section in list order without a grouping", () => {
    expect(groupFiles(acme.map(f), "none")).toEqual([{ key: "", files: acme.map(f) }]);
    expect(orderByGroups(acme.map(f), "none").map((x) => x.path)).toEqual(acme);
  });
});

describe("compactPath", () => {
  it("drops the source root and the company package, keeps the module", () => {
    expect(compactPath("src/main/java/com/acme/orders/billing/InvoiceServiceImpl.java")).toBe("…/orders/billing/InvoiceServiceImpl.java");
    expect(compactPath("acme-api/src/main/java/com/acme/orders/Api.java")).toBe("acme-api/…/orders/Api.java");
    expect(compactPath("src/main/resources/mapper/orders/billing/RefundMapper.xml")).toBe("…/mapper/orders/billing/RefundMapper.xml");
    expect(compactPath("src/main/webapp/WEB-INF/jsp/user/orders/billing/refund/refundForm.jsp")).toBe("…/user/orders/billing/refund/refundForm.jsp");
    // Nothing to drop: as it is.
    expect(compactPath("src/main/java/com/acme/App.java")).toBe("…/com/acme/App.java");
    expect(compactPath("engine/src/engine.ts")).toBe("engine/src/engine.ts");
    expect(compactPath("README.md")).toBe("README.md");
  });
});
