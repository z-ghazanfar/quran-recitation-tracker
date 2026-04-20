import AVFoundation
import CWhisper
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

enum BackendError: Error, LocalizedError {
  case invalidArguments(String)
  case unsupportedOS
  case screenRecordingPermissionDenied
  case microphonePermissionDenied
  case noShareableDisplay
  case whisperFailed(String)
  case invalidAudioFormat

  var errorDescription: String? {
    switch self {
    case let .invalidArguments(message):
      return message
    case .unsupportedOS:
      return "The native local transcription backend requires macOS 15 or newer."
    case .screenRecordingPermissionDenied:
      return "Screen Recording permission is required so the app can capture desktop audio."
    case .microphonePermissionDenied:
      return "Microphone permission is required so the app can capture local microphone audio."
    case .noShareableDisplay:
      return "No shareable display was available for desktop audio capture."
    case let .whisperFailed(message):
      return "Local Whisper transcription failed: \(message)"
    case .invalidAudioFormat:
      return "The native audio pipeline received an unsupported audio buffer format."
    }
  }
}

struct CLIOptions {
  enum Command {
    case capture
    case captureWav
    case transcribeFile(String)
  }

  var command: Command = .capture
  var whisperPath = ""
  var modelPath = ""
  var language = "ar"
  var chunkDurationSeconds = 2.0
  var chunkStepSeconds = 0.75
  var beamSize = 2
  var bestOf = 2
  var temperature = 0.0
  var noFallback = false
  var initialPrompt = ""
  var carryInitialPrompt = false
  var suppressNonSpeechTokens = false
  var maxTokens = 48
  var audioContext = 0
  var singleSegment = false
  var noContext = false
  var useGpu = true
  var flashAttention = true
  var gpuDevice = 0
}

func emit(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object) else {
    return
  }

  do {
    let data = try JSONSerialization.data(withJSONObject: object, options: [])
    guard let line = String(data: data, encoding: .utf8) else {
      return
    }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  } catch {
    FileHandle.standardError.write(Data("Failed to encode backend event: \(error)\n".utf8))
  }
}

func parseOptions() throws -> CLIOptions {
  var options = CLIOptions()
  let arguments = Array(CommandLine.arguments.dropFirst())
  var index = 0

  while index < arguments.count {
    let argument = arguments[index]

    switch argument {
    case "capture":
      options.command = .capture
    case "capture-wav":
      options.command = .captureWav
    case "transcribe-file":
      guard index + 1 < arguments.count else {
        throw BackendError.invalidArguments("Missing file path after transcribe-file.")
      }
      options.command = .transcribeFile(arguments[index + 1])
      index += 1
    case "--whisper":
      guard index + 1 < arguments.count else {
        throw BackendError.invalidArguments("Missing path after --whisper.")
      }
      options.whisperPath = arguments[index + 1]
      index += 1
    case "--model":
      guard index + 1 < arguments.count else {
        throw BackendError.invalidArguments("Missing path after --model.")
      }
      options.modelPath = arguments[index + 1]
      index += 1
    case "--language":
      guard index + 1 < arguments.count else {
        throw BackendError.invalidArguments("Missing language after --language.")
      }
      options.language = arguments[index + 1]
      index += 1
    case "--chunk-seconds":
      guard index + 1 < arguments.count, let value = Double(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --chunk-seconds.")
      }
      options.chunkDurationSeconds = value
      index += 1
    case "--step-seconds":
      guard index + 1 < arguments.count, let value = Double(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --step-seconds.")
      }
      options.chunkStepSeconds = value
      index += 1
    case "--beam-size":
      guard index + 1 < arguments.count, let value = Int(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --beam-size.")
      }
      options.beamSize = value
      index += 1
    case "--best-of":
      guard index + 1 < arguments.count, let value = Int(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --best-of.")
      }
      options.bestOf = value
      index += 1
    case "--temperature":
      guard index + 1 < arguments.count, let value = Double(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --temperature.")
      }
      options.temperature = value
      index += 1
    case "--no-fallback":
      options.noFallback = true
    case "--prompt":
      guard index + 1 < arguments.count else {
        throw BackendError.invalidArguments("Missing text after --prompt.")
      }
      options.initialPrompt = arguments[index + 1]
      index += 1
    case "--carry-initial-prompt":
      options.carryInitialPrompt = true
    case "--suppress-nst":
      options.suppressNonSpeechTokens = true
    case "--max-tokens":
      guard index + 1 < arguments.count, let value = Int(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --max-tokens.")
      }
      options.maxTokens = value
      index += 1
    case "--audio-ctx":
      guard index + 1 < arguments.count, let value = Int(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --audio-ctx.")
      }
      options.audioContext = value
      index += 1
    case "--single-segment":
      options.singleSegment = true
    case "--no-context":
      options.noContext = true
    case "--no-gpu":
      options.useGpu = false
    case "--no-flash-attn":
      options.flashAttention = false
    case "--gpu-device":
      guard index + 1 < arguments.count, let value = Int(arguments[index + 1]) else {
        throw BackendError.invalidArguments("Missing numeric value after --gpu-device.")
      }
      options.gpuDevice = value
      index += 1
    default:
      throw BackendError.invalidArguments("Unknown argument: \(argument)")
    }

    index += 1
  }

  switch options.command {
  case .capture, .transcribeFile:
    guard !options.modelPath.isEmpty else {
      throw BackendError.invalidArguments("Missing required --model argument.")
    }
  case .captureWav:
    break
  }

  if case .transcribeFile = options.command, options.whisperPath.isEmpty {
    throw BackendError.invalidArguments("Missing required --whisper argument.")
  }

  return options
}

