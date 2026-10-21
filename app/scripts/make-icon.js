// Renders assets/icon.png (256x256): the app logo, a white mouse on the accent blue.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="58" fill="#3b6fe0"/>
  <g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 40) scale(6.67)">
    <rect x="6" y="3" width="12" height="18" rx="6" transform="translate(0 0)"/><path d="M12 3v7"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true });
  await win.loadURL("data:text/html," + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`));
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.join(__dirname, "..", "assets"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "assets", "icon.png"), image.toPNG());
  app.quit();
});
