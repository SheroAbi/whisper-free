' ============================================================================
'  Creates a Desktop + Start-Menu shortcut for Whisper Free.
'
'  Points straight at Electron's GUI binary (node_modules\electron\dist\
'  electron.exe), a /SUBSYSTEM:WINDOWS executable, so launching it never opens
'  a console/terminal. The prebuilt app (out\) loads directly; the Python
'  sidecar venv + model load happen in the background behind the loading screen.
'
'    cscript //nologo scripts\create-shortcut.vbs
' ============================================================================

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root      = fso.GetParentFolderName(scriptDir)
electron  = root & "\node_modules\electron\dist\electron.exe"
icon      = root & "\build\icon.ico"

If Not fso.FileExists(electron) Then
  WScript.Echo "ERROR: Electron not found at " & electron & " (run 'npm install')."
  WScript.Quit 1
End If

Sub MakeLink(linkPath)
  Set sc = shell.CreateShortcut(linkPath)
  sc.TargetPath       = electron
  sc.Arguments        = """" & root & """"   ' app directory -> package.json "main"
  sc.WorkingDirectory = root                 ' so the engine finds python\ and python\.venv
  sc.Description       = "Whisper Free - local speech-to-text"
  sc.WindowStyle       = 1
  If fso.FileExists(icon) Then sc.IconLocation = icon & ",0"
  sc.Save
  WScript.Echo "Created: " & linkPath
End Sub

' Remove shortcuts left over from the app's previous name.
For Each old In Array(shell.SpecialFolders("Desktop") & "\Parakeet Dictation.lnk", _
                      shell.SpecialFolders("Programs") & "\Parakeet Dictation.lnk")
  If fso.FileExists(old) Then fso.DeleteFile old
Next

MakeLink shell.SpecialFolders("Desktop")  & "\Whisper Free.lnk"
MakeLink shell.SpecialFolders("Programs") & "\Whisper Free.lnk"

WScript.Echo ""
WScript.Echo "Done. Double-click the Desktop icon to start (no terminal)."