func normalizeTranscript(_ transcript: String) -> String {
  transcript
    .split(whereSeparator: \.isNewline)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: " ")
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

extension String {
  func withOptionalCString<Result>(_ body: (UnsafePointer<CChar>?) throws -> Result) rethrows -> Result {
    if isEmpty {
      return try body(nil)
    }

    return try withCString { pointer in
      try body(pointer)
    }
  }
}

@inline(__always)
func runMainLoopForever() -> Never {
  RunLoop.main.run()
  exit(0)
}

func writeMonoPcm16Wav(samples: [Float], sampleRate: Int, to outputURL: URL) throws {
  var wavData = Data()
  let dataSize = UInt32(samples.count * MemoryLayout<Int16>.size)
  let riffChunkSize = UInt32(36) + dataSize
  let byteRate = UInt32(sampleRate * MemoryLayout<Int16>.size)
  let blockAlign = UInt16(MemoryLayout<Int16>.size)

  wavData.append(Data("RIFF".utf8))
  wavData.append(Data(from: riffChunkSize))
  wavData.append(Data("WAVE".utf8))

  wavData.append(Data("fmt ".utf8))
  wavData.append(Data(from: UInt32(16)))
  wavData.append(Data(from: UInt16(1)))
  wavData.append(Data(from: UInt16(1)))
  wavData.append(Data(from: UInt32(sampleRate)))
  wavData.append(Data(from: byteRate))
  wavData.append(Data(from: blockAlign))
  wavData.append(Data(from: UInt16(16)))

  wavData.append(Data("data".utf8))
  wavData.append(Data(from: dataSize))

  for sample in samples {
    let clamped = max(-1.0, min(1.0, sample))
    let pcm = Int16(clamped * Float(Int16.max))
    wavData.append(Data(from: pcm))
  }

  try wavData.write(to: outputURL, options: .atomic)
}

func resampleLinear(_ samples: [Float], from sourceSampleRate: Double, to targetSampleRate: Double) -> [Float] {
  guard !samples.isEmpty else {
    return samples
  }

  guard sourceSampleRate > 0, targetSampleRate > 0 else {
    return samples
  }

  if abs(sourceSampleRate - targetSampleRate) < 0.5 {
    return samples
  }

  let outputCount = max(1, Int(round(Double(samples.count) * targetSampleRate / sourceSampleRate)))
  guard outputCount > 1 else {
    return [samples[0]]
  }

  let step = sourceSampleRate / targetSampleRate
  var output = [Float](repeating: 0, count: outputCount)

  for index in 0..<outputCount {
    let sourcePosition = Double(index) * step
    let lowerIndex = min(Int(sourcePosition), samples.count - 1)
    let upperIndex = min(lowerIndex + 1, samples.count - 1)
    let fraction = Float(sourcePosition - Double(lowerIndex))
    let lowerSample = samples[lowerIndex]
    let upperSample = samples[upperIndex]
    output[index] = lowerSample + ((upperSample - lowerSample) * fraction)
  }

  return output
}

extension Data {
  init<T>(from value: T) {
    var mutableValue = value
    self = Swift.withUnsafeBytes(of: &mutableValue) { Data($0) }
  }
}

