import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// r2-chats-cards M34 — docs/PROTOCOL.md §24: a pasted Retina screenshot over the 5 MB limit is scaled down to at most
/// 2000 px on its long edge and re-encoded (PNG while that fits — transparency kept — else JPEG, flattened on white) instead
/// of being refused; only an image that still does not fit at 1200 px is refused. The engine's limit is unchanged.
/// Electron: renderer/composerAttach.ts `fitImage`.
public enum ComposerImageFit {
    /// The long edge a scaled-down image gets first (then smaller sizes while it does not fit).
    public static let maxLongEdge = 2000
    static let edges = [maxLongEdge, 1600, 1200]
    static let jpegQualities: [CGFloat] = [0.85, 0.7, 0.55]

    /// `data` (of `type`) re-encoded to at most `maxBytes`; nil when it cannot be read or still does not fit.
    public static func fitted(_ data: Data, type: ImageMediaType, maxBytes: Int = ComposerImage.maxBytes) -> (data: Data, type: ImageMediaType)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
        for edge in edges {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: edge,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            let alpha = hasAlpha(image)
            if alpha || type == .png, let png = encode(image, as: UTType.png), png.count <= maxBytes { return (png, .png) }
            let opaque = alpha ? (flattened(image) ?? image) : image
            for quality in jpegQualities {
                if let jpeg = encode(opaque, as: UTType.jpeg, quality: quality), jpeg.count <= maxBytes { return (jpeg, .jpeg) }
            }
        }
        return nil
    }

    /// `name` with the extension of `type` ("clipboard.png" → "clipboard.jpg").
    public static func renamed(_ name: String, to type: ImageMediaType) -> String {
        let base = (name as NSString).deletingPathExtension
        return "\(base.isEmpty ? "image" : base).\(type.fileExtension)"
    }

    private static func hasAlpha(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: false
        default: true
        }
    }

    private static func encode(_ image: CGImage, as type: UTType, quality: CGFloat? = nil) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
        let props: [CFString: Any] = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] } ?? [:]
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    /// The image over white (JPEG has no transparency: what was transparent would turn black).
    private static func flattened(_ image: CGImage) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(rect)
        ctx.draw(image, in: rect)
        return ctx.makeImage()
    }
}
