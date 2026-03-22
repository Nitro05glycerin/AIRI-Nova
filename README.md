# AIRI Nova — Customized Fork

![Nova Screenshot](Nova-screenshot.png)

A customized fork of [AIRI](https://github.com/moeru-ai/airi) with personality-driven Live2D companion features, built for self-hosting on a Hetzner server via Tailscale.

This build is specifically made for the [bear Pajama Extended Version](https://kyoki.booth.pm/items/6333409) Live2D model by kyokiStudio. The model file is included in this repo for convenience — see [Setup](#setup) for how to import it.

## What's Changed

### Live2D Expressions & Items
- Emotion expression mapping for the bear Pajama model (happy, sad, angry, surprised, curious, awkward)
- Item/accessory toggle system — the model can pick up and put down glasses, hat, plushie, game controller, coat, sweater, earphones, snacks, and more
- Emotions and items are triggered by the LLM using special tokens (`<|ACT|>` and `<|ITEM|>`)

### Voice & Speech
- TTS text filtering — action descriptions wrapped in `*asterisks*` or `<action>` tags are stripped before speech synthesis
- ElevenLabs voice settings (stability, similarity boost, speed) now persist correctly across page visits
- Voice settings no longer revert to defaults when testing in the playground

### Speech Recognition
- VAD (Voice Activity Detection) tuned for natural conversation — longer silence threshold before cutoff, less aggressive exit detection
- Microphone permission auto-request on page load so device selection works immediately

### Config Sync
- Merge-based sync server — multiple browsers can share settings without overwriting each other
- Cards merge by ID (union), other settings use per-key timestamps (newer wins)
- Per-key change tracking via `localStorage.setItem` interception
- Position and scale excluded from sync (device-specific)

### Self-Hosting
- `serve-unified.py` — serves the SPA and proxies API, ElevenLabs, sync, and unspeech endpoints
- `sync-server.py` — lightweight config sync with merge logic
- Server auth requirements made optional for local/self-hosted setups

## Setup

### Prerequisites
- A Linux server (this runs on Hetzner)
- [Tailscale](https://tailscale.com/) installed on both the server and your device
- Node.js and pnpm

### Installation

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/Nitro05glycerin/AIRI-Nova.git
   cd AIRI-Nova
   npx pnpm install
   ```

2. Build the frontend:
   ```bash
   npx pnpm build:web
   ```

3. Start the servers:
   ```bash
   python3 sync-server.py &
   python3 serve-unified.py 3030 &
   ```

### Importing the Live2D Model

The model file (`bear_Pajama_Extended_Version.zip`) is included in the root of this repo.

1. Open AIRI in your browser
2. Go to **Settings > Display Model**
3. Import the zip file from this repo
4. Select the bear Pajama model

### Accessing AIRI

1. Make sure Tailscale is installed and running on your device
2. Connect to the same Tailscale network as the Hetzner server
3. Open https://ubuntu-8gb-nbg1-1.tailc2d5a7.ts.net:8443/ in your browser

## Credits

- Based on [AIRI](https://github.com/moeru-ai/airi) by Moeru AI
- Live2D model: [bear Pajama Extended Version](https://kyoki.booth.pm/items/6333409) by kyokiStudio
- Customizations by Nitro, with assistance from Claude
