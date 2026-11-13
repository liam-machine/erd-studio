// REPRO helper (reporter-feedback-3, Shift-drop probe): a REAL macOS drag from a
// Table Library row to a point on the canvas, with the Shift key pressed in a
// chosen pattern. Posts HID events, so it MOVES THE REAL POINTER: run it only
// against a scripted VS Code window (reporter3-dragprobe.mjs).
//
//   swiftc -O realdrag2.swift -o /tmp/g3-realdrag2
//   /tmp/g3-realdrag2 <pid> <fromX> <fromY> <toX> <toY> <mode>
//
// Every phase is printed as a JSON line {"t": <epoch ms>, "phase": ...} so the
// probe can line it up with the drag events each frame saw (same clock).
//
// <mode> (what a person might do):
//   before         Shift down in the sidebar, held across and through the drop; small jiggle over the target
//   before-still   Shift down in the sidebar, held; pointer perfectly still over the target for 700 ms, then release
//   after          over the target, then Shift, then small jiggle (1-2 px) for 600 ms, release
//   after-still    over the target, then Shift, pointer perfectly still for 700 ms, release
//   after-wiggle   over the target, then Shift, larger wiggle (±12 px) for 900 ms, release
//   after-out-in   over the target, then Shift, out to the editor tab bar and back in, release
//   early          Shift held from the sidebar, released 300 ms before the mouse button
//   none           no Shift at all
//   recover        no drag: move over the target, then click it (what a person does after a lost drop)
//   glass-still    no Shift (a glass sidebar drag); release, then the pointer perfectly still for 3 s, then a small move
//   glass-move     no Shift; release, then small moves straight away (a hand moving on), then still
import AppKit
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 7, let pid = Int32(a[1]), let fx = Double(a[2]), let fy = Double(a[3]), let tx = Double(a[4]), let ty = Double(a[5]) else {
  FileHandle.standardError.write("usage: realdrag2 <pid> <fromX> <fromY> <toX> <toY> <mode>\n".data(using: .utf8)!)
  exit(2)
}
let mode = a[6]
let src = CGEventSource(stateID: .hidSystemState)
var shiftDown = false
var lastX = 0.0, lastY = 0.0

func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
func log(_ phase: String) {
  let shiftOS = CGEventSource.flagsState(.combinedSessionState).contains(.maskShift)
  print("{\"t\":\(now()),\"phase\":\"\(phase)\",\"osShift\":\(shiftOS)}")
  fflush(stdout)
}
func flags() -> CGEventFlags { shiftDown ? .maskShift : [] }
func mouse(_ type: CGEventType, _ x: Double, _ y: Double) {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
  e.flags = flags()
  if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: 1) }
  // A real mouse reports how far it moved; Chromium reads movementX/Y from these.
  e.setIntegerValueField(.mouseEventDeltaX, value: Int64((x - lastX).rounded()))
  e.setIntegerValueField(.mouseEventDeltaY, value: Int64((y - lastY).rounded()))
  lastX = x; lastY = y
  e.post(tap: .cghidEventTap)
}
func shift(_ down: Bool) {
  shiftDown = down
  let e = CGEvent(keyboardEventSource: src, virtualKey: 56, keyDown: down)!
  e.type = .flagsChanged
  e.flags = flags()
  e.post(tap: .cghidEventTap)
  usleep(20_000)
  log(down ? "shift-down" : "shift-up")
}
func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }
func glide(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, steps: Int, ms: Int) {
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    mouse(.leftMouseDragged, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
    pause(ms)
  }
}
func jiggle(_ n: Int, amp: Double, ms: Int) {
  for i in 0..<n {
    let dx = amp <= 2 ? Double(i % 3) : amp * sin(Double(i) * 0.9)
    let dy = amp <= 2 ? Double(i % 2) : amp * cos(Double(i) * 0.7)
    mouse(.leftMouseDragged, tx + dx, ty + dy)
    pause(ms)
  }
}

