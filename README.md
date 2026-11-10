# isee

A local camera watch desk. It captures USB webcams and IP cameras, runs object
detection and face recognition on every frame, keeps an event log — and exposes
the whole thing as an **MCP server**, so an agent can watch the same cameras the
browser shows.

```
Browser ──(MJPEG + SSE)──────┐
                             ├── Express ── YOLOv10n   (objects)
MCP client ──(POST /mcp)─────┤           ── SCRFD      (faces)
                             │           ── ArcFace    (identity)
USB webcam / RTSP ──ffmpeg───┘
```

## Run it

```bash
npm install          # one-time
npm start            # http://127.0.0.1:7373
```

On first start isee enumerates local capture devices and registers the first
webcam automatically. The models load in the background (~0.6 s) and detection
begins as soon as the first frame arrives.

Requires Node 22.5+ (uses the built-in `node:sqlite`). No Python, no OpenCV.

### Models

`models/` holds three ONNX files, downloaded once:

| File | Purpose | Source |
|---|---|---|
| `yolov10n.onnx` (9 MB) | 80-class COCO object detection, NMS-free | `onnx-community/yolov10n` |
| `face_det.onnx` (17 MB) | SCRFD 10g face detection + 5 keypoints | `immich-app/buffalo_l` |
| `face_rec.onnx` (167 MB) | ArcFace w600k_r50, 512-d embeddings | `immich-app/buffalo_l` |
| `clip_vision_quantized.onnx` (85 MB) | open-vocabulary image encoder | `Xenova/clip-vit-base-patch32` |
| `clip_text_quantized.onnx` (62 MB) | matches images against your words | `Xenova/clip-vit-base-patch32` |
| `clip_tokenizer.json` | CLIP byte-level BPE | `Xenova/clip-vit-base-patch32` |
| `ppocr_det.onnx` (4.6 MB) | PP-OCRv4 DB text detection | `SWHL/RapidOCR` |
| `ppocr_rec.onnx` (11 MB) | PP-OCRv4 CTC line recognition | `SWHL/RapidOCR` |
| `ppocr_keys.txt` | recognition charset | `PaddlePaddle/PaddleOCR` |

They are not committed (see `.gitignore`). Re-fetch with:

```bash
mkdir -p models
curl -L -o models/yolov10n.onnx  https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx
curl -L -o models/face_det.onnx  https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx
curl -L -o models/face_rec.onnx  https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx
curl -L -o models/clip_vision_quantized.onnx https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx
curl -L -o models/clip_text_quantized.onnx   https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model_quantized.onnx
curl -L -o models/clip_tokenizer.json        https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json
curl -L -o models/ppocr_det.onnx https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx
curl -L -o models/ppocr_rec.onnx https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx
curl -L -o models/ppocr_keys.txt https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt
```

## Using it as MCP

The endpoint is `http://127.0.0.1:7373/mcp` (streamable HTTP, stateless — one
request, one response, no session to maintain).

Claude Code / any MCP client with a JSON config:

```json
{
  "mcpServers": {
    "isee": {
      "type": "http",
      "url": "http://127.0.0.1:7373/mcp"
    }
  }
}
```

### Tools

| Tool | Returns |
|---|---|
| `isee_status` | models, camera health, gallery size, settings |
| `list_devices` | USB webcams attached to this machine |
| `list_cameras` | fleet with status, fps and last detections |
| `add_camera` / `update_camera` / `remove_camera` | manage the fleet |
| `capture_frame` | the current frame as a JPEG — annotated with boxes when `annotate: true` |
| `identify_objects` | COCO labels, confidences, normalised boxes |
| `recognize_faces` | names, cosine similarity, boxes |
| `identify_region` | what is inside a marked `[x,y,w,h]` box — objects, faces, cropped image |
| `read_text` | OCR a region or the whole frame |
| `enroll_person` | add a person from a live camera or an image |
| `add_face_sample` | another angle for an existing person |
| `list_people` / `delete_person` | the face gallery |
| `query_events` | search the event log by camera, kind, label, time |
| `update_settings` | confidence and match thresholds |

Everything is scoped to this machine. Nothing leaves it.

## HTTP API

The browser uses the same endpoints a script would:

```
GET    /api/state                    everything the UI needs in one call
GET    /api/cameras                  fleet + live status
POST   /api/cameras                  { name, kind, source, detectFps }
                                     — or { name, preset, host, port, user,
                                       password, channel, quality }: the server
                                       builds the source, so credentials always
                                       land in the right place for that firmware
POST   /api/cameras/probe            { …same spec } — one frame, no camera added
GET    /api/discover                 cameras + devices on this subnet (2 min cache)
PATCH  /api/cameras/:id              { name, enabled, detectFps, size }
DELETE /api/cameras/:id
GET    /api/cameras/:id/frame.jpg    latest frame
GET    /api/cameras/:id/analyse      fresh detection on the current frame
POST   /api/cameras/:id/inspect      { box:[x,y,w,h] } — identify a marked region
GET    /api/devices                  enumerate local capture devices
GET    /api/people                   gallery with face samples
POST   /api/people                   { name, cameraId | image }
POST   /api/people/:id/samples       add an angle
DELETE /api/people/:id
GET    /api/events                   ?cameraId&kind&label&since&limit
GET    /api/settings  PATCH /api/settings
GET    /api/stream                   SSE: detection, camera, event
GET    /stream/:id.mjpg              multipart live video
POST   /mcp                          MCP (streamable HTTP)
```

## Where the detector stops — and what covers the gap

YOLOv10 knows **80 COCO classes**. There is no `pen`, no `marker`, no `sharpie`,
and nothing called `text`. So a Sharpie gets reported as the nearest thing in the
list — usually `toothbrush` — and printing gets reported as nothing at all. That
is not a tuning problem; the vocabulary is missing.

**1. CLIP re-scores uncertain detections.** Below 0.65 confidence the crop is
compared against your vocabulary (Settings → Recognition) and the label changes
only when another word wins by a clear margin. Person boxes, and any crop a face
sits in, are never re-labelled — identity belongs to the face pipeline.

**2. CLIP answers for marked regions.** Marking something the detector does not
recognise at all returns the best vocabulary match, so pointing at a pen gives
`pen` even though no detector ever fired.

**3. OCR reads text.** Text is not an object class, so the region is read rather
than classified. PP-OCRv4 (PaddleOCR) is the engine; tesseract is the fallback
when its models are absent or the read is too weak to trust.

Measured on the two labels in the reference scene (1920×1080, 5 runs each,
character error rate after dropping case and punctuation). Reproduce with
`npm run bench:ocr`:

| string | tesseract | PP-OCRv4 |
|---|---|---|
| `SEOKO` (stylised logo, 28 px tall) | nothing — CER 100% | `SEOCO`, 67% conf, CER 20% |
| `TIER STORAGE CABINET` (angled print, ~35 px) | nothing — CER 100% | **character-perfect**, 99% conf, CER 0% |

The carton line is read exactly because detection fits an oriented rectangle
(second moments over each component) and the crop is warped level before
recognition — an axis-aligned box around a 9° slope is mostly background, and
that is what used to cost the first characters.

The logo still misses: its `K` is a graphic glyph and reads as `C`. Word spaces
are recovered from CTC timing only when the gap is a clear outlier against the
line's own letter rhythm — conservative on purpose, since a false split corrupts
a word while a missing space does not.

Known limits: rotations beyond ±45° fall back to an upright crop; a mixed
Latin/CJK read is treated as noise (the model carries a Chinese charset and will
otherwise emit a CJK glyph for a blob that is really a letter).

Editing the vocabulary is the highest-leverage knob: add the words you actually
care about — `a sharpie`, `a mug`, `a package` — one per line.

## Marking something to identify

Drag a box on any live feed. isee crops that region, runs detection on the whole
frame, filters what falls inside your box, and — if nothing matched — re-runs
object detection on the crop alone so small or distant things are still caught.
The result appears in a band directly under the video: what it is, how sure the
model is, and either the recognised person or an offer to name the unknown face.

Clicking without dragging clears the mark. The same operation is available to
agents as `identify_region`.

## Cameras

**USB webcam** — captured server-side with ffmpeg (`dshow` on Windows, `v4l2` on
Linux, `avfoundation` on macOS). Capture keeps running when the browser is
closed, so MCP tools always have a live frame.

**CCTV / IP camera** — `rtsp://` (many NVRs also expose `rtmp://` or an MJPEG
`http://` URL). isee transcodes to MJPEG at 15 fps for the wall and feeds the
same frames to the detectors.

