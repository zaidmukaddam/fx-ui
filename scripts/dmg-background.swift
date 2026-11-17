// Draws the disk image's install window, as the "DMG — install window,
// round two" artboard has it (D · Command): the install as one shell line
// on black. Three chevrons are the prompt, `mv` the command, the two icons
// its arguments and a block cursor ends the line, blinking.
//
//   swift dmg-background.swift <out.png>
//
// Writes an animated PNG at 2x, which Finder plays as the window's picture.
//
// Finder draws its own file names in black, which black hides, so the
// names here are part of the drawing and sit just under where Finder puts
// its own. The icon centres are in dmg-settings.py; move one and move the
// other.

import AppKit
import CoreText
import ImageIO

let size = NSSize(width: 640, height: 360)
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
CTFontManagerRegisterFontsForURL(
    here.appendingPathComponent("../assets/fonts/GeistMono-Regular.ttf") as CFURL, .process, nil)

func gray(_ value: Int) -> NSColor {
    NSColor(calibratedWhite: CGFloat(value) / 255, alpha: 1)
}

func mono(_ points: CGFloat) -> NSFont {
    NSFont(name: "GeistMono-Regular", size: points) ?? .monospacedSystemFont(ofSize: points, weight: .regular)
}

/// A rectangle given the way the artboard measures it: from the top left.
func box(left: CGFloat, top: CGFloat, width: CGFloat, height: CGFloat) -> NSRect {
    NSRect(x: left, y: size.height - top - height, width: width, height: height)
}

/// One line of type in a box `width` wide, `top` being the top of its line.
func type(
    _ text: String, left: CGFloat, top: CGFloat, width: CGFloat, height: CGFloat,
    font: NSFont, color: NSColor, centred: Bool = false, tracking: CGFloat = 0
) {
    let style = NSMutableParagraphStyle()
    style.alignment = centred ? .center : .left
    style.minimumLineHeight = height
    style.maximumLineHeight = height
    (text as NSString).draw(in: box(left: left, top: top, width: width, height: height), withAttributes: [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: style,
        .kern: tracking,
    ])
}

/// The window with the cursor showing or not: the two frames of its blink.
func frame(cursor: Bool) -> CGImage {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(size.width) * 2,
        pixelsHigh: Int(size.height) * 2, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    NSColor.black.setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

    // The prompt: three chevrons, brightening as they go. Each is 7 wide
    // and 14 tall in a 20pt slot, 2pt apart, level with the command.
    let middle = size.height - 142
    for (slot, shade) in [0x45, 0x7D, 0xC4].enumerated() {
        let left = 89 + CGFloat(slot) * 22
        let chevron = NSBezierPath()
        chevron.move(to: NSPoint(x: left + 7, y: middle + 7))
        chevron.line(to: NSPoint(x: left + 14, y: middle))
        chevron.line(to: NSPoint(x: left + 7, y: middle - 7))
        chevron.lineWidth = 2
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        gray(shade).setStroke()
        chevron.stroke()
    }

    type("mv", left: 169, top: 116, width: 80, height: 52,
         font: mono(44), color: gray(0xED), tracking: -0.88)

    // The arguments are the two icons Finder draws at 298 and 450; these
    // name them, 144 wide under each.
    type("fx.app", left: 226, top: 202, width: 144, height: 16,
         font: mono(12), color: gray(0xA1), centred: true)
    type("/Applications", left: 378, top: 202, width: 144, height: 16,
         font: mono(12), color: gray(0xA1), centred: true)

    if cursor {
        gray(0xED).setFill()
        NSBezierPath(rect: box(left: 526, top: 118, width: 24, height: 48)).fill()
    }

    type("# drag fx onto Applications. that's the whole install.",
         left: 89, top: 266, width: 520, height: 20, font: mono(14), color: gray(0xA1))
    type("# then open it from there",
         left: 89, top: 292, width: 520, height: 20, font: mono(14), color: gray(0x7D))

    NSGraphicsContext.restoreGraphicsState()
    return bitmap.cgImage!
}

// Two frames, half a second each, for ever. 144 dpi makes Finder draw the
// 1280 by 720 pixels in the window's 640 by 360 points.
let image = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 2, nil)!
CGImageDestinationSetProperties(
    image, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGLoopCount: 0]] as CFDictionary)
for cursor in [true, false] {
    CGImageDestinationAddImage(image, frame(cursor: cursor), [
        kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGDelayTime: 0.53],
        kCGImagePropertyDPIWidth: 144,
        kCGImagePropertyDPIHeight: 144,
    ] as CFDictionary)
}
guard CGImageDestinationFinalize(image) else {
    fatalError("could not write \(output.path)")
}
