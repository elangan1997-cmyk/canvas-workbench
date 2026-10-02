# Canvas Workbench · DSH 画布工作台

[简体中文](README.md) | **English**

> A local-first AI image workstation inside DeepSeek Harness — zero subscription, bring your own API: generate, edit, and deliver from your own machine, with layer-level Photoshop/Illustrator round-trip as the premium edge.

**Generate with your own API, pay no subscription** — the full 「generate → edit → deliver」 chain inside DSH: chat-generated images **land on the canvas automatically**, layout on an infinite canvas, retouch/erase/deliver as editable PSD/AI, with every file staying on your own disk. Think of it as a **zero-subscription local AI design workstation**: the core pipeline without the platform fee — your cost is your own API usage — plus two things cloud products cannot offer: **layer-level PS/AI round-trip** and **editable file delivery**.

**Latest: [`v1.9.51`](https://github.com/elangan1997-cmyk/canvas-workbench/releases/tag/v1.9.51) (docs release — bilingual README rewrite)**. Recent highlights:

- **Install channel fully fixed (1.9.42)**: market / npm installs now work out of the box (dependencies are auto-installed — no more "installed but the entry never shows up"); in-canvas **Check for Updates** upgrades in one click, even for same-day releases;
- **"Add to canvas" everywhere (1.9.43–1.9.47)**: the native thumbnail strip and the file-card "Open with" menu in the new DSH desktop both offer one-click add-to-canvas; images produced through **any channel** — including retried generations where the agent switched tools or gateways — land on the canvas automatically; stale "failed" placeholders are cleared automatically once the image arrives and never resurrect; de-duplication now verifies **bytes (md5)**, so regenerated images are never wrongly blocked;
- **Copy = original bytes (1.9.48–1.9.49)**: copying an image on the canvas yields the **original file bytes** (written to the system clipboard by the host process; macOS and Windows), not a re-rendered canvas snapshot;
- Earlier foundations: fully automatic chat-image placement (animated placeholder → in-place replacement), 13 aspect presets + ×1–×8 batch count, smart-erase masks always delivered to the model, dsh-codex auto-paired to your DSH core (works with the official 0.2.0 desktop), full Windows support merged.

---

## What is this? (You may be looking for…)

- *Local image generation / zero-subscription AI design* → bring your own API (any OpenAI-compatible endpoint; mainland-Chinese model APIs and enterprise gateways work directly), no subscription
- *Batch generation / card-drawing / multiple candidates* → count ×2/×4/×8 with per-image placeholders replaced in place
- *Aspect-ratio control: 9:16 vertical, 16:9, 21:9 cinematic* → 13 presets in the chat input area, exact crop after generation
- *DSH / DeepSeek Harness canvas plugin, infinite canvas, whiteboard, design mode* → an infinite design canvas beside your conversation
- *Retouch / edit / cutout / remove background / erase objects in DSH* → in-canvas image tools, select and go
- *Where do AI-generated images go / how to manage them* → auto-archived originals + global lookup + automatic/one-click placement
- *Image → PSD / layered export / OCR / text rebuild / vectorize in DSH* → local image toolchain
- *Photoshop / Illustrator integration, layer exchange, PS bridge* → two-way Adobe bridge
- *Material library / asset management for DSH* → local library with color labels
- *Use my own image API / domestic LLM API / enterprise gateway instead of a ChatGPT subscription* → any OpenAI-compatible endpoint
- *DSH canvas plugin · local AI design workstation · infinite canvas · auto image placement · batch generation · image editing · smart erase · background removal · PSD export · Photoshop bridge · designer workbench*

---

## 30-second tour

1. Toggle **Design Mode** above the DSH chat box — an infinite canvas appears on the right;
2. Pick an **aspect ratio** (say 9:16) and a **count** (say ×4) in the input area, then just describe the image in chat;
3. ×4 animated **"generating" placeholders** appear on the canvas, each **replaced in place** as its image completes;
4. Every original is archived to `DSH聊天生成图片/<chat>/<date>/` in the project — never lost;
5. Select an image to **edit / erase / remove background / rebuild text** — **copying yields the original file**; send it to **PS/AI** for fine-tuning and it returns **pixel-aligned**.

---

## What designers get

### 🖼 An infinite canvas beside the conversation
- One-click **Design Mode** above the input box: chat on the left, canvas on the right, draggable split.
- Canvas built on Excalidraw: whiteboard-grade layout — drag in, paste, multi-select, align, duplicate, undo/redo, PNG export; `Alt + wheel` zoom matches PS habits.
- The canvas *is* a local project file (`canvas.json` snapshot inside the project): survives crashes, travels with the project; deleting a canvas element never touches the chat originals.
- When an unbound chat starts generating, a banner in the input area asks: pick an existing project / create a canvas / add manually this time — then catches up automatically.

### 🤖 Chat images land on the canvas automatically
With Design Mode on, every generation in chat:
- **Placeholders first**: animated "generating" cards appear immediately (same animation as smart erase, follows light/dark theme), ×N badge when batching;
- **In-place replacement**: each finished image replaces its own placeholder; images from the same batch share identical dimensions — no mixed sizes;
- **Any channel counts**: not only this plugin's pipeline — images written by the agent through other tools or gateways (including successful retries after a first failure) are archived and placed automatically;
- **Failure-safe**: if replacement fails, the image is placed in the current viewport immediately with a notice; leftover "failed" placeholders are **cleared automatically** once the image lands, and deleted ones **never resurrect**;
- **Never duplicated**: de-dup matches by source path + normalized filename first, then confirms with **byte-level md5** — regenerated images with the same name pass through; the same image is never added twice;
- **Switchable**: turn auto-placement off in 「More → Image Engine Settings」 and go back to manual "Add to canvas" on the card.

### 📐 Aspect ratio & count
The ratio chip next to the Design Mode toggle in the chat input area opens a full panel:
- **13 presets**: 1:1, 3:2/2:3, 4:3/3:4, 16:9/9:16, 21:9/9:21 (cinematic), 2:1/1:2 (banner/long-form), 5:4/4:5 (photo/print) + Auto;
- **Count ×1/×2/×4/×8**: serial generation, placeholders map 1:1 to outputs — great for card-drawing;
- **Works on both engines**: the API engine maps requests to gateway-standard sizes and crops precisely afterwards; dsh-codex injects composition requirements into the prompt and crops after generation;
- **Edits respect the ratio too**: chat-initiated edits honor an explicitly chosen ratio; canvas edits and smart erase always follow the original image so nothing gets accidentally cropped.

### 📥 Generated images never get lost
- Every chat-generated image is **auto-archived** to `DSH聊天生成图片/<chat title>/<date>/<session>/`, with folder names following the chat title;
- **"Add to canvas" everywhere**: the chat image card, the **native thumbnail strip**, and the file-card **"Open with" menu** in the new DSH desktop; other attached images can join the canvas in one click too;
- **Copy = original**: copying a selected image on the canvas yields the **original bytes** (PNG written directly; JPEG/WebP converted automatically) — paste into WeChat/docs/slides with no quality loss and no white border;
- Images from past chats are found globally by filename; old references never break.

### ✏️ Edit images right on the canvas
Select an image on the canvas and, without leaving DSH:
- **Edit image**: prompt-driven edits with an optional selection (unselected areas become "keep unchanged" constraints), replaced in place;
- **Smart erase**: paint over what should go; the selection is redrawn at native resolution with matched edge tones; **the mask always reaches the model** (engines without a mask parameter get the selection baked into a visible marker — the model sees exactly what to erase); **neighbors are safe** (tightened safety margins + partially-covered adjacent text/shapes are completed from their visible parts);
- **Remove background**: one-click matting with transparency; selections auto-expand and feather; default model is **BiRefNet-lite**, cached with zero downloads, and the UI honestly reports the model actually used;
- **OCR**: full image + selection outline goes to the vision model, returning structured JSON (text/position/color/size/font/confidence);
- **Vectorize**: raster → SVG line art, print- and zoom-ready;
- **Export PSD**: layered PSD written to disk;
- Consecutive edits composite from the **original master** — repeated masks never stack or blur.

### ✍️ Text rebuild: words in an image become editable text
- After recognition, text on posters/packaging is rebuilt with **free-for-commercial fonts** (Alibaba PuHuiTi 3.0, Source Han Sans SC, Inter, …) into **editable PSD / AI / SVG** — live text, not a pasted bitmap;
- Can generate a **native Illustrator document (.ai)** that returns to the canvas automatically (Windows too, via COM);
- PSD output contains a repaired background layer + editable text layers (positioned above the clean background — toggle the "eye" to see), with position/size/color converted from original coordinates.

### 🗂 Material library
- Library sidebar beside the canvas: **Mac-style 7-color labels**, multi-select tagging, sort/filter by color/type/time/size/name;
- **Two-way drag** between canvas and library; materials live locally and are reusable across projects;
- New files in the project folder (saved from PS/AI, copied in from Finder) **refresh live** onto the canvas.

### 🔁 Two-way Photoshop / Illustrator bridge
- Click **"Get Ps layers" / "Get Ai objects"** on the canvas: pull the layers currently selected in PS/AI into the canvas (~2s; PS crops each layer to its bounds and remembers coordinates);
- Select an image and click **"→Ps" / "→Ai"**: after editing it returns by format — PSD layers merge into the current document, AI/SVG merges as objects — **pixel-aligned** (verified on PS 2025 / AI 2026);
- Transfer happens through a local-folder handshake: no ports, no network; works from CS6 through 2026;
- Windows supported too: remote drive via COM automation, custom install paths located through the registry;
- No legacy extension panel on PS 2025+? The canvas buttons and a one-click "File → Scripts" script both work. Protocol and troubleshooting: [`canvas-workbench/adobe-bridge/PROTOCOL.md`](canvas-workbench/adobe-bridge/PROTOCOL.md).

### 🧾 Operation log & updates
- 「More → Operation Log」 records project loading, file refresh, image writes, model requests, response parsing, preview conversion, PSD generation, and failure reasons — copy the steps when reporting issues; no accounts or keys included.
- 「More → **Check for Updates**」 upgrades in one click — self-update runs a full dependency resolution (and self-checks after install), so even same-day releases install immediately, bypassing the marketplace's 24-hour new-package protection.

---

## Install

### Option 1: Plugin marketplace / npm (recommended, DSH already installed)

DSH Settings → Plugins → Marketplace, search `canvas-workbench`, install; or from the CLI:

```sh
dsh plugin --profile web add canvas-workbench
```

Mainland-China networks automatically fall back to the registry.npmmirror.com mirror — no extra configuration.

Since 1.9.42, marketplace / npm installs work out of the box (dependencies auto-installed; PSD export degrades gracefully if something is missing); upgrade later with in-canvas "Check for Updates".

### Option 2: From source (latest main / development)

**macOS:**

```bash
git clone https://github.com/elangan1997-cmyk/canvas-workbench.git
cd canvas-workbench
./sync-local-plugins.sh     # sync to all local DSH profiles + health check
```

**Windows (PowerShell, or double-click `install-windows.cmd`):**

```powershell
git clone https://github.com/elangan1997-cmyk/canvas-workbench.git
cd canvas-workbench
.\install-windows.cmd            # sync + health check (quit DSH first)
.\install-windows.cmd -CheckOnly # check only
```

Fully quit and restart DSH Desktop after installing.

### Option 3: A new machine (no DSH yet)

Install DSH Desktop (DeepSeek Harness) from the official channel first, then add the canvas plugin via Option 1 — this is the recommended path today; the plugin runs on the official stable desktop (0.2.x).

The repo's legacy full installers (e.g. the [`v1.5.9` macOS](https://github.com/elangan1997-cmyk/canvas-workbench/releases/tag/v1.5.9) `macOS-Complete` DMG/PKG) are kept only as offline reinstall baselines; they bundle an older canvas — upgrade via Option 1 / "Check for Updates" afterwards.

Neither the npm package nor the source bundle ships DSH itself, Python runtimes, model files, accounts, or API keys.

---

## Image engines (bring any API)

「More → Image Engine Settings」, two freely switchable routes, locked to no vendor:

| Engine | For | Notes |
|---|---|---|
| `API` (recommended start) | **Any OpenAI-compatible image API** | Domestic LLM APIs, enterprise gateways, self-hosted services — no ChatGPT subscription needed; keys stay local (0600) |
| `dsh-codex` | Existing ChatGPT subscription | Shares OAuth and quota with the [dsh-codex](https://www.npmjs.com/package/dsh-codex) plugin; if missing, the canvas **auto-installs the latest version compatible with your DSH core** (0.2.0 stable → 0.3.2); honors dsh-codex's proxy settings, usable from mainland-China networks |

Ratio and count work on **both** engines. On top of that, the **local toolchain needs no API at all**: background removal, OCR, vectorize, PSD export, and text rebuild all run in your local Python environment — offline-capable, zero per-call cost (missing libraries bootstrap an isolated runtime automatically). Engines never switch silently; the status panel shows install/login/credential state live. Your engine/ratio/count choices **survive upgrades** (settings only fill missing fields and back up before overwriting).

---

## vs. cloud subscription platforms?

For the **core pipeline — generate → edit → deliver**, this is:

| Dimension | Cloud design agents | Canvas Workbench |
|---|---|---|
| Cost | Platform subscription + usage | Your own API by usage; local toolchain at zero API cost |
| Data | Cloud sessions | Local project files + auto-archive, nothing uploaded |
| Deliverable | Mostly flat images | **Editable PSD/AI/SVG** |
| Integration | None | **Layer-level two-way PS/AI round-trip** |
| Accountability | Black box | Project paths / model routes / failure steps inspectable locally |
| Privacy | Uploaded | Credentials and content stay local; requests sent only to the model you choose |

Out of scope today: team cloud collaboration, video/motion, template ecosystems — use a cloud platform alongside when you need those (cloud for concept drafts, local for refined delivery).

---

## Recommended workflow

1. **Draw cards**: Design Mode on → ratio 9:16, count ×4 → describe in chat → 4 placeholders fill in → circle the keepers;
2. **Organize**: lay out versions on the infinite canvas, tag with the 7-color library, new files refresh onto the canvas live;
3. **Local edits**: select the region → edit / smart erase / remove background; unselected areas untouched;
4. **Text rebuild**: frame the text → vision model returns JSON → confirm to output the repaired background + editable PSD/AI text layers;
5. **Fine-tune & deliver**: "→Ps" / "→Ai" into Adobe, return when done; originals, repaired backgrounds, layered files, and operation logs all preserved.

---

## Requirements

- DeepSeek Harness (DSH) **0.2.x stable desktop (recommended) or the 0.1.7-rc kernel line**; the new v4 session format, attachments API, and native image strip are all supported; the dsh-codex engine auto-pairs with your core — nothing to manage manually.
- Background removal / OCR / vectorize / PSD export / `.ai`/`.pdf` previews need local Python 3.11 (isolated runtimes bootstrap automatically when missing); without any Python the canvas still works — only those local tools are disabled.
- The Adobe bridge needs Photoshop / Illustrator installed; **verified on real machines for both macOS and Windows** (PS 2025 / AI 2026, see [WINDOWS-TEST-CHECKLIST](WINDOWS-TEST-CHECKLIST.md)).

## Data & privacy

Everything lives in your local project directories and under `~/.dsh`: the canvas is a project file, generated images are archived originals, the material library is a local folder. No cloud sync, no uploads, nothing in Git. Release packages contain no developer accounts, OAuth tokens, or API keys; API credentials are read only from your own machine.

---

## Docs & support

- [Windows full-install guide](windows-installer/INSTALL-WINDOWS.md) · [Windows standalone plugin](docs/DSH-CANVAS-WORKBENCH-WINDOWS.md) · [macOS standalone plugin](docs/DSH-CANVAS-WORKBENCH-MACOS.md)
- [Release, checksums & version policy](docs/RELEASE-DISTRIBUTION.md) · [npm distribution](docs/NPM-DISTRIBUTION.md) · [Windows acceptance checklist](WINDOWS-TEST-CHECKLIST.md)
- [Adobe bridge protocol](canvas-workbench/adobe-bridge/PROTOCOL.md) · [Changelog](CHANGELOG.md)

**FAQ quick reference**

| Symptom | Fix |
|---|---|
| Still on the old version after install | Fully quit DSH (tray included), rerun the installer, then `-CheckOnly`; or use in-canvas 「More → Check for Updates」 |
| Same-day release won't install | The DSH marketplace has a 24-hour new-package protection; in-canvas "Check for Updates" installs same-day versions immediately |
| Design Mode entry missing after install | Root-caused and fixed in 1.9.42 (dependencies auto-install); if it still happens, fully restart DSH and attach the operation log |
| API unreachable / timeout | Check route, endpoint, timeout in 「Image Engine Settings」; the operation log names the exact failing stage |
| dsh-codex generation fails with a request error | Confirm dsh-codex is signed in under engine settings; mainland-China networks should use its proxy settings (passed through automatically) |
| Erase produced no change | Fixed in 1.9.41 (masks now always reach the model); if you still see it, attach the operation log |
| No PDF/AI preview | The file still goes on the canvas; on macOS install Poppler or open in Illustrator; on Windows the PyMuPDF preview is built in (bootstrapped automatically) |

**Bug reports** should include: steps, OS version, plugin version, the failing operation-log step, and whether you use Codex or the API route. Never paste API keys, OAuth tokens, or personal project files.

## Repository layout

```text
canvas-workbench/          Canvas plugin source (segmented client + host services + provider)
canvas-workbench/scripts/  Build/check/package scripts + the Python image toolchain
install-canvas-plugin.sh   macOS standalone-plugin sync entry
install-windows.ps1/.cmd   Windows source installer + health check
windows-installer/         Windows full installer
docs/                      Install & release documentation
```

## Development

```bash
cd canvas-workbench
npm install
npm run build    # concat segmented sources into lib/client.js
npm run check    # syntax / build drift / vendor patch / Windows-compat guards
npm test         # node --test unit tests
npm run package:npm  # build the dist-npm/canvas-workbench release variant
```

## License

MIT
