VATFLOW Tower Cab - ARTCC video maps
====================================

The maps CRC shows (each ARTCC's vNAS video maps) on the tower cab's DBRITE and ASDE-X.
This folder is its own Community package: keep it in your MSFS Community folder next to
"vatflow-towercab". Updating the cab never touches it.

Add or update an ARTCC
  1. The ARTCC file is the one CRC uses, e.g. ZTL.json. CRC keeps it on your PC under
       %LOCALAPPDATA%\CRC   (in its ARTCCs folder)
     (paste that into the File Explorer address bar). It is there once you have opened
     that ARTCC in CRC.
  2. Double-click update-maps.bat. It finds the ARTCC files in CRC's folder and asks which
     to copy (type ZTL, or ALL). You can also put a .json yourself into the "ARTCC files"
     folder here and just press Enter, or type an ARTCC id to download it from vNAS.
  3. Restart MSFS the first time this package is in Community (MSFS only reads Community
     when it starts); after that, adding or updating an ARTCC only needs a new flight.
     The map drawings are downloaded live from vNAS when a screen shows them, so only the
     ARTCC file is needed here. If the MAPS screen says no maps are installed, the DETAILS
     at its end say what the cab tried.

In the cab
  DBRITE: MAPS tab (bottom right, next to MENU) lists the TRACON's STARS maps (by STARS
  number) and the tower cab maps. Tap to turn them on / off. Presets are named after the
  facility's runway configurations (e.g. WEST, EAST): tap SAVE, then a preset, to store
  the maps that are on; tap a preset to switch. With no map on, the built-in map shows.
  ASDE-X: MAPS picks the facility's ASDE-X map (the default), a cab map, or the built-in one.
  Choices are kept per airport.

