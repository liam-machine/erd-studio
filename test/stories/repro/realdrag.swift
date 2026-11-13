// REPRO helper (gerhard-feedback-3, stage 1): a REAL macOS drag with the Shift key
// pressed at a chosen moment. Posts HID events, so it moves the real pointer:
// run it only against a scripted VS Code window (gerhard3-realdrag.mjs).
//
//   swiftc -O realdrag.swift -o /tmp/realdrag
//   /tmp/realdrag <pid> <fromX> <fromY> <toX> <toY> <mode>
//
// Coordinates are global screen points. <mode>:
//   before   Shift goes down while the pointer is still in the sidebar, held through the drop
//   after    Shift goes down only once the pointer has rested over the target
//   early    Shift held from the sidebar, released just before the mouse button
//   none     no Shift at all
import AppKit
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 7, let pid = Int32(a[1]), let fx = Double(a[2]), let fy = Double(a[3]), let tx = Double(a[4]), let ty = Double(a[5]) else {
  FileHandle.standardError.write("usage: realdrag <pid> <fromX> <fromY> <toX> <toY> <before|after|early|none>\n".data(using: .utf8)!)
  exit(2)
}
let mode = a[6]
let src = CGEventSource(stateID: .hidSystemState)
var shiftDown = false

func flags() -> CGEventFlags { shiftDown ? .maskShift : [] }
func mouse(_ type: CGEventType, _ x: Double, _ y: Double) {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
  e.flags = flags()
  if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: 1) }
  e.post(tap: .cghidEventTap)
}
func shift(_ down: Bool) {
  shiftDown = down
  let e = CGEvent(keyboardEventSource: src, virtualKey: 56, keyDown: down)!
  e.type = .flagsChanged
  e.flags = flags()
  e.post(tap: .cghidEventTap)
}
func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }
/** Drag from (x0,y0) to (x1,y1) in `steps` moves, `ms` apart. */
func glide(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, steps: Int, ms: Int) {
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    mouse(.leftMouseDragged, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
    pause(ms)
  }
}

NSRunningApplication(processIdentifier: pid)?.activate(options: [])
pause(600)
mouse(.mouseMoved, fx, fy)
pause(150)
mouse(.leftMouseDown, fx, fy)
pause(250)
// Start the drag inside the sidebar (small steps first: past the drag threshold slowly, as a hand does).
glide(fx, fy, fx + 6, fy + 2, steps: 6, ms: 40)
glide(fx + 6, fy + 2, fx + 40, fy + 6, steps: 10, ms: 25)
pause(150)
if mode == "before" || mode == "early" { shift(true); pause(60); glide(fx + 40, fy + 6, fx + 44, fy + 8, steps: 3, ms: 30) }
// Across to the target.
glide(fx + 44, fy + 8, tx, ty, steps: 40, ms: 16)
// Rest over the target, jiggling a little (a hand never holds perfectly still).
for i in 0..<12 { mouse(.leftMouseDragged, tx + Double(i % 3), ty + Double(i % 2)); pause(40) }
if mode == "after" {
  shift(true)
  pause(60)
  for i in 0..<15 { mouse(.leftMouseDragged, tx + Double(i % 3), ty + Double(i % 2)); pause(40) }
}
if mode == "early" { shift(false); pause(120); for i in 0..<4 { mouse(.leftMouseDragged, tx + Double(i % 2), ty); pause(40) } }
mouse(.leftMouseUp, tx, ty)
pause(150)
if shiftDown { shift(false) }
print("done \(mode)")
