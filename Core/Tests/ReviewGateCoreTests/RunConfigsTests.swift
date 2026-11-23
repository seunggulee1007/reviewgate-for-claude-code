import Foundation
import Testing
@testable import ReviewGateCore

/// c-panel (§57.18): the run tab's candidates come from the project's files only (nothing runs), and its commands are
/// kept per project.
@Suite struct RunConfigsTests {
    /// A fixture project on disk: relative path → contents.
    private func project(_ files: [String: String]) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("RunConfigsTests-\(UUID().uuidString)", isDirectory: true)
        for (path, text) in files {
            let url = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }

    private func commands(_ files: [String: String]) throws -> [String] {
        let root = try project(files)
        defer { try? FileManager.default.removeItem(at: root) }
        return RunCandidates.detect(folder: root).map(\.command)
    }

    @Test func packageJsonScriptsInTheirOrderWithNpm() throws {
        let json = #"{"name":"acme-web","scripts":{"build":"vite build","lint":"eslint .","test":"vitest","dev":"vite","start":"node ."}}"#
        #expect(try commands(["package.json": json]) == ["npm run dev", "npm start", "npm test", "npm run build"])
    }

    @Test func theLockfileOrPackageManagerPicksTheRunner() throws {
        let json = #"{"scripts":{"dev":"vite","test":"vitest"}}"#
        #expect(try commands(["package.json": json, "pnpm-lock.yaml": ""]) == ["pnpm run dev", "pnpm test"])
        #expect(try commands(["package.json": json, "yarn.lock": ""]) == ["yarn dev", "yarn test"])
        #expect(try commands(["package.json": json, "bun.lockb": ""]) == ["bun run dev", "bun run test"])
        let declared = #"{"packageManager":"pnpm@9.1.0","scripts":{"serve":"x"}}"#
        #expect(try commands(["package.json": declared, "yarn.lock": ""]) == ["pnpm run serve"])
    }

    @Test func aBrokenOrScriptlessPackageJsonOffersNothing() throws {
        #expect(try commands(["package.json": "{ not json"]).isEmpty)
        #expect(try commands(["package.json": #"{"name":"acme"}"#]).isEmpty)
        #expect(try commands(["package.json": #"{"scripts":{"dev":42}}"#]).isEmpty)
    }

    @Test func gradleWrapperWithSpringBootAndTheApplicationPlugin() throws {
        let groovy = """
        plugins {
            id 'org.springframework.boot' version '3.3.0'
            id 'application'
        }
        """
        #expect(try commands(["gradlew": "#!/bin/sh", "build.gradle": groovy]) == ["./gradlew bootRun", "./gradlew run", "./gradlew test"])
        let kts = """
        plugins {
            id("org.springframework.boot") version "3.3.0"
            kotlin("jvm")
        }
        """
        #expect(try commands(["gradlew": "", "build.gradle.kts": kts]) == ["./gradlew bootRun", "./gradlew test"])
        #expect(try commands(["gradlew": "", "build.gradle.kts": "plugins { `application` }"]) == ["./gradlew run", "./gradlew test"])
        #expect(try commands(["gradlew": "", "settings.gradle.kts": "rootProject.name = \"acme\""]) == ["./gradlew test"])
    }

    @Test func noWrapperNoGradleOrMavenCandidates() throws {
        #expect(try commands(["build.gradle": "id 'org.springframework.boot'"]).isEmpty)
        #expect(try commands(["pom.xml": "<artifactId>spring-boot-maven-plugin</artifactId>"]).isEmpty)
        #expect(try commands(["gradlew": ""]).isEmpty)
    }

    @Test func mavenWrapperWithSpringBoot() throws {
        let pom = "<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>"
        #expect(try commands(["mvnw": "", "pom.xml": pom]) == ["./mvnw spring-boot:run", "./mvnw test"])
        #expect(try commands(["mvnw": "", "pom.xml": "<project/>"]) == ["./mvnw test"])
    }

    @Test func detectedCandidatesCarryStableIdsAndAskFirst() throws {
        let root = try project(["mvnw": "", "pom.xml": "<parent><artifactId>spring-boot-starter-parent</artifactId></parent>"])
        defer { try? FileManager.default.removeItem(at: root) }
        let found = RunCandidates.detect(folder: root)
        #expect(found.map(\.id) == ["maven:spring-boot:run", "maven:test"])
        #expect(found.map(\.name) == ["Maven: spring-boot:run", "Maven: test"])
        #expect(found.allSatisfy { $0.detected && $0.needsConfirmation })
        #expect(!RunConfig(id: "x", name: "Mine", command: "make run").needsConfirmation)
    }

    @Test func theListKeepsSavedFirstAndHidesRemovedDetectedOnes() {
        let detected = [RunConfig(id: "npm:dev", name: "npm: dev", command: "npm run dev", detected: true),
                        RunConfig(id: "npm:test", name: "npm: test", command: "npm test", detected: true)]
        var runs = ProjectRuns()
        #expect(runs.listed(detected: detected).map(\.command) == ["npm run dev", "npm test"])
        var dev = detected[0]
        dev.confirmed = true
        runs.keep(dev)
        runs.keep(RunConfig(id: "u1", name: "Seed", command: "make seed"))
        #expect(runs.listed(detected: detected).map(\.command) == ["npm run dev", "make seed", "npm test"])
        #expect(runs.listed(detected: detected).first?.confirmed == true)
        runs.remove(detected[1])
        #expect(runs.listed(detected: detected).map(\.command) == ["npm run dev", "make seed"])
        runs.restoreDetected()
        #expect(runs.listed(detected: detected).map(\.command) == ["npm run dev", "make seed", "npm test"])
    }

    @Test func runsArePersistedPerProject() {
        let defaults = UserDefaults(suiteName: "RunConfigsTests.\(UUID().uuidString)")!
        var runs = ProjectRuns()
        runs.keep(RunConfig(id: "u1", name: "Web", command: "npm run dev"))
        AppSettings.setProjectRuns(runs, root: "/work/acme", defaults: defaults)
        #expect(AppSettings.projectRuns(root: "/work/acme", defaults: defaults) == runs)
        #expect(AppSettings.projectRuns(root: "/work/other", defaults: defaults) == ProjectRuns())
        AppSettings.setProjectRuns(ProjectRuns(), root: "/work/acme", defaults: defaults)
        #expect(AppSettings.projectRuns(root: "/work/acme", defaults: defaults) == ProjectRuns())
    }
}
