# End-to-end tests

Drive the real engine with injected button presses and moves and a real foreground window (a small
WinForms text box), then check what happened.

- `e2e.js`: auto-switching, key/macro mappings, loop / held / toggle macros, live events, left-click rule (15 checks)
- `movement.js`: DPI stages, X/Y, ratio, rotation, angle snap, DPI actions, telemetry, scroll reverse/smooth,
  pause, pointer-settings restore, Shift layer (29 checks)

The engine only accepts injected input when started in test mode. It replaces your saved config while
running, so back up `%APPDATA%\Kinetic\config.json` first and restore it afterwards. The tests move the
real cursor a few pixels and put it back, and a test window opens for a few seconds and takes focus.

    cd engine && cargo build
    $env:KINETIC_TEST_MODE = '1'; Start-Process target\debug\kinetic-engine.exe -WindowStyle Hidden; Remove-Item Env:KINETIC_TEST_MODE
    node tests\e2e\e2e.js
    node tests\e2e\movement.js

Stop the test engine afterwards and start a normal one.
