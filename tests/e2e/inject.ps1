param([string]$Steps)
# Steps, comma separated: x1d x1u x2d x2u rd ru  (button press/release), waitNNN, mv<dx>_<dy> (relative move),
# wheel<delta>, pos (prints cursor x,y), setpos<x>_<y>, spi (prints mouse accel flag, speed, scroll lines).
# Input carries the engine's test marker so a test-mode engine accepts it.
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint fl, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, int[] c, uint d);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref int c, uint d);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$marker = [UIntPtr]::new([uint64]1263095380)
foreach ($s in $Steps.Split(",")) {
  switch -Regex ($s) {
    '^x1d$' { [M]::mouse_event(0x80, 0, 0, 1, $marker) }
    '^x1u$' { [M]::mouse_event(0x100, 0, 0, 1, $marker) }
    '^x2d$' { [M]::mouse_event(0x80, 0, 0, 2, $marker) }
    '^x2u$' { [M]::mouse_event(0x100, 0, 0, 2, $marker) }
    '^rd$'  { [M]::mouse_event(0x8, 0, 0, 0, $marker) }
    '^ru$'  { [M]::mouse_event(0x10, 0, 0, 0, $marker) }
    '^wait(\d+)$' { Start-Sleep -Milliseconds ([int]$Matches[1]) }
    '^mv(-?\d+)_(-?\d+)$' { [M]::mouse_event(0x1, [int]$Matches[1], [int]$Matches[2], 0, $marker); Start-Sleep -Milliseconds 4 }
    '^wheel(-?\d+)$' { [M]::mouse_event(0x800, 0, 0, [int]$Matches[1], $marker) }
    '^pos$' { $p = New-Object M+POINT; [void][M]::GetCursorPos([ref]$p); Write-Output "$($p.X),$($p.Y)" }
    '^setpos(-?\d+)_(-?\d+)$' { [void][M]::SetCursorPos([int]$Matches[1], [int]$Matches[2]) }
    '^spi$' {
      $m = New-Object int[] 3; [void][M]::SystemParametersInfo(3, 0, $m, 0)
      $sp = 0; [void][M]::SystemParametersInfo(0x70, 0, [ref]$sp, 0)
      $ln = 0; [void][M]::SystemParametersInfo(0x68, 0, [ref]$ln, 0)
      Write-Output "$($m[2]),$sp,$ln"
    }
  }
}
