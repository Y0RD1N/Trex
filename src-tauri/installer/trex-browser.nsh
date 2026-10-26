; Browser-only entry point. The shared implementation is self-contained in the
; historical CLI hook so the existing isolated CLI harness can copy that file.
!ifndef TREX_BROWSER_INCLUDED
  !define TREX_BROWSER_ONLY
  !include "${__FILEDIR__}\trex-cli.nsh"
  !undef TREX_BROWSER_ONLY
!endif