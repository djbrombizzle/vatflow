# Windshear alarm sound (Wwise package)

The cab's screens can't play sound themselves (the sim's screen browser has no audio), so
the windshear alarm plays through the sim's own sound system: a small Wwise package,
`VATFLOW_TowerCab.PC.PCK`, built once on your PC. After that the installer puts it in the cab
by itself, and the Community package you hand out to testers carries it.

What the cab does with it: while the TWR INFO screen's windshear alert sounds,
`L:VATFLOW_WS_ALERT` is 1, and `sound.xml` (tools/sound-alarm.xml) plays the looping event
`Play_VATFLOW_TowerCab_windshear_alarm`. MUTE (screen or red button) sets it back to 0.

You need: the MSFS 2024 SDK (you have it), and Wwise at the version the SDK's sound docs ask
for (MSFS 2024 docs: Wwise 2022.1.13, build 8454; check "Using Wwise" in the SDK docs in case
it changed). The sound to use is `windshear.wav` in this folder.

Names must match exactly (sound-alarm.xml uses them):

| What | Name |
|---|---|
| Soundbank | `VATFLOW_TowerCab` |
| Event | `Play_VATFLOW_TowerCab_windshear_alarm` |
| Package file | `VATFLOW_TowerCab.PC.PCK` |

## Steps

1. **Install Wwise.** Get the Audiokinetic Launcher (audiokinetic.com, free account), and in
   it install Wwise **2022.1.13 build 8454** (the version the MSFS 2024 SDK docs name). Tick
   "Authoring" and the Windows platform.
2. **Get the SDK's Wwise sample project.** In MSFS 2024 with Developer Mode on: Help >
   Samples. Run the installer in the zip it downloads; the `WwiseSampleProject` lands in the
   SDK's `Wwise` folder. Copy that whole folder somewhere of your own, e.g.
   `C:\MSFS-Projects\VatflowTowerCab\Wwise\WwiseSampleProject` (keep the SDK's copy clean).
3. **Open it** in Wwise (double-click the `.wproj`). Don't start a new project: the sim only
   knows the sample's buses.
4. **Sound.** In the Project Explorer > Audio tab, right-click "Actor-Mixer Hierarchy" > New
   Child > Work Unit, name it `VATFLOW_TowerCab`. Drag `windshear.wav` (this folder) onto it:
   it becomes a Sound SFX "windshear".
   - In its Property Editor: **Loop: Infinite** (General Settings tab).
   - **Output Bus**: use the same bus as one of the sample project's cockpit / avionics
     warning sounds (open one in the sample's own Actor-Mixer work units, look at its Output
     Bus, pick that same one for yours).
   - Volume: start at 0 dB; adjust later if it's too loud or soft in the cab.
5. **Event.** Events tab > right-click "Events" > New Child > Work Unit `VATFLOW_TowerCab`.
   Right-click the work unit > New Child > Event, name it exactly
   **`Play_VATFLOW_TowerCab_windshear_alarm`**. Drag the "windshear" sound onto the event:
   the action becomes "Play" with the sound as its target.
6. **Soundbank.** SoundBanks tab > right-click "SoundBanks" > New Child > Work Unit, then in it
   New Child > SoundBank named exactly **`VATFLOW_TowerCab`**. Open the SoundBank and drag the
   Events work unit `VATFLOW_TowerCab` into it.
7. **Generate.** Layouts > SoundBank (F7), tick the `VATFLOW_TowerCab` bank and the Windows
   platform, click **Generate**. It should finish with no errors.
8. **Package.** Start `FilePackager.App.exe` from your Wwise install folder (under
   `Authoring\x64\Release\bin`). File > Open `PCK_PC.wfpproj` in the sample project folder.
   Add a new package named **`VATFLOW_TowerCab.PC.PCK`**, drag the `VATFLOW_TowerCab` bank
   into it, then Generate. The file appears in the sample project's `GeneratedSoundbanks`
   folder.
9. **Put it in the cab.** Copy `VATFLOW_TowerCab.PC.PCK` into this folder
   (`C:\MSFS-Projects\VatflowTowerCab\sound-package\`), next to this README.
10. **Install and build.** Run the cab's `install.bat` again (it now says "windshear alarm only"
    for the sound folder), then in the Project Editor **Clean All, Build All**.
11. **Test.** In the cab, TWR INFO > the windshear alert needs a sudden wind change of 15 kt;
    to hear it right away, set `L:VATFLOW_WS_ALERT` to 1 in the sim's Behaviors debug window
    (Developer Mode > Tools > Behaviors > Local Variables), and 0 to stop it.

## If it doesn't play

- **Wrong names:** the most common cause. Check the three names in the table, including
  capital letters.
- **Sound bank missing:** in Developer Mode open the Console (Tools > Console) and look for
  `VATFLOW_TowerCab` errors.
- **Silent despite a loaded bank:** the Output Bus isn't one the sim plays. Pick the bus of a
  sample sound you know you can hear.
- **Rebuild after every change:** after any Wwise change, Generate again (step 7), repackage
  (step 8), copy (step 9), install and build again.
