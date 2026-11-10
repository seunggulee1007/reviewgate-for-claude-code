import SwiftUI
import ReviewGateCore

/// Review submission: summary, event (COMMENT / APPROVE / REQUEST_CHANGES) and the drafts that
/// will be posted as inline comments. Submit posts one review via `PRStore.submit`; the sheet
/// stays open showing `store.errorText` (gh stderr verbatim) on failure. The summary and the event are the store's
/// (`reviewSummaryDraft` / `reviewEventDraft`): Cancel to add one more inline comment and they are still there.
struct SubmitReviewSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(PRStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var submitError: String?

    private var summary: String { store.reviewSummaryDraft }
    private var event: ReviewEvent { store.reviewEventDraft }

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 12) {
            if let pr = store.selected {
                Text("Review \(store.selectedSummary?.repo ?? "")#\(pr.number)").font(.headline)
                Text(pr.title).font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }

            Text("Summary").font(.subheadline.weight(.medium))
            TextEditor(text: $store.reviewSummaryDraft)
                .font(.callout)
                .frame(minHeight: 90, maxHeight: 160)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                .accessibilityIdentifier("Review summary")

            Picker("Event", selection: $store.reviewEventDraft) {
                Text("Comment").tag(ReviewEvent.comment)
                Text("Approve").tag(ReviewEvent.approve)
                Text("Request changes").tag(ReviewEvent.requestChanges)
            }
            .pickerStyle(.radioGroup)
            .horizontalRadioGroupLayout()
            .accessibilityIdentifier("Review event")

            Text("Inline comments (\(store.draftComments.count))").font(.subheadline.weight(.medium))
            if store.draftComments.isEmpty {
                Text("No drafts — only the summary will be posted.").font(.caption).foregroundStyle(.secondary)
            } else {
                List(store.draftComments) { draft in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(draft.path):\(draft.line)")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                        Text(verbatim: firstLine(draft.body)).font(.callout).lineLimit(1)
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.bordered)
                .frame(minHeight: 80, maxHeight: 200)
            }

            if let submitError {
                ScrollView {
                    Text(verbatim: submitError)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
                .padding(8)
                .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 6))
                .accessibilityIdentifier("Submit error")
            }

            HStack {
                if store.isSubmitting { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(store.isSubmitting)
                Button(store.draftComments.isEmpty ? "Submit summary only" : "Submit review") { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit || store.isSubmitting)
                    .accessibilityIdentifier("Submit review")
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    /// GitHub rejects COMMENT / REQUEST_CHANGES reviews with neither a body nor comments.
    private var canSubmit: Bool {
        event == .approve || !store.draftComments.isEmpty
            || !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() async {
        submitError = nil
        let hadDrafts = !store.draftComments.isEmpty
        await store.submit(event: event, body: summary)
        // Drafts are cleared only when the POST succeeded (a failed comment reload afterwards keeps errorText set).
        let posted = store.errorText == nil || (hadDrafts && store.draftComments.isEmpty)
        if posted {
            store.reviewSummaryDraft = ""
            store.reviewEventDraft = .comment
            dismiss()
        } else {
            submitError = store.errorText ?? String(localized: "Review was not submitted.")
        }
    }

    private func firstLine(_ s: String) -> String {
        String(s.split(whereSeparator: \.isNewline).first ?? "")
    }
}
