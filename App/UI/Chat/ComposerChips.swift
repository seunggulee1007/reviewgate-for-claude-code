import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ReviewGateCore

/// Turns pasted / dropped / picked things into composer inputs: images (§24) and repo-relative mentions (§23).
enum ComposerIntake {
    struct Result {
        var mentions: [String] = []
        var images: [ComposerImage] = []
        /// What was refused, in the user's words (one line per reason).
        var problems: [String] = []
    }

    /// `existingImages`: how many images the composer already holds (the 5-image cap counts them).
    @MainActor
    static func take(_ drop: ComposerDrop, root: URL?, existingImages: Int) -> Result {
        var result = Result()
        switch drop {
        case let .image(data, name):
            add(data, name: name, existing: existingImages, into: &result)
        case let .files(urls):
            var outside: [String] = []
            for url in urls {
                if ImageMediaType(fileExtension: url.pathExtension) != nil {
                    guard let data = try? Data(contentsOf: url) else { result.problems.append(AttachmentProblem.invalid.message); continue }
                    add(data, name: url.lastPathComponent, existing: existingImages + result.images.count, into: &result)
                    continue
                }
                guard let root, let path = ComposerMentions.repoRelativePath(of: url, root: root) else {
                    outside.append(url.lastPathComponent)
                    continue
                }
                var isDir: ObjCBool = false
                FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
                result.mentions.append(isDir.boolValue ? path + "/" : path)
            }
            if !outside.isEmpty {
                result.problems.append(String(localized: "Only files inside this repository can be mentioned: \(outside.joined(separator: ", "))"))
            }
        }
        return result
    }

    private static func add(_ data: Data, name: String, existing: Int, into result: inout Result) {
        switch ComposerImage.validated(data, name: name, existing: existing) {
        case let .success(image): result.images.append(image)
        case let .failure(problem):
            if !result.problems.contains(problem.message) { result.problems.append(problem.message) }
        }
    }

    /// The attach button: PNG / JPEG / GIF / WebP files.
    @MainActor
    static func pickImages() -> [URL] {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.prompt = String(localized: "Attach")
        panel.message = String(localized: "Choose up to 5 images (PNG, JPEG, GIF, WebP · at most 5 MB each)")
        return panel.runModal() == .OK ? panel.urls : []
    }
}

/// The row above the composer's text: mention chips and image thumbnails, each removable.
struct ComposerChipsRow: View {
    @Binding var mentions: [String]
    @Binding var images: [ComposerImage]
    @State private var preview: NSImage?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(images) { image in
                    ImageChip(image: image, onOpen: { preview = NSImage(data: image.data) }) {
                        images.removeAll { $0.id == image.id }
                    }
                }
                ForEach(mentions, id: \.self) { path in
                    MentionChip(path: path) { mentions.removeAll { $0 == path } }
                }
            }
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
        .accessibilityIdentifier("Composer attachments")
        .sheet(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) {
            if let preview { ImagePreviewSheet(image: preview) }
        }
    }
}

/// `@name` with a file / folder icon; the full repo path in its help.
struct MentionChip: View {
    @Environment(\.colorScheme) private var colorScheme
    let path: String
    var onRemove: (() -> Void)?

    private var isDir: Bool { path.hasSuffix("/") }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: isDir ? "folder" : "doc.text")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(verbatim: "@" + ComposerMentions.displayName(path) + (isDir ? "/" : ""))
                .font(.caption.weight(.medium))
                .lineLimit(1)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))   // a 20 pt target over the chip's edge; the chip keeps its size
                .padding(.horizontal, -6).padding(.vertical, -4)
                .foregroundStyle(.secondary)
                .help("Remove the mention")
                .accessibilityLabel("Remove the mention")
            }
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(Color.accentColor.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.35)))
        .foregroundStyle(Color.accentColor)
        .help(ComposerMentions.normalized(path) + (isDir ? "/" : ""))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Mention chip")
    }
}

/// A pending image: thumbnail, size on hover, remove button.
struct ImageChip: View {
    let image: ComposerImage
    var onOpen: () -> Void
    var onRemove: () -> Void
    @State private var hovering = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: onOpen) {
                Group {
                    if let nsImage = NSImage(data: image.data) {
                        Image(nsImage: nsImage).resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Image(systemName: "photo").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.white.opacity(0.12)))
            }
            .buttonStyle(.plain)
            .help("\(image.name) · \(ByteCountFormatter.string(fromByteCount: Int64(image.data.count), countStyle: .file))")
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.black.opacity(0.7))
                    .font(.system(size: 14))
            }
            .buttonStyle(IconButtonStyle(padding: 2))   // a 20 pt target; the glyph stays where it was
            .offset(x: 8, y: -8)
            .opacity(hovering ? 1 : 0.85)
            .help("Remove the image")
            .accessibilityLabel("Remove the image")
        }
        .onHover { hovering = $0 }
        .accessibilityIdentifier("Image chip")
    }
}

/// Quick Look-style preview of an image (composer chip or transcript thumbnail).
struct ImagePreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let image: NSImage
    var caption: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(caption ?? "\(Int(image.size.width)) × \(Int(image.size.height))")
                    .font(.callout).foregroundStyle(.secondary)
                Spacer()
                Button("Copy", systemImage: "doc.on.doc") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.writeObjects([image])
                }
                .help("Copy the image to the clipboard")
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(10)
            Divider()
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(16)
                .background(Color.black.opacity(0.35))
        }
        .frame(minWidth: 420, idealWidth: min(max(image.size.width + 40, 520), 1100),
               minHeight: 320, idealHeight: min(max(image.size.height + 90, 420), 820))
        .accessibilityIdentifier("Image preview")
    }
}