NSRunningApplication(processIdentifier: pid)?.activate(options: [])
pause(600)
if mode == "recover" {
  // After a lost drop: what a person does next. Move about over the target, then click it.
  lastX = tx; lastY = ty
  for i in 1...10 { mouse(.mouseMoved, tx + Double(i * 3), ty + Double(i)); pause(40) }
  log("moved")
  pause(1200)
  mouse(.leftMouseDown, tx + 30, ty + 10); pause(80); mouse(.leftMouseUp, tx + 30, ty + 10)
  log("clicked")
  pause(600)
  for i in 1...6 { mouse(.mouseMoved, tx + 30 + Double(i * 2), ty + 10 + Double(i)); pause(40) }
  log("moved-after-click")
  exit(0)
}
lastX = fx; lastY = fy
mouse(.mouseMoved, fx, fy)
pause(150)
log("mouse-down")
mouse(.leftMouseDown, fx, fy)
pause(250)
glide(fx, fy, fx + 6, fy + 2, steps: 6, ms: 40)
glide(fx + 6, fy + 2, fx + 40, fy + 6, steps: 10, ms: 25)
log("dragging-in-sidebar")
pause(150)
if mode.hasPrefix("before") || mode == "early" { shift(true); pause(60); glide(fx + 40, fy + 6, fx + 44, fy + 8, steps: 3, ms: 30) }
glide(fx + 44, fy + 8, tx, ty, steps: 40, ms: 16)
log("over-target")
switch mode {
case "before-still":
  pause(700)
case "after":
  jiggle(12, amp: 1, ms: 40); shift(true); pause(60); jiggle(15, amp: 1, ms: 40)
case "after-still":
  jiggle(12, amp: 1, ms: 40); mouse(.leftMouseDragged, tx, ty); pause(80); shift(true); pause(700)
case "after-wiggle":
  jiggle(12, amp: 1, ms: 40); shift(true); pause(60); jiggle(22, amp: 12, ms: 40)
case "after-out-in":
  jiggle(12, amp: 1, ms: 40); shift(true); pause(60)
  glide(tx, ty, tx, ty - 260, steps: 12, ms: 20); log("out"); pause(120)
  glide(tx, ty - 260, tx, ty, steps: 12, ms: 20); log("back-in"); jiggle(8, amp: 1, ms: 40)
case "early":
  jiggle(12, amp: 1, ms: 40); shift(false); pause(120); for i in 0..<4 { mouse(.leftMouseDragged, tx + Double(i % 2), ty); pause(40) }
default:
  jiggle(12, amp: 1, ms: 40)
}
if !mode.hasSuffix("-still") || mode.hasPrefix("glass-") { mouse(.leftMouseDragged, tx, ty) }
log("mouse-up")
mouse(.leftMouseUp, tx, ty)
if mode == "glass-still" {
  // Let go and hold perfectly still: does anything land without a move?
  pause(3000)
  log("still-end")
  for i in 1...6 { mouse(.mouseMoved, tx + Double(i * 2), ty + Double(i)); pause(30) }
  log("moved-after-still")
  pause(2500)
  log("done")
  exit(0)
}
if mode == "glass-move" {
  // Let go and move on at once, as a hand does.
  for i in 1...10 { mouse(.mouseMoved, tx + Double(i * 2), ty + Double(i)); pause(16) }
  log("moved-after")
  pause(3000)
  log("done")
  exit(0)
}
pause(150)
if shiftDown { shift(false) }
// A hand moves on after letting go: a few small moves from the drop point.
pause(400)
for i in 1...6 { mouse(.mouseMoved, tx + Double(i * 2), ty + Double(i)); pause(30) }
log("moved-after")
// ... and on: a second little movement a moment later (a refused drop's image slides back first).
pause(900)
for i in 1...6 { mouse(.mouseMoved, tx + 12 + Double(i * 2), ty + 6 + Double(i)); pause(30) }
log("moved-again")
// ... and again a couple of seconds on (a drop Chromium lost can leave the window deaf to the mouse for a while).
pause(1800)
for i in 1...6 { mouse(.mouseMoved, tx + 24 + Double(i * 2), ty + 12 + Double(i)); pause(30) }
log("moved-later")
log("done")