Each camera retries with exponential backoff, falls back to the device's default
resolution if the requested size is rejected, and restarts itself if the stream
stalls. Owners of the device are exclusive: close other apps that use the webcam.

### Finding cameras on the LAN

**In the console** the same discovery runs behind *Add camera → Network stream*:
the dialog lists every device that answered (host, model, port, in-use marker),
and picking a row fills the form. Credentials are separate fields, so nobody
percent-encodes a password into a URL; the line under the form shows the exact
source that will be stored, masked. **Test address** asks the camera for one
frame — the answer arrives as a picture with its resolution and latency, or as
`credentials refused` (401, with a lockout warning) versus "no stream" for
everything else. Nothing is committed until you have seen a frame.

```bash
npm run scan                                   # this machine's /24, from a shell
node tools/scan-network.js --cidr 10.0.0.0/24 --full --json report.json
```

Ping sweep + ARP first (it finds devices that answer ICMP and nothing else), then
ONVIF WS-Discovery multicast *and* unicast to every live host, then mDNS for
`_rtsp`/`_onvif`/`_nvr`, then a camera-port TCP sweep with a longer timeout on
RTSP and DVR-private ports. Anything that answers is fingerprinted through raw
HTTP (embedded servers often emit a malformed status line Node's client refuses),
vendor-matched by OUI, and probed with RTSP DESCRIBE against the classic stream
paths so `OPEN` and `AUTH` are told apart.

It is read-only and does not guess passwords: a 401 is reported as
reachable-but-locked, with the paths to try once you have the credentials.

## How recognition works

1. **Objects** — YOLOv10n, letterboxed to 640×640, NMS-free output `[1,300,6]`,
   boxes mapped back to frame coordinates.
2. **Faces** — SCRFD 10g over a stretched 640×640 input; 3 strides × 2 anchors,
   decoded to boxes + 5 keypoints, then NMS at IoU 0.4.
3. **Identity** — the 5 keypoints are aligned to the standard ArcFace template
   with a least-squares similarity transform (bilinear warp to 112×112, done in
   JS). The 512-d embedding is L2-normalised; a face is matched when cosine
   similarity to the nearest gallery entry clears the threshold (default 0.42).

Events are written with a per-camera, per-label cooldown (default 60 s) so a
stationary chair does not fill the log. Detection runs at 2 fps per camera by
default — enough for someone walking through, cheap enough for a laptop CPU.

## Presets and stream paths

`buildSource` (`src/probe.js`) owns the one place a source string is built, so
the form, the probe and the stored camera can never disagree:

| preset | path |
|---|---|
| Dahua / NVR | `/cam/realmonitor?channel=N&subtype=S` (main `0`, sub `1`) |
| XMeye / NETSurveillance | `/user=…&password=…&channel=N&stream=S.sdp?` — credentials in the path, where these DVRs expect them |
| Hikvision | `/Streaming/Channels/N01` main, `N02` sub |
| ONVIF / generic | `/`, then `/stream1`, `/live`, `/onvif1`, `/axis-media/media.amp` |
| MJPEG / full URL | used verbatim |

`Detect automatically` walks those shapes in order and stops at the first frame.
A **401 stops the walk immediately** — the password is wrong for every path, and
each further attempt spends one of the five tries most DVRs allow before they
freeze the account.

## Project layout

```
src/
  server.js            HTTP, SSE, MJPEG, static, MCP mount
  mcp.js               MCP tools
  pipeline.js          capture → detect → track → log → broadcast
  detect/vision.js     ONNX models, letterboxing, SCRFD decode, ArcFace align
  capture/camera.js    ffmpeg supervisor per camera, MJPEG frame splitting
  probe.js             source builder + one-frame probe (camera presets)
  discovery.js         LAN scan behind the add-camera list
  render.js            annotated proof frames
  db.js                node:sqlite schema + queries
public/
  index.html app.css app.js    the console (no build step, no framework)
DESIGN.md              the design system the UI is written against
data/                  isee.db, shots/ (created at runtime)
```

## Tuning

Settings → Detection, or `update_settings` over MCP:

- **Object confidence** (0.45) — lower finds more, and more noise.
- **Face detection confidence** (0.50) — box threshold.
- **Identity match threshold** (0.42) — above 0.45 is strict, below 0.35 is loose.
- **Event cooldown** (60 s) — quiet period per camera and label.

If a known face is reported as unknown, add another sample rather than lowering
the threshold — a second angle helps more than a looser match.
