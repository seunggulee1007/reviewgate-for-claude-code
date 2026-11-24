// Puts the README demo's frames (SHOTS_LAYOUT=demo in scripts/screenshots.sh) together into a looping GIF, with ImageIO —
// nothing to install (no ffmpeg, gifski or Pillow). Each frame is scaled down onto a dark canvas with a caption band under
// it: a step number, the caption and an optional quieter second part. A frame may also ring one region of the window
// (what the step clicks).
//
//   xcrun swift scripts/make-gif.swift <manifest.tsv> <frames-dir> <out.gif> [width]      (width: default 1000 px)
//
// The manifest has one line per frame, tab-separated (lines starting with # are skipped):
//
//   <frame.png>  <seconds>  <step>  <caption>[|<second part>]  [<x>,<y>,<w>,<h> to ring, in window points from the top left]
//
// An empty step ("-") draws no number. A line `@points <width>` gives the window's width in points: the frames have the
// pixels of the screen the tour ran on (1× or 2×), the rings stay in points. Example: scripts/demo-gif.en.tsv.
import AppKit
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Frame {
    let image: CGImage
    let seconds: Double
    let step: String
    let caption: String
    let detail: String
    let ring: CGRect?
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("make-gif: \(message)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments.dropFirst().map { $0 }
guard args.count >= 3 else { fail("usage: make-gif.swift <manifest.tsv> <frames-dir> <out.gif> [width]") }
let manifest = URL(fileURLWithPath: args[0])
let framesDir = URL(fileURLWithPath: args[1], isDirectory: true)
let output = URL(fileURLWithPath: args[2])
let width = args.count > 3 ? Int(args[3]) ?? 1000 : 1000

// MARK: Reading the manifest

guard let text = try? String(contentsOf: manifest, encoding: .utf8) else { fail("cannot read \(manifest.path)") }
var frames: [Frame] = []
var pointsWide: Double?
for (number, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
    if trimmed.hasPrefix("@points") {
        pointsWide = Double(trimmed.dropFirst("@points".count).trimmingCharacters(in: .whitespaces))
        continue
    }
    let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
    guard fields.count >= 4, let seconds = Double(fields[1]) else { fail("\(manifest.lastPathComponent):\(number + 1): want <png> <seconds> <step> <caption>") }
    let url = framesDir.appendingPathComponent(fields[0])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("cannot read \(url.path)")
    }
    let parts = fields[3].split(separator: "|", maxSplits: 1).map(String.init)
    var ring: CGRect?
    if fields.count > 4, !fields[4].isEmpty {
        let n = fields[4].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard n.count == 4, let pointsWide else { fail("\(manifest.lastPathComponent):\(number + 1): the ring is x,y,w,h after an @points line") }
        let k = Double(image.width) / pointsWide   // points → this frame's pixels
        ring = CGRect(x: n[0] * k, y: n[1] * k, width: n[2] * k, height: n[3] * k)
    }
    frames.append(Frame(image: image, seconds: seconds, step: fields[2] == "-" ? "" : fields[2],
                        caption: parts[0], detail: parts.count > 1 ? parts[1] : "", ring: ring))
}
guard !frames.isEmpty else { fail("no frames in \(manifest.path)") }

// MARK: Drawing

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: srgb, components: [CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255,
                                           CGFloat(hex & 0xff) / 255, alpha])!
}
let canvasColor = rgb(0x0B0D10)
let ruleColor = rgb(0x23272E)
let captionColor = rgb(0xF2F4F7)
let detailColor = rgb(0x9AA4B2)
let stepColor = rgb(0x3B82F6)
let ringColor = rgb(0xFACC15)

let margin = CGFloat((Double(width) * 0.016).rounded())     // around the window
let band = CGFloat((Double(width) * 0.064).rounded())       // the caption band under it
let scale = (CGFloat(width) - 2 * margin) / CGFloat(frames[0].image.width)
let windowHeight = (CGFloat(frames[0].image.height) * scale).rounded()
let height = Int(margin + windowHeight + band)

func font(_ size: CGFloat, _ weight: NSFont.Weight) -> CTFont { NSFont.systemFont(ofSize: size, weight: weight) as CTFont }
func line(_ string: String, _ font: CTFont, _ color: CGColor) -> CTLine {
    CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]))
}

func render(_ frame: Frame) -> CGImage {
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("no context") }
    ctx.setFillColor(canvasColor)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // The window, scaled down (its rounded corners fall on the canvas).
    let windowRect = CGRect(x: margin, y: band, width: CGFloat(width) - 2 * margin, height: windowHeight)
    ctx.interpolationQuality = .high
    ctx.draw(frame.image, in: windowRect)
    if let ring = frame.ring {   // the frame's pixels from its top left → the canvas (bottom-left origin)
        let r = CGRect(x: windowRect.minX + ring.minX * scale, y: windowRect.maxY - ring.maxY * scale,
                       width: ring.width * scale, height: ring.height * scale).insetBy(dx: -4, dy: -4)
        let path = CGPath(roundedRect: r, cornerWidth: 7, cornerHeight: 7, transform: nil)
        ctx.setStrokeColor(rgb(0xFACC15, 0.28))
        ctx.setLineWidth(8)
        ctx.addPath(path)
        ctx.strokePath()
        ctx.setStrokeColor(ringColor)
        ctx.setLineWidth(2.5)
        ctx.addPath(path)
        ctx.strokePath()
    }
    // The caption band.
    ctx.setFillColor(ruleColor)
    ctx.fill(CGRect(x: 0, y: band - 1, width: CGFloat(width), height: 1))
    let size = (band * 0.30).rounded()
    var x = margin + 6
    let baseline = (band - size) / 2 + size * 0.22
    if !frame.step.isEmpty {
        let d = (size * 1.45).rounded()
        let circle = CGRect(x: x, y: (band - d) / 2, width: d, height: d)
        ctx.setFillColor(stepColor)
        ctx.fillEllipse(in: circle)
        let number = line(frame.step, font(size * 0.78, .bold), captionColor)
        let w = CTLineGetTypographicBounds(number, nil, nil, nil)
        ctx.textPosition = CGPoint(x: circle.midX - w / 2, y: circle.midY - size * 0.28)
        CTLineDraw(number, ctx)
        x = circle.maxX + size * 0.7
    }
    let caption = line(frame.caption, font(size, .semibold), captionColor)
    ctx.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(caption, ctx)
    if !frame.detail.isEmpty {
        let detail = line(frame.detail, font(size * 0.86, .regular), detailColor)
        ctx.textPosition = CGPoint(x: x + CTLineGetTypographicBounds(caption, nil, nil, nil) + size * 0.7, y: baseline)
        CTLineDraw(detail, ctx)
    }
    guard let image = ctx.makeImage() else { fail("no image") }
    return image
}

// MARK: Writing the GIF

guard let gif = CGImageDestinationCreateWithURL(output as CFURL, UTType.gif.identifier as CFString, frames.count, nil) else {
    fail("cannot write \(output.path)")
}
CGImageDestinationSetProperties(gif, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for frame in frames {
    let delay = frame.seconds as NSNumber
    CGImageDestinationAddImage(gif, render(frame), [kCGImagePropertyGIFDictionary: [
        kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay,
    ]] as CFDictionary)
}
guard CGImageDestinationFinalize(gif) else { fail("could not finish \(output.path)") }
let bytes = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
let total = frames.reduce(0) { $0 + $1.seconds }
print("make-gif: \(output.path) — \(frames.count) frames, \(width)×\(height), \(String(format: "%.1f", total)) s, \(bytes / 1024) KB")