final class TimelineBuffer {
  private var baseSampleIndex = 0
  private var samples: [Float] = []
  private(set) var latestSampleIndex = 0
  private var hasData = false

  func insert(_ newSamples: [Float], at sampleIndex: Int) {
    guard !newSamples.isEmpty else {
      return
    }

    if !hasData {
      baseSampleIndex = sampleIndex
      hasData = true
    }

    if sampleIndex < baseSampleIndex {
      let prependCount = baseSampleIndex - sampleIndex
      samples.insert(contentsOf: repeatElement(0, count: prependCount), at: 0)
      baseSampleIndex = sampleIndex
    }

    let relativeStart = sampleIndex - baseSampleIndex
    let relativeEnd = relativeStart + newSamples.count

    if relativeEnd > samples.count {
      samples.append(contentsOf: repeatElement(0, count: relativeEnd - samples.count))
    }

    for (offset, sample) in newSamples.enumerated() {
      samples[relativeStart + offset] += sample
    }

    latestSampleIndex = max(latestSampleIndex, sampleIndex + newSamples.count)
  }

  func extract(from startSampleIndex: Int, length: Int) -> [Float] {
    guard length > 0 else {
      return []
    }

    var output = [Float](repeating: 0, count: length)
    guard hasData else {
      return output
    }

    let sourceStart = max(startSampleIndex, baseSampleIndex)
    let sourceEnd = min(startSampleIndex + length, baseSampleIndex + samples.count)

    guard sourceEnd > sourceStart else {
      return output
    }

    let destinationOffset = sourceStart - startSampleIndex
    let sourceOffset = sourceStart - baseSampleIndex
    let count = sourceEnd - sourceStart

    output.replaceSubrange(
      destinationOffset..<(destinationOffset + count),
      with: samples[sourceOffset..<(sourceOffset + count)]
    )

    return output
  }

  func trim(before sampleIndex: Int) {
    guard hasData else {
      return
    }

    let trimCount = max(0, sampleIndex - baseSampleIndex)
    guard trimCount > 0 else {
      return
    }

    if trimCount >= samples.count {
      samples.removeAll(keepingCapacity: true)
      baseSampleIndex = sampleIndex
      latestSampleIndex = max(latestSampleIndex, sampleIndex)
      return
    }

    samples.removeFirst(trimCount)
    baseSampleIndex += trimCount
  }
}

struct WhisperRunner {
  let whisperPath: String
  let modelPath: String
  let language: String
  let beamSize: Int
  let bestOf: Int
  let temperature: Double
  let noFallback: Bool
  let initialPrompt: String
  let carryInitialPrompt: Bool
  let suppressNonSpeechTokens: Bool
  let threads = max(2, ProcessInfo.processInfo.activeProcessorCount / 2)

  func transcribe(audioFileURL: URL) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: whisperPath)
    var arguments = [
      "-m", modelPath,
      "-f", audioFileURL.path,
      "-l", language,
      "-nt",
      "-np",
      "-t", "\(threads)",
      "-bo", "\(bestOf)",
      "-tp", "\(temperature)",
    ]

    if beamSize > 1 {
      arguments.append(contentsOf: ["-bs", "\(beamSize)"])
    }

    if noFallback {
      arguments.append("-nf")
    }

    if suppressNonSpeechTokens {
      arguments.append("-sns")
    }

    if !initialPrompt.isEmpty {
      arguments.append(contentsOf: ["--prompt", initialPrompt])
    }

    if carryInitialPrompt {
      arguments.append("--carry-initial-prompt")
    }

    process.arguments = arguments

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    try process.run()
    process.waitUntilExit()

    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
    let stdoutText = String(data: stdoutData, encoding: .utf8) ?? ""
    let stderrText = String(data: stderrData, encoding: .utf8) ?? ""

    guard process.terminationStatus == 0 else {
      throw BackendError.whisperFailed(stderrText.isEmpty ? stdoutText : stderrText)
    }

    return normalizeTranscript(stdoutText)
  }
}

final class PersistentWhisperSession: @unchecked Sendable {
  private let handle: UnsafeMutableRawPointer
  private let language: String
  private let beamSize: Int32
  private let bestOf: Int32
  private let temperature: Float
  private let noFallback: Bool
  private let initialPrompt: String
  private let carryInitialPrompt: Bool
  private let suppressNonSpeechTokens: Bool
  private let singleSegment: Bool
  private let noContext: Bool
  private let audioContext: Int32
  private let maxTokens: Int32
  private let threads: Int32

