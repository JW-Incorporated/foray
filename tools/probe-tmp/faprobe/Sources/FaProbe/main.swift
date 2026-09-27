// THROWAWAY: FluidAudio Kokoro ANE (laishere 7-stage Core ML chain) on the probe passage's
// misaki phoneme chunks, at speed 1.0 and 1.5, per compute-unit route. RTF on CONTENT basis.
import Foundation
import FluidAudio

func maxRssMB() -> Double {
    var u = rusage(); getrusage(RUSAGE_SELF, &u); return Double(u.ru_maxrss) / 1e6
}

let args = CommandLine.arguments
let route = args.count > 1 ? args[1] : "default"
let passagePath = args.count > 2 ? args[2] : "tools/mobile/kokoro-probe-passage.json"
let units: KokoroAneComputeUnits
switch route {
case "cpuOnly": units = .cpuOnly
case "cpuAndGpu": units = .cpuAndGpu
case "aneTailCpu": units = .aneTailCpu
case "allAne": units = .allAne
default: units = .default
}
let data = try Data(contentsOf: URL(fileURLWithPath: passagePath))
let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
var chunks: [String] = []
for line in json["lines"] as! [[String: Any]] {
    for c in line["chunks"] as! [[String: Any]] { chunks.append(c["phonemes"] as! String) }
}
print("route \(route) chunks \(chunks.count) os \(ProcessInfo.processInfo.operatingSystemVersionString) cpus \(ProcessInfo.processInfo.activeProcessorCount)")
let t0 = Date()
let mgr = KokoroAneManager(variant: .english, defaultVoice: "af_heart", computeUnits: units)
try await mgr.initialize()
print(String(format: "init(download+compile) s %.1f", Date().timeIntervalSince(t0)))
// cold first call
let tc = Date()
let cold = try await mgr.synthesizeFromPhonemesDetailed(chunks[0], voice: "af_heart", speed: 1.0)
print(String(format: "COLD chunk0 %.2fs audio in %.2fs", cold.durationSeconds, Date().timeIntervalSince(tc)))
var audio1 = 0.0, synth1 = 0.0, audio15 = 0.0, synth15 = 0.0, nonFinite = 0
for (i, ph) in chunks.enumerated() {
    for sp: Float in [1.0, 1.5] {
        let t = Date()
        let r = try await mgr.synthesizeFromPhonemesDetailed(ph, voice: "af_heart", speed: sp)
        let dt = Date().timeIntervalSince(t)
        let bad = r.samples.filter { !$0.isFinite }.count
        nonFinite += bad
        let peak = r.samples.reduce(Float(0)) { max($0, abs($1.isFinite ? $1 : 0)) }
        if sp == 1.0 { audio1 += r.durationSeconds; synth1 += dt } else { audio15 += r.durationSeconds; synth15 += dt }
        let tm = r.timings
        print(String(format: "chunk %2d len %3d speed %.1f audio %5.2fs synth %.3fs nonfinite %d peak %.3f | albert %.0f post %.0f align %.0f pros %.0f noise %.0f voc %.0f tail %.0f ms",
            i, ph.unicodeScalars.count, sp, r.durationSeconds, dt, bad, peak, tm.albert, tm.postAlbert, tm.alignment, tm.prosody, tm.noise, tm.vocoder, tm.tail))
    }
}
print(String(format: "SUMMARY route %@ speed1.0: audio %.1fs synth %.2fs RTF %.3f | speed1.5: audio %.1fs synth %.2fs RTF(own) %.3f RTF(content basis=synth1.5/audio1.0) %.3f | nonfinite %d | maxrss MB %.0f",
    route, audio1, synth1, synth1 / audio1, audio15, synth15, synth15 / audio15, synth15 / audio1, nonFinite, maxRssMB()))
