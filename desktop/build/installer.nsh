; Instalador exportado por um host: a configuração dele vem anexada no fim do .exe
; numa linha "#DLOCAL1#<base64>#END#" (ver electron/embed.cjs). Aqui ela é copiada
; para $INSTDIR\conexao.cfg, onde o app procura ao abrir.
!macro customInstall
  Push $0
  Push $1
  Push $2
  Push $3
  ClearErrors
  FileOpen $0 "$EXEPATH" r
  IfErrors dlocal_done
  FileSeek $0 -4096 END
  StrCpy $3 0
  dlocal_loop:
    IntOp $3 $3 + 1
    IntCmp $3 600 dlocal_close 0 dlocal_close
    ClearErrors
    FileRead $0 $1
    IfErrors dlocal_close
    StrCpy $2 $1 9
    StrCmp $2 "#DLOCAL1#" 0 dlocal_loop
    FileOpen $2 "$INSTDIR\conexao.cfg" w
    FileWrite $2 $1
    FileClose $2
  dlocal_close:
    FileClose $0
  dlocal_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
