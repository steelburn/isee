---
version: alpha
name: isee — daylight watch desk
description: >-
  Operations console for a local camera fleet. Bright paper chrome frames dark
  live video, so the feeds are the only dark material on screen. Recording
  instruments, not a dashboard template.

colors:
  paper: "#F3F1EC"
  surface: "#FBFAF7"
  raise: "#FFFFFF"
  sunken: "#E9E6DF"
  rule: "#D9D5CB"
  rule-strong: "#BFB9AC"
  ink: "#171A17"
  ink-2: "#3E433D"
  ink-3: "#545A53"
  accent: "#12574B"
  accent-ink: "#0B3B33"
  accent-soft: "#E3EDEA"
  live: "#8A2118"
  live-soft: "#F7E4E1"
  warn: "#6B4A0D"
  warn-soft: "#F6EBD6"
  stage: "#000000"

typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontWeight: 400
    lineHeight: 1.55
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontWeight: 400
    lineHeight: 1.4

rounded:
  r1: 3px
  r2: 6px
  r3: 10px
  pill: 999px

spacing:
  s1: 4px
  s2: 8px
  s3: 12px
  s4: 16px
  s5: 24px
  s6: 32px
  s7: 48px
  s8: 64px
  s9: 96px

components:
  button-primary:
    background: accent
    foreground: raise
    radius: r2
  nav-item-selected:
    background: accent-soft
    foreground: accent-ink
    radius: r2
  panel:
    background: surface
    border: rule
    radius: r2
    elevation: none
---

# isee — daylight watch desk

## Overview
isee watches cameras and remembers what it saw. The interface has one job: let an
operator confirm, at a glance, that every camera is live and that what the models
report matches what the camera actually shows. Anything that competes with the
video is decoration.

The surface is **daylight**: warm paper chrome around genuinely dark video. Real
NVR consoles do this because video is already dark; a bright shell makes each feed
read as a window rather than a tile in a dark grid. The page itself is never dark.

**Direction:** a daylight watch desk. Recording instruments — timecode, frame
counts, confidence to two decimals, device IDs — not a marketing dashboard.

## Colors
Paper `#F3F1EC` is the page. Surfaces are a half-step lighter `#FBFAF7` with a
hairline `#D9D5CB` — separation comes from space, then surface, then rule, in that
order. Panels cast no shadow; `e1` is reserved for things that actually float
(popover triggers, slider thumbs). Ink is a green-black `#171A17` on paper,
never `#000`. The ink ramp is `#171A17` / `#3E433D` / `#545A53`, and every step
clears APCA Lc 75 at the size it is used — the quiet third step included.

**Accent is pine `#12574B`** — saturated, dark, deliberate, and used only for
primary actions, selection, and the small marks that identify isee. It is not
decoration and never fills a large area.

**Signal red `#8A2118` is semantic only:** a camera is recording / a face is
unrecognised. It never becomes a button colour and never appears twice in one
viewport. Amber `#6B4A0D` means degraded (camera retrying, model unavailable).

Stage `#000000` is not a page background. It exists only behind video and in the
letterbox around a feed, so frames sit in a true black window the way a monitor
does in a lit room.

## Typography
IBM Plex Sans for interface, **IBM Plex Mono for every number that a human might
compare to another number**: timecode, timestamps, confidences, resolution, frame
rates, device IDs, camera counts. Mono is information, not a costume — prose is
always Plex Sans.

Scale is modular from a 15px body: 12 / 13 / 15 / 19 / 24 / 30 / 37 / 46, with
display sizes via `clamp()`. Body is 15px/1.55 at 60–75ch. Numbers in tables use
`font-variant-numeric: tabular-nums`.

## Layout
Fixed left rail (208px) + content. Content max-width 1440px, gutters 32px,
8px spacing rhythm. The live wall is a 12-column grid: the focused feed spans 8,
the camera list spans 4. At ≤1100px the wall stacks; at ≤760px the rail becomes a
bottom bar.

Density is deliberate: instrument rows are 44px, list rows 64px, gallery cards
integer-aligned. Nothing floats.

## Elevation
Three named levels. Nothing else casts a shadow.
- `e1` — controls that float (slider thumb, active segment)
- `e2` — popover / dropdown / toast (`0 4px 12px -2px`)
- `e3` — modal (`0 18px 40px -12px`)

A panel does not hover. A menu is nearer than a panel. That ordering holds
regardless of which component was edited last.

## Shapes
Crisp, not soft: 3px on inputs and small controls, 6px on panels and buttons,
10px on modals. Pills (999px) are reserved for status. No rounded-2xl cards; no
one-radius-for-everything.

## Components
- **Rail:** wordmark, nav, live fleet status. Selected nav item is `accent-soft`
  with `accent-ink` text and a 2px pine bar on the inline start edge.
- **Video panel:** 16:9 stage, corner frame ticks, camera name + source + live
  lamp in a footer bar. Overlay canvas draws detection boxes in accent (objects)
  and signal red (unrecognised faces) / accent (recognised faces).
- **Marked region:** drag on the stage to draw a box; the feed is never covered.
  The answer arrives in a band between the stage and the stats row — crop
  thumbnail, label, confidence, name — and can name an unknown face in place.
  When the 80-class detector has no word for what was marked, CLIP answers from
  the operator's vocabulary; when the region is text, OCR reads it and shows the
  read with its confidence, never as if it were certain.
- **Detection readout:** mono rows, label left, confidence right-aligned.
- **Person card:** square face thumb, name, sample count, match threshold state.
- **Event row:** 96px thumbnail, kind chip, label, camera, mono timestamp.
- **Buttons:** primary (pine fill), secondary (surface + rule), ghost (text),
  danger (signal red text + rule). All declare hover, focus-visible, active,
  disabled.
- **Acquisition panel** (add camera): the wire is inspected before a channel is
  patched in. A scan list of network devices (mono host, kind, port, status
  chip) collapses to the one chosen row once picked; the spec form separates
  host / credentials / channel instead of hiding them inside a URL; the line
  under it shows the exact source that will be stored, password masked. The
  probe stage is a 168 px 16:9 stage-tick window: black with NO FRAME until a
  real frame arrives, then the frame itself. Failure is typed, not generic —
  `credentials refused` is signal red (and says so about lockout), everything
  else is amber. It is the one wide dialog: 720 px instead of 560.

## States
Every interactive element ships `:hover`, `:focus-visible` (2px pine ring,
2px offset), `:active`, `:disabled`. Every async surface ships empty, loading
(skeleton shimmer), and error (inline, with a retry action). Motion respects
`prefers-reduced-motion`; the live lamp pulse stops entirely.

## Do's and Don'ts
- Do let the video be the loudest thing on screen.
- Do put the number in mono, right-aligned, tabular.
- Do use whitespace before a border.
- Don't add a second accent, a glow, a gradient orb, or a glassy panel.
- Don't tint near-black as a page colour — the page is paper.
- Don't append arrows to buttons or tracked-out ALL-CAPS eyebrows to headings.
- Don't ship a card unless it is one object; repeated objects are rows.
