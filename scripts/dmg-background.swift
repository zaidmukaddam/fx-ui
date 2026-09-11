import AppKit
import CoreText

let size = NSSize(width: 640, height: 360)
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let fonts = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../assets/dmg-fonts")
for name in ["Geist-Regular", "Geist-Medium"] {
    CTFontManagerRegisterFontsForURL(fonts.appendingPathComponent("\(name).otf") as CFURL, .process, nil)
}

func gray(_ value: CGFloat) -> NSColor {
    NSColor(calibratedWhite: value, alpha: 1)
}

func label(_ text: String, x: CGFloat = 48, top: CGFloat, font: NSFont, color: NSColor, tracking: CGFloat = 0) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    (text as NSString).draw(in: NSRect(x: x, y: size.height - top - 80, width: size.width - x - 48, height: 80), withAttributes: [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: style,
        .kern: tracking,
    ])
}

let representations = [1, 2].map { scale -> NSBitmapImageRep in
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(size.width) * scale,
        pixelsHigh: Int(size.height) * scale, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    gray(0.035).setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

    label("Install fx", top: 22, font: NSFont(name: "Geist-Medium", size: 32)!, color: gray(0.98), tracking: -1)
    label("Drag fx to Applications.", top: 68,
          font: NSFont(name: "Geist-Regular", size: 14)!, color: gray(0.70))

    // Finder renders native filenames in black over image backgrounds.
    // Give only the native filename captions a contrasting surface.
    gray(0.72).setFill()
    for center: CGFloat in [176, 464] {
        NSBezierPath(roundedRect: NSRect(x: center - 72, y: 98, width: 144, height: 26),
                     xRadius: 4, yRadius: 4).fill()
    }

    let arrow = NSBezierPath()
    let arrowY = size.height - 184 // Same top-origin center as icon_locations in dmg-settings.py.
    arrow.move(to: NSPoint(x: 296, y: arrowY))
    arrow.line(to: NSPoint(x: 344, y: arrowY))
    arrow.move(to: NSPoint(x: 336, y: arrowY + 8))
    arrow.line(to: NSPoint(x: 344, y: arrowY))
    arrow.line(to: NSPoint(x: 336, y: arrowY - 8))
    arrow.lineWidth = 1.5
    gray(0.65).setStroke()
    arrow.stroke()

    label("Once copied, open fx from Applications.", top: 310,
          font: NSFont(name: "Geist-Regular", size: 13)!, color: gray(0.70))

    NSGraphicsContext.restoreGraphicsState()
    return bitmap
}

try NSBitmapImageRep.representationOfImageReps(in: representations, using: .tiff, properties: [.compressionMethod: 5])!.write(to: output)
try representations[1].representation(using: .png, properties: [:])!.write(to: output.deletingPathExtension().appendingPathExtension("png"))
