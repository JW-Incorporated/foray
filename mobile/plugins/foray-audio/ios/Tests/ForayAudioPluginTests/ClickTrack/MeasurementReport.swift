import Foundation

/// Where NE-25a's numbers go: the job summary, and the log.
///
/// THE JOB SUMMARY. `ci.yml`'s ios-kit passes `$GITHUB_STEP_SUMMARY` to the
/// test process as `TEST_RUNNER_FORAY_MEASURE_SUMMARY` (xcodebuild strips the
/// prefix), and a Simulator process can write a host path, so each table is
/// appended there as Markdown. Absent the variable (a local Xcode run), the
/// tables still print.
///
/// THE LOG. Every table line is printed with an `NE-25a |` prefix, and every
/// trial as one `NE-25a-json` line, so a run whose summary was lost can still
/// be read back from `gh run view --log`. Another card's measurements pass
/// their own `tag` (NE-25b's two-deck spike prints `NE-25b |`), so each
/// card's lines can be grepped out of a run that measured both.
enum MeasurementReport {
    static var environment: [String: String] { ProcessInfo.processInfo.environment }

    /// `run <id> @ <sha>` when ci.yml passed it, else "local".
    static var runLabel: String {
        environment["FORAY_MEASURE_RUN"].map { "run \($0)" } ?? "local (no FORAY_MEASURE_RUN)"
    }

    static var deviceLabel: String {
        let model = environment["SIMULATOR_DEVICE_NAME"] ?? environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "unknown device"
        return "\(model), \(ProcessInfo.processInfo.operatingSystemVersionString)"
    }

    static func table(title: String, columns: [String], rows: [[String]], notes: [String], tag: String = "NE-25a") {
        var lines: [String] = ["", "### \(title)", "", "\(runLabel) · \(deviceLabel)", ""]
        lines.append("| " + columns.joined(separator: " | ") + " |")
        lines.append("|" + columns.map { _ in "---" }.joined(separator: "|") + "|")
        for row in rows {
            lines.append("| " + row.joined(separator: " | ") + " |")
        }
        if !notes.isEmpty {
            lines.append("")
            lines.append(contentsOf: notes.map { "- " + $0 })
        }
        for line in lines {
            print("\(tag) | " + line)
        }
        append(lines.joined(separator: "\n") + "\n")
    }

    static func json<T: Encodable>(_ value: T, tag: String = "NE-25a") {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return }
        print("\(tag)-json " + text)
    }

    private static func append(_ text: String) {
        guard let path = environment["FORAY_MEASURE_SUMMARY"], !path.isEmpty else { return }
        guard let handle = FileHandle(forWritingAtPath: path) else {
            print("NE-25a | could not open the job summary at \(path); the tables above are the record")
            return
        }
        defer { handle.closeFile() }
        handle.seekToEndOfFile()
        handle.write(Data(text.utf8))
    }
}

/// Milliseconds, one decimal; "-" for a number that was not measured.
func ms(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite else { return "-" }
    return String(format: "%.1f", seconds * 1000)
}

func msValue(_ milliseconds: Double) -> String {
    String(format: "%.1f", milliseconds)
}
