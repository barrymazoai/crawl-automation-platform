import AppKit
import Foundation
import PDFKit

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--extract-text" {
  let input = URL(fileURLWithPath: CommandLine.arguments[2])
  guard let document = PDFDocument(url: input) else {
    fputs("unable to read PDF\n", stderr)
    exit(65)
  }
  let pages: [[String: Any]] = (0..<document.pageCount).compactMap { index in
    guard let page = document.page(at: index) else { return nil }
    return ["index": index, "text": page.string ?? ""]
  }
  let payload: [String: Any] = ["pageCount": document.pageCount, "pages": pages]
  guard JSONSerialization.isValidJSONObject(payload) else {
    fputs("unable to serialize PDF text\n", stderr)
    exit(66)
  }
  let data = try JSONSerialization.data(withJSONObject: payload)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  exit(0)
}

guard CommandLine.arguments.count == 3 else {
  fputs("usage: render-pdf-pages.swift INPUT.pdf OUTPUT_DIR | --extract-text INPUT.pdf\n", stderr)
  exit(64)
}

let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let document = PDFDocument(url: input) else {
  fputs("unable to read PDF\n", stderr)
  exit(65)
}
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

for index in 0..<document.pageCount {
  guard let page = document.page(at: index) else { continue }
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2.0
  let width = max(1, Int(bounds.width * scale))
  let height = max(1, Int(bounds.height * scale))
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { continue }
  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else { continue }
  NSGraphicsContext.current = context
  context.cgContext.setFillColor(NSColor.white.cgColor)
  context.cgContext.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.cgContext.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: context.cgContext)
  NSGraphicsContext.restoreGraphicsState()
  guard let data = bitmap.representation(using: .png, properties: [:]) else { continue }
  try data.write(to: output.appendingPathComponent(String(format: "page-%03d.png", index + 1)))
}

print("{\"pageCount\":\(document.pageCount)}")
