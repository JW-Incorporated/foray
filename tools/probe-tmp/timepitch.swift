// Throwaway: cost of AVAudioUnitTimePitch rate 1.5 (offline manual rendering), plus AVSpeechSynthesizer write() RTF.
import AVFoundation
import Foundation

func cpuSeconds() -> Double {
  var u = rusage(); getrusage(RUSAGE_SELF, &u)
  return Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6 + Double(u.ru_stime.tv_sec) + Double(u.ru_stime.tv_usec) / 1e6
}

func stretch(_ inPath: String, _ outPath: String, rate: Float, overlap: Float?) throws {
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: inPath))
  let fmt = file.processingFormat
  let engine = AVAudioEngine(); let player = AVAudioPlayerNode(); let tp = AVAudioUnitTimePitch()
  tp.rate = rate
  if let o = overlap { tp.overlap = o }
  engine.attach(player); engine.attach(tp)
  engine.connect(player, to: tp, format: fmt); engine.connect(tp, to: engine.mainMixerNode, format: fmt)
  try engine.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4096)
  try engine.start(); player.scheduleFile(file, at: nil); player.play()
  let buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096)!
  let out = try AVAudioFile(forWriting: URL(fileURLWithPath: outPath), settings: fmt.settings)
  let target = AVAudioFramePosition(Double(file.length) / Double(rate))
  let w0 = Date(); let c0 = cpuSeconds()
  while engine.manualRenderingSampleTime < target {
    let n = min(AVAudioFrameCount(target - engine.manualRenderingSampleTime), 4096)
    let st = try engine.renderOffline(n, to: buf)
    if st == .success { try out.write(from: buf) } else if st == .error { break }
  }
  let wall = Date().timeIntervalSince(w0), cpu = cpuSeconds() - c0
  let contentSec = Double(file.length) / fmt.sampleRate
  print(String(format: "TIMEPITCH rate %.2f overlap %@: content %.1fs -> out %.1fs; wall %.3fs cpu %.3fs; cpuRTF_content %.5f",
               rate, overlap.map { "\($0)" } ?? "default(8)", contentSec, contentSec / Double(rate), wall, cpu, cpu / contentSec))
  engine.stop()
}

let args = CommandLine.arguments
do {
  try stretch(args[1], "out/timepitch_1.5.wav", rate: 1.5, overlap: nil)
  try stretch(args[1], "out/timepitch_1.5_ov16.wav", rate: 1.5, overlap: 16)
} catch { print("TIMEPITCH ERROR", error) }

// AVSpeechSynthesizer write-to-buffer throughput (the system-voice fallback), best effort on a headless runner.
let text = args.count > 2 ? ((try? String(contentsOfFile: args[2], encoding: .utf8)) ?? "") : ""
if !text.isEmpty {
  let synth = AVSpeechSynthesizer()
  let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en-US") }
  print("AVSPEECH en-US voices:", voices.map { "\($0.name)[q\($0.quality.rawValue)]" }.joined(separator: ", "))
  let u = AVSpeechUtterance(string: text)
  if let v = voices.sorted(by: { $0.quality.rawValue > $1.quality.rawValue }).first { u.voice = v; print("AVSPEECH using", v.name, v.identifier) }
  var frames = 0.0; var sr = 0.0; var done = false
  let w0 = Date(); let c0 = cpuSeconds()
  synth.write(u) { b in
    guard let pb = b as? AVAudioPCMBuffer else { return }
    if pb.frameLength == 0 { done = true; return }
    frames += Double(pb.frameLength); sr = pb.format.sampleRate
  }
  let deadline = Date().addingTimeInterval(240)
  while !done && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  let wall = Date().timeIntervalSince(w0), cpu = cpuSeconds() - c0
  if sr > 0 {
    let a = frames / sr
    print(String(format: "AVSPEECH audio %.1fs (sr %.0f) wall %.2fs cpu(in-process only) %.2fs wallRTF %.4f done %@", a, sr, wall, cpu, wall / a, done ? "yes" : "no"))
  } else { print("AVSPEECH produced no audio; done=\(done)") }
}
