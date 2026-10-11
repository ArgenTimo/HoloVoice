; HoloVoice NSIS hooks.
; Before install/uninstall: stop the computer-sound helper (a running exe blocks overwriting it).
; On uninstall: give other apps their volume back (the helper turns them down while computer sound is captured;
; normally it restores them itself) and remove the autostart entry of the desktop widget.

!macro customInit
  nsExec::Exec 'taskkill /f /im holo-sysaudio.exe'
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /f /im holo-sysaudio.exe'
  IfFileExists "$INSTDIR\resources\holo-sysaudio.exe" 0 +2
    ExecWait '"$INSTDIR\resources\holo-sysaudio.exe" --restore'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "work.skotwind.holovoice"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "HoloVoice"
!macroend
