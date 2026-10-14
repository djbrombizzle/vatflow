VATFLOW Tower Cab - placement
=============================

First time
  1-setup.bat        installs what the tool needs (needs Python; it tells you if it's missing)
  2-adjust-KDCA.bat  with the cab loaded in MSFS: jumps onto the DCA tower and freezes.
                     Then type, and press Enter after each:
                       u 3 / d 3      up / down 3 ft
                       f 2 / b 2      forward / back 2 m
                       l 2 / r 2      left / right 2 m
                       t 10           turn 10 deg (t -10 turns left)
                       h 121          face 121 deg true
                       save           remember this spot
                       q              quit (the cab stays frozen)

Every session
  3-place-KDCA.bat   jumps to the saved spot and freezes. That's it.

Other
  capture-KDCA.bat   saves wherever the cab is now (after moving it with slew mode)
  release.bat        unfreezes the cab

The saved spot is in towers.json next to these files.
In MSFS turn crash damage OFF (Assistance), or touching the real tower ends the flight.