  init(options: CLIOptions) throws {
    let handle = try options.modelPath.withCString { modelPathPointer -> UnsafeMutableRawPointer in
      guard let sessionHandle = tarteel_whisper_session_create(
        modelPathPointer,
        options.useGpu,
        options.flashAttention,
        Int32(options.gpuDevice)
      ) else {
        throw BackendError.whisperFailed("Failed to initialize the local Whisper session.")
      }

      return sessionHandle
    }

    self.handle = handle
    self.language = options.language
    self.beamSize = Int32(options.beamSize)
    self.bestOf = Int32(options.bestOf)
    self.temperature = Float(options.temperature)
    self.noFallback = options.noFallback
    self.initialPrompt = options.initialPrompt
    self.carryInitialPrompt = options.carryInitialPrompt
    self.suppressNonSpeechTokens = options.suppressNonSpeechTokens
    self.singleSegment = options.singleSegment
    self.noContext = options.noContext
    self.audioContext = Int32(options.audioContext)
    self.maxTokens = Int32(options.maxTokens)
    self.threads = Int32(max(2, min(4, ProcessInfo.processInfo.activeProcessorCount / 2)))
  }

  deinit {
    tarteel_whisper_session_destroy(handle)
  }

  var modelType: String {
    guard let typePointer = tarteel_whisper_session_model_type(handle) else {
      return ""
    }

    return String(cString: typePointer)
  }

  func transcribe(samples: [Float]) throws -> WhisperTranscription {
    guard !samples.isEmpty else {
      return WhisperTranscription(
        transcript: "",
        averageTokenProbability: 0,
        minimumTokenProbability: 0,
        maxNoSpeechProbability: 1,
        tokenCount: 0,
        segmentCount: 0
      )
    }

    return try language.withCString { languagePointer in
      try initialPrompt.withOptionalCString { promptPointer in
        try samples.withUnsafeBufferPointer { sampleBuffer in
          var metrics = tarteel_whisper_transcription_metrics(
            max_no_speech_prob: 1,
            avg_token_prob: 0,
            min_token_prob: 0,
            token_count: 0,
            segment_count: 0
          )
          guard let transcriptPointer = tarteel_whisper_session_transcribe(
            handle,
            sampleBuffer.baseAddress,
            Int32(sampleBuffer.count),
            languagePointer,
            threads,
            beamSize,
            bestOf,
            temperature,
            noFallback,
            promptPointer,
            carryInitialPrompt,
            suppressNonSpeechTokens,
            singleSegment,
            noContext,
            audioContext,
            maxTokens,
            &metrics
          ) else {
            let errorPointer = tarteel_whisper_session_last_error(handle)
            let errorMessage = errorPointer.map { String(cString: $0) }
            throw BackendError.whisperFailed(errorMessage?.isEmpty == false
              ? errorMessage!
              : "The in-process Whisper decoder failed.")
          }

          return WhisperTranscription(
            transcript: normalizeTranscript(String(cString: transcriptPointer)),
            averageTokenProbability: metrics.avg_token_prob,
            minimumTokenProbability: metrics.min_token_prob,
            maxNoSpeechProbability: metrics.max_no_speech_prob,
            tokenCount: Int(metrics.token_count),
            segmentCount: Int(metrics.segment_count)
          )
        }
      }
    }
  }
}

struct WhisperTranscription {
  let transcript: String
  let averageTokenProbability: Float
  let minimumTokenProbability: Float
  let maxNoSpeechProbability: Float
  let tokenCount: Int
  let segmentCount: Int
}

struct AudioWindowMetrics {
  let averageAbs: Float
  let rms: Float
  let peak: Float
  let activeRatio: Float
}

