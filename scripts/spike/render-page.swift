// Renders one PDF page to a PNG with macOS PDFKit (no npm packages).
// Usage: swift scripts/spike/render-page.swift <file.pdf> <page (1-based)> <out.png | -> [width=1600]
import AppKit
import PDFKit

let args = CommandLine.arguments
guard args.count >= 4, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])),
      let pageNo = Int(args[2]), let page = doc.page(at: pageNo - 1) else {
  FileHandle.standardError.write("usage: render-page.swift <file.pdf> <page> <out.png> [width]\n".data(using: .utf8)!)
  exit(2)
}
let width = args.count > 4 ? CGFloat(Double(args[4]) ?? 1600) : 1600
let box = page.bounds(for: .mediaBox)
let scale = width / box.width
let size = NSSize(width: box.width * scale, height: box.height * scale)
let image = page.thumbnail(of: size, for: .mediaBox)
guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
// "-" writes the PNG to stdout, so the caller can save it through its own guarded writes.
if args[3] == "-" { FileHandle.standardOutput.write(png) } else { try png.write(to: URL(fileURLWithPath: args[3])) }
