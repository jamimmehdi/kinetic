import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { activeCrosshair, DEFAULT_STATE, OVERLAY_SIZE, type CrosshairState } from "./crosshair";
import { CrosshairView } from "./CrosshairView";

// The page inside the transparent, click-through window that sits over the game.
function Overlay() {
  const [state, setState] = useState<CrosshairState>(DEFAULT_STATE);
  useEffect(() => {
    const bridge = window.kinetic?.crosshair;
    if (!bridge) return;
    bridge.get().then(setState).catch(() => {});
    return bridge.onState(setState);
  }, []);
  return <CrosshairView c={activeCrosshair(state)} size={OVERLAY_SIZE} />;
}

createRoot(document.getElementById("root")!).render(<Overlay />);