@available(macOS 15.0, *)
final class CaptureCoordinator: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private enum OutputMode {
    case whisper
    case wav
  }

  private struct PendingTranscription {
    let samples: [Float]
    let windowStartMilliseconds: Int
    let metrics: AudioWindowMetrics
  }

  private let sampleRate = 16_000
  private let outputMode: OutputMode
  private let minAverageAbsForDecode: Float = 0.006
  private let minRmsForDecode: Float = 0.0085
  private let minPeakForDecode: Float = 0.05
  private let minActiveRatioForDecode: Float = 0.012
  private let maxNoSpeechProbabilityForEmit: Float = 0.55
  private let minAverageTokenProbabilityForEmit: Float = 0.28
  private let minAverageTokenProbabilityForShortEmit: Float = 0.42
  private let options: CLIOptions
  private let windowSamples: Int
  private let stepSamples: Int
  private let captureQueue = DispatchQueue(label: "com.zghazanfar.tarteel.capture")
  private let transcriptionQueue = DispatchQueue(label: "com.zghazanfar.tarteel.transcription")
  private let systemTimeline = TimelineBuffer()
  private let microphoneTimeline = TimelineBuffer()
  private var stream: SCStream?
  private var whisperSession: PersistentWhisperSession?
  private var wavOutputDir: URL?
  private var wavSequence = 0
  private var baseTimeSeconds: Double?
  private var nextWindowStartSample = 0
  private var lastTranscript = ""
  private var isTranscriptionInFlight = false
  private var pendingTranscription: PendingTranscription?

  init(options: CLIOptions) {
    self.options = options
    switch options.command {
    case .captureWav:
      self.outputMode = .wav
    default:
      self.outputMode = .whisper
    }
    self.windowSamples = Int(Double(sampleRate) * options.chunkDurationSeconds)
    self.stepSamples = Int(Double(sampleRate) * options.chunkStepSeconds)
  }

  func start() async throws {
    try await requestPermissions()
    switch outputMode {
    case .whisper:
      whisperSession = try PersistentWhisperSession(options: options)
    case .wav:
      whisperSession = nil
      wavOutputDir = try prepareWavOutputDirectory()
    }

    let shareableContent = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )

    guard let display = shareableContent.displays.first else {
      throw BackendError.noShareableDisplay
    }

    let filter = SCContentFilter(
      display: display,
      excludingApplications: [],
      exceptingWindows: []
    )

    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.captureMicrophone = true
    configuration.excludesCurrentProcessAudio = false
    configuration.sampleRate = sampleRate
    configuration.channelCount = 1
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 5)

    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    // Display-bound audio capture still produces screen frames, so register a
    // no-op screen output to keep ScreenCaptureKit from tearing the stream down.
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: captureQueue)
    try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: captureQueue)
    try await stream.startCapture()
    self.stream = stream

    emit([
      "type": "ready",
      "sampleRate": sampleRate,
      "windowSeconds": Double(windowSamples) / Double(sampleRate),
      "stepSeconds": Double(stepSamples) / Double(sampleRate),
      "modelType": whisperSession?.modelType ?? "",
      "mode": outputMode == .wav ? "wav" : "whisper",
    ])
  }

  func stop() async {
    guard let stream else {
      return
    }

    do {
      try await stream.stopCapture()
    } catch {
      emit([
        "type": "error",
        "message": "Failed to stop native capture cleanly: \(error.localizedDescription)",
      ])
    }

    self.stream = nil
    self.whisperSession = nil
    if let wavOutputDir {
      try? FileManager.default.removeItem(at: wavOutputDir)
    }
    self.wavOutputDir = nil
  }

  private func requestPermissions() async throws {
    if !CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess() {
      throw BackendError.screenRecordingPermissionDenied
    }

    let microphoneGranted = await AVCaptureDevice.requestAccess(for: .audio)
    if !microphoneGranted {
      throw BackendError.microphonePermissionDenied
    }
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard sampleBuffer.isValid else {
      return
    }

    guard outputType == .audio || outputType == .microphone else {
      return
    }

    do {
      let sampleStart = try startSampleIndex(for: sampleBuffer)
      let samples = try decodeMonoSamples(from: sampleBuffer)

      switch outputType {
      case .audio:
        systemTimeline.insert(samples, at: sampleStart)
      case .microphone:
        microphoneTimeline.insert(samples, at: sampleStart)
      default:
        break
      }

      processAvailableWindows()
    } catch {
      emit([
        "type": "error",
        "message": error.localizedDescription,
      ])
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emit([
      "type": "error",
      "message": "Native macOS capture stopped: \(error.localizedDescription)",
    ])
  }

  private func startSampleIndex(for sampleBuffer: CMSampleBuffer) throws -> Int {
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds

    if baseTimeSeconds == nil {
      baseTimeSeconds = pts
    }

    guard let baseTimeSeconds else {
      return 0
    }

    return max(0, Int((pts - baseTimeSeconds) * Double(sampleRate)))
  }

  private func decodeMonoSamples(from sampleBuffer: CMSampleBuffer) throws -> [Float] {
    guard let asbd = sampleBuffer.formatDescription?.audioStreamBasicDescription else {
      throw BackendError.invalidAudioFormat
    }

    let channelCount = Int(asbd.mChannelsPerFrame)
    guard channelCount > 0 else {
      throw BackendError.invalidAudioFormat
    }

    var decodedSamples: [Float] = []

    try sampleBuffer.withAudioBufferList { audioBufferList, _ in
      let bufferCount = Int(audioBufferList.count)
      guard bufferCount > 0 else {
        throw BackendError.invalidAudioFormat
      }

      let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
      let isSignedInteger = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
      let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
      let bytesPerSample = Int(asbd.mBitsPerChannel / 8)
      guard bytesPerSample > 0 else {
        throw BackendError.invalidAudioFormat
      }

      let firstBuffer = audioBufferList[0]
      let frameCount = isNonInterleaved
        ? Int(firstBuffer.mDataByteSize) / bytesPerSample
        : Int(firstBuffer.mDataByteSize) / max(Int(asbd.mBytesPerFrame), 1)

      guard frameCount > 0 else {
        decodedSamples = []
        return
      }

      decodedSamples = [Float](repeating: 0, count: frameCount)

      if isFloat, asbd.mBitsPerChannel == 32 {
        if isNonInterleaved {
          let availableChannels = min(bufferCount, channelCount)
          for channel in 0..<availableChannels {
            let audioBuffer = audioBufferList[channel]
            guard let data = audioBuffer.mData else {
              throw BackendError.invalidAudioFormat
            }

            let source = data.bindMemory(to: Float.self, capacity: frameCount)
            for frame in 0..<frameCount {
              decodedSamples[frame] += source[frame]
            }
          }

          for frame in 0..<frameCount {
            decodedSamples[frame] /= Float(max(1, min(bufferCount, channelCount)))
          }
          return
        }

        guard let data = firstBuffer.mData else {
          throw BackendError.invalidAudioFormat
        }

        let source = data.bindMemory(to: Float.self, capacity: frameCount * channelCount)
        for frame in 0..<frameCount {
          var total: Float = 0
          for channel in 0..<channelCount {
            total += source[frame * channelCount + channel]
          }
          decodedSamples[frame] = total / Float(channelCount)
        }
        return
      }

      if isSignedInteger, asbd.mBitsPerChannel == 16 {
        if isNonInterleaved {
          let availableChannels = min(bufferCount, channelCount)
          for channel in 0..<availableChannels {
            let audioBuffer = audioBufferList[channel]
            guard let data = audioBuffer.mData else {
              throw BackendError.invalidAudioFormat
            }

            let source = data.bindMemory(to: Int16.self, capacity: frameCount)
            for frame in 0..<frameCount {
              decodedSamples[frame] += Float(source[frame]) / Float(Int16.max)
            }
          }

          for frame in 0..<frameCount {
            decodedSamples[frame] /= Float(max(1, min(bufferCount, channelCount)))
          }
          return
        }

        guard let data = firstBuffer.mData else {
          throw BackendError.invalidAudioFormat
        }

        let source = data.bindMemory(to: Int16.self, capacity: frameCount * channelCount)
        for frame in 0..<frameCount {
          var total: Float = 0
          for channel in 0..<channelCount {
            total += Float(source[frame * channelCount + channel]) / Float(Int16.max)
          }
          decodedSamples[frame] = total / Float(channelCount)
        }
        return
      }

      if isSignedInteger, asbd.mBitsPerChannel == 32 {
        if isNonInterleaved {
          let availableChannels = min(bufferCount, channelCount)
          for channel in 0..<availableChannels {
            let audioBuffer = audioBufferList[channel]
            guard let data = audioBuffer.mData else {
              throw BackendError.invalidAudioFormat
            }

            let source = data.bindMemory(to: Int32.self, capacity: frameCount)
            for frame in 0..<frameCount {
              decodedSamples[frame] += Float(source[frame]) / Float(Int32.max)
            }
          }

          for frame in 0..<frameCount {
            decodedSamples[frame] /= Float(max(1, min(bufferCount, channelCount)))
          }
          return
        }

        guard let data = firstBuffer.mData else {
          throw BackendError.invalidAudioFormat
        }

        let source = data.bindMemory(to: Int32.self, capacity: frameCount * channelCount)
        for frame in 0..<frameCount {
          var total: Float = 0
          for channel in 0..<channelCount {
            total += Float(source[frame * channelCount + channel]) / Float(Int32.max)
          }
          decodedSamples[frame] = total / Float(channelCount)
        }
        return
      }

      throw BackendError.invalidAudioFormat
    }

    return resampleLinear(decodedSamples, from: asbd.mSampleRate, to: Double(sampleRate))
  }

  private func processAvailableWindows() {
    let latestAvailableSample = max(
      systemTimeline.latestSampleIndex,
      microphoneTimeline.latestSampleIndex
    )

    while latestAvailableSample >= nextWindowStartSample + windowSamples {
      let systemWindow = systemTimeline.extract(from: nextWindowStartSample, length: windowSamples)
      let microphoneWindow = microphoneTimeline.extract(from: nextWindowStartSample, length: windowSamples)

      let mixedWindow = zip(systemWindow, microphoneWindow).map { systemSample, microphoneSample in
        max(-1, min(1, systemSample + microphoneSample))
      }

      let metrics = analyzeWindow(mixedWindow)

      if shouldAttemptTranscription(for: metrics) {
        let windowStartMilliseconds = Int(
          Double(nextWindowStartSample) / Double(sampleRate) * 1000
        )
        enqueueTranscription(
          PendingTranscription(
            samples: mixedWindow,
            windowStartMilliseconds: windowStartMilliseconds,
            metrics: metrics
          )
        )
      }

      nextWindowStartSample += stepSamples
      let trimBeforeSample = max(0, nextWindowStartSample - windowSamples)
      systemTimeline.trim(before: trimBeforeSample)
      microphoneTimeline.trim(before: trimBeforeSample)
    }
  }

  private func enqueueTranscription(_ request: PendingTranscription) {
    if isTranscriptionInFlight {
      pendingTranscription = request
      return
    }

    isTranscriptionInFlight = true
    runTranscription(request)
  }

  private func runTranscription(_ request: PendingTranscription) {
    transcriptionQueue.async {
      let decodeStartedAt = DispatchTime.now()

      do {
        switch self.outputMode {
        case .whisper:
          guard let whisperSession = self.whisperSession else {
            throw BackendError.whisperFailed("The local Whisper session was unavailable.")
          }

          let transcription = try whisperSession.transcribe(samples: request.samples)
          let decodeMilliseconds = Int(
            Double(DispatchTime.now().uptimeNanoseconds - decodeStartedAt.uptimeNanoseconds) / 1_000_000
          )

          self.captureQueue.async {
            if self.shouldEmitTranscript(transcription, metrics: request.metrics),
              transcription.transcript != self.lastTranscript {
              self.lastTranscript = transcription.transcript

              emit([
                "type": "transcript",
                "text": transcription.transcript,
                "windowStartMs": request.windowStartMilliseconds,
                "decodeMs": decodeMilliseconds,
                "avgTokenProb": Double(transcription.averageTokenProbability),
                "minTokenProb": Double(transcription.minimumTokenProbability),
                "noSpeechProb": Double(transcription.maxNoSpeechProbability),
                "audioAvgLevel": Double(request.metrics.averageAbs),
                "audioRms": Double(request.metrics.rms),
                "audioPeak": Double(request.metrics.peak),
                "audioActiveRatio": Double(request.metrics.activeRatio),
              ])
            }

            self.finishTranscriptionCycle()
          }
        case .wav:
          let outputURL = try self.writeWindowWav(
            samples: request.samples,
            windowStartMilliseconds: request.windowStartMilliseconds
          )

          let writeMilliseconds = Int(
            Double(DispatchTime.now().uptimeNanoseconds - decodeStartedAt.uptimeNanoseconds) / 1_000_000
          )

          self.captureQueue.async {
            emit([
              "type": "audio-window",
              "path": outputURL.path,
              "windowStartMs": request.windowStartMilliseconds,
              "writeMs": writeMilliseconds,
              "audioAvgLevel": Double(request.metrics.averageAbs),
              "audioRms": Double(request.metrics.rms),
              "audioPeak": Double(request.metrics.peak),
              "audioActiveRatio": Double(request.metrics.activeRatio),
            ])

            self.finishTranscriptionCycle()
          }
        }
      } catch {
        self.captureQueue.async {
          emit([
            "type": "error",
            "message": error.localizedDescription,
          ])

          self.finishTranscriptionCycle()
        }
      }
    }
  }

  private func prepareWavOutputDirectory() throws -> URL {
    let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let dir = base.appendingPathComponent("tarteel-audio-windows-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func writeWindowWav(samples: [Float], windowStartMilliseconds: Int) throws -> URL {
    guard let wavOutputDir else {
      throw BackendError.invalidArguments("WAV output directory was unavailable.")
    }

    wavSequence += 1
    let filename = String(format: "window-%06d-%010d.wav", wavSequence, windowStartMilliseconds)
    let url = wavOutputDir.appendingPathComponent(filename)
    try writeMonoPcm16Wav(samples: samples, sampleRate: sampleRate, to: url)
    return url
  }

  private func analyzeWindow(_ samples: [Float]) -> AudioWindowMetrics {
    guard !samples.isEmpty else {
      return AudioWindowMetrics(averageAbs: 0, rms: 0, peak: 0, activeRatio: 0)
    }

    let activityThreshold: Float = 0.012
    var totalAbs: Float = 0
    var totalSquared: Float = 0
    var peak: Float = 0
    var activeCount = 0

    for sample in samples {
      let magnitude = abs(sample)
      totalAbs += magnitude
      totalSquared += sample * sample
      peak = max(peak, magnitude)
      if magnitude >= activityThreshold {
        activeCount += 1
      }
    }

    let sampleCount = Float(max(1, samples.count))
    return AudioWindowMetrics(
      averageAbs: totalAbs / sampleCount,
      rms: (totalSquared / sampleCount).squareRoot(),
      peak: peak,
      activeRatio: Float(activeCount) / sampleCount
    )
  }

  private func shouldAttemptTranscription(for metrics: AudioWindowMetrics) -> Bool {
    if metrics.averageAbs >= minAverageAbsForDecode {
      return true
    }

    if metrics.rms >= minRmsForDecode && metrics.activeRatio >= minActiveRatioForDecode {
      return true
    }

    if metrics.peak >= minPeakForDecode && metrics.activeRatio >= (minActiveRatioForDecode * 0.7) {
      return true
    }

    return false
  }

  private func shouldEmitTranscript(
    _ transcription: WhisperTranscription,
    metrics: AudioWindowMetrics
  ) -> Bool {
    guard !transcription.transcript.isEmpty else {
      return false
    }

    let wordCount = transcription.transcript
      .split(whereSeparator: \.isWhitespace)
      .count

    if transcription.segmentCount <= 0 || transcription.tokenCount <= 0 {
      return false
    }

    if transcription.averageTokenProbability < minAverageTokenProbabilityForEmit {
      return false
    }

    if wordCount <= 2 &&
      transcription.averageTokenProbability < minAverageTokenProbabilityForShortEmit {
      return false
    }

    if transcription.maxNoSpeechProbability >= maxNoSpeechProbabilityForEmit &&
      transcription.averageTokenProbability < minAverageTokenProbabilityForShortEmit {
      return false
    }

    if metrics.averageAbs < (minAverageAbsForDecode * 0.8) &&
      metrics.activeRatio < minActiveRatioForDecode &&
      transcription.maxNoSpeechProbability >= 0.35 {
      return false
    }

    return true
  }

  private func finishTranscriptionCycle() {
    if let pendingTranscription {
      self.pendingTranscription = nil
      runTranscription(pendingTranscription)
      return
    }

    isTranscriptionInFlight = false
  }
}

@main
struct TarteelMacAudioBackendApp {
  static func main() async {
    do {
      let options = try parseOptions()

      switch options.command {
      case let .transcribeFile(filePath):
        let runner = WhisperRunner(
          whisperPath: options.whisperPath,
          modelPath: options.modelPath,
          language: options.language,
          beamSize: options.beamSize,
          bestOf: options.bestOf,
          temperature: options.temperature,
          noFallback: options.noFallback,
          initialPrompt: options.initialPrompt,
          carryInitialPrompt: options.carryInitialPrompt,
          suppressNonSpeechTokens: options.suppressNonSpeechTokens
        )
        let transcript = try runner.transcribe(audioFileURL: URL(fileURLWithPath: filePath))
        emit([
          "type": "transcript",
          "text": transcript,
          "windowStartMs": 0,
        ])
      case .capture, .captureWav:
        guard #available(macOS 15.0, *) else {
          throw BackendError.unsupportedOS
        }

        let coordinator = CaptureCoordinator(options: options)
        try await coordinator.start()
        runMainLoopForever()
      }
    } catch {
      emit([
        "type": "error",
        "message": error.localizedDescription,
      ])
      exit(1)
    }
  }
}
