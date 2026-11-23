// Reads the text in PNGs (Vision, on this Mac — nothing leaves it) and fails when one shows the home folder's path, so a
// screenshot of the app never carries the real `/Users/<name>`. Used by scripts/screenshots.sh on every tour's PNGs.
//
//   xcrun swift scripts/png-home-check.swift <png>…     exit 0: none shows it; 1: the lines that do ("HOME PATH …")
//
// Text recognition can read a "/" as "l", "I" or "|", so "Users" followed by up to two characters and the account name counts too.
import AppKit
import Foundation
import Vision

let home = (ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()).lowercased()
let name = (home as NSString).lastPathComponent
let loose = name.count >= 2
    ? try? NSRegularExpression(pattern: "users.{0,2}" + NSRegularExpression.escapedPattern(for: name) + "(?![a-z0-9])")
    : nil

func showsHome(_ line: String) -> Bool {
    let text = line.lowercased()
    if text.contains(home) { return true }
    guard let loose else { return false }
    return loose.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

var found = 0
for path in CommandLine.arguments.dropFirst() {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        print("png-home-check: cannot read \(path)")
        found += 1
        continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    for line in (request.results ?? []).compactMap({ $0.topCandidates(1).first?.string }) where showsHome(line) {
        print("HOME PATH \((path as NSString).lastPathComponent): \(line)")
        found += 1
    }
}
exit(found == 0 ? 0 : 1)
