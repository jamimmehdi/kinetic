# Kinetic

Universal mouse control for Windows. Design: the "V3 Calm" screens (dark and light) on the design board.

- `engine/`: Rust process. Raw Input detection, low-level hook (remaps, wheel), software movement
  (DPI stages, X/Y, acceleration curves, rotation, angle snapping, smoothing), macros, per-app
  profiles, Shift layer, learn-a-button, polling-rate measurement. Talks to the UI over the named
  pipe `\\.\pipe\kinetic-engine` (one JSON object per line).
- `app/`: Electron + React + TypeScript UI, tray icon, start-with-Windows, installer.

## Run (development)

    cd engine && cargo run          # terminal 1
    cd app && npm install && npm run dev   # terminal 2

Open `http://localhost:5173` in a plain browser to develop the UI without the engine (a mock engine
answers; keys 1 to 6 act as mouse buttons, hold M to fake movement).

## Package

    cd engine && cargo build --release
    cd app && npm run pack     # unpacked app in app/release/win-unpacked (engine bundled)
    cd app && npm run dist     # NSIS installer

The app starts the bundled engine itself and keeps it running in the tray.

## Tests

    cd engine && cargo test                  # 46 unit tests
    cd app && npm run typecheck && npm run test:parity   # UI curve math matches the engine
    tests/e2e                                 # drives the real engine, see tests/e2e/README.md

## What works on any mouse and what needs a device driver

See Settings in the app. Hardware DPI, polling-rate change, lift-off distance, motion sync and
on-board profiles need a per-brand HID protocol and are shown as locked until a module for that
mouse exists. Everything else is software and works on every mouse.

## Safety rules built in

- Left click can never be remapped.
- Movement is only swallowed after the first raw movement has been seen.
- Windows pointer settings are changed for the session only and restored on exit (and on the next
  start after a crash).
- Injected input is ignored except in test mode (`KINETIC_TEST_MODE=1`).

## Releasing updates

The app checks for new versions itself (Settings → Updates) once it is installed.

1. Bump `version` in `app/package.json`.
2. Build the installer: `cd app && npm run dist` (builds the engine first: `cd engine && cargo build --release`).
3. Upload everything in `app/release/` that matches `Kinetic Setup *.exe`, its `.blockmap`, and `latest.yml` to your release location.
4. Tell the app where that is, in `app/package.json`:
   - GitHub releases: `"kinetic": { "updates": { "provider": "github", "owner": "you", "repo": "kinetic" } }`
   - Any HTTPS folder: `"kinetic": { "updates": { "provider": "generic", "url": "https://example.com/kinetic/" } }`
   Also set `build.publish` to the same place so `latest.yml` points at it.

Until `kinetic.updates` is set, Settings shows "no update source yet". Updates never install without the user clicking *Restart and update*.
The installer is unsigned, so Windows SmartScreen will warn on first install; sign it to remove the warning.

## Mouse support requests

Kinetic reads the real DPI, polling rate and battery from a mouse only when it knows that brand's protocol (Razer today).
Every other mouse still gets remapping, acceleration, DPI-stage emulation, and DPI measurement/calibration.

If your mouse isn't covered: **Settings → Request support**. The app builds a report (VID/PID, HID layout, the signal your
DPI button sends, your measured DPI stages) and opens a prefilled GitHub issue. You review it and press Submit.
Maintainers use the report to add the protocol, and it ships through the in-app updater.

Set the repository the button opens in `app/package.json` under `kinetic.repo`.

## License

MIT. See [LICENSE](LICENSE).
