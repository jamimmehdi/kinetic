param([string]$Dir)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
}
"@
$form = New-Object System.Windows.Forms.Form
$form.Text = "Kinetic E2E target"; $form.Width = 520; $form.Height = 260; $form.StartPosition = "CenterScreen"
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.Dock = "Fill"; $box.Font = New-Object System.Drawing.Font("Consolas", 14)
$form.Controls.Add($box)
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 100
$timer.Add_Tick({ [IO.File]::WriteAllText("$Dir\out.txt", $box.Text) })
$timer.Start()
$form.Add_Shown({
  $form.TopMost = $true; $form.Activate()
  # A tap of Alt lets this process take the foreground from a background launch.
  [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][W]::SetForegroundWindow($form.Handle); $box.Focus()
  [IO.File]::WriteAllText("$Dir\ready.txt", "1")
})
# Stop file ends the form from the outside.
$stop = New-Object System.Windows.Forms.Timer; $stop.Interval = 200
$stop.Add_Tick({ if (Test-Path "$Dir\stop.txt") { $form.Close() } })
$stop.Start()
[void]$form.ShowDialog()
