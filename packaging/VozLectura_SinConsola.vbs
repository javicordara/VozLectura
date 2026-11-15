Option Explicit

Dim fso, shell, scriptDir, baseDir, parentDir, pywExe, localVenvPyw, srcVenvPyw
Dim binDir, envProcess, portFile, ts, portStr, psPortCmd, psWaitCmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
baseDir = scriptDir
pywExe = fso.BuildPath(baseDir, "python\pythonw.exe")

If Not fso.FileExists(fso.BuildPath(baseDir, "backend\main.py")) And fso.FileExists(fso.BuildPath(baseDir, "..\start_windows.bat")) And Not fso.FileExists(pywExe) Then
    parentDir = fso.GetParentFolderName(baseDir)
    srcVenvPyw = fso.BuildPath(parentDir, ".venv\Scripts\pythonw.exe")
    localVenvPyw = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\VozLectura\.venv\Scripts\pythonw.exe")

    If fso.FileExists(srcVenvPyw) Then
        baseDir = parentDir
        pywExe = srcVenvPyw
    ElseIf fso.FileExists(localVenvPyw) Then
        baseDir = parentDir
        pywExe = localVenvPyw
    Else
        shell.CurrentDirectory = parentDir
        shell.Run "cmd /c """ & fso.BuildPath(parentDir, "start_windows.bat") & """", 1, False
        WScript.Quit
    End If
ElseIf Not fso.FileExists(pywExe) Then
    If fso.FileExists(fso.BuildPath(baseDir, ".venv\Scripts\pythonw.exe")) Then
        pywExe = fso.BuildPath(baseDir, ".venv\Scripts\pythonw.exe")
    Else
        pywExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\VozLectura\.venv\Scripts\pythonw.exe")
    End If
End If

shell.CurrentDirectory = baseDir

binDir = fso.BuildPath(baseDir, "bin")
If fso.FolderExists(binDir) Then
    Set envProcess = shell.Environment("PROCESS")
    envProcess("PATH") = binDir & ";" & envProcess("PATH")
End If

If Not fso.FolderExists(fso.BuildPath(baseDir, "data")) Then
    fso.CreateFolder(fso.BuildPath(baseDir, "data"))
End If

portStr = shell.Environment("PROCESS")("VOZLECTURA_PORT")
If Len(Trim(portStr)) = 0 Then
    portFile = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "vozlectura_port.tmp")
    If fso.FileExists(portFile) Then fso.DeleteFile portFile, True
    psPortCmd = "powershell -NoProfile -WindowStyle Hidden -Command ""$free = 8086; foreach ($p in 8085..8095) { $busy = $false; foreach ($h in @('127.0.0.1','::1')) { $c = New-Object System.Net.Sockets.TcpClient; try { $c.Connect($h, $p); $c.Close(); $busy = $true; break } catch { try { $c.Close() } catch {} } }; if (-not $busy) { $free = $p; break } }; Set-Content -Path '" & portFile & "' -Value $free -Encoding ASCII"""
    shell.Run psPortCmd, 0, True
    portStr = "8086"
    If fso.FileExists(portFile) Then
        Set ts = fso.OpenTextFile(portFile, 1)
        If Not ts.AtEndOfStream Then portStr = Trim(ts.ReadLine)
        ts.Close
        fso.DeleteFile portFile, True
    End If
End If

If fso.FileExists(pywExe) Then
    shell.Run """" & pywExe & """ -m uvicorn backend.main:app --host 0.0.0.0 --port " & portStr, 0, False
Else
    shell.Run "cmd /c python -m uvicorn backend.main:app --host 0.0.0.0 --port " & portStr, 0, False
End If

psWaitCmd = "powershell -NoProfile -WindowStyle Hidden -Command ""for ($i=0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; try { $r = Invoke-WebRequest -Uri ('http://127.0.0.1:" & portStr & "/api/ping') -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { Start-Process ('http://localhost:" & portStr & "'); break } } catch {} }"""
shell.Run psWaitCmd, 0, False
