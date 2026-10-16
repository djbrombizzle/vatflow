"""
Writes the windshear alarm loop the sim plays from the cab's sound folder (sound.xml,
WaveData slot custom_warning_cockpit_sound_01, while L:VATFLOW_WS_ALERT is 1):
package/SimObjects/Airplanes/vatflow_tower_cab/common/sound/vatflow_windshear.wav
(16-bit PCM mono, 44.1 kHz, as the sim's WaveData sounds want)

A repetitive high-pitched electronic beeping, like an LLWAS alarm in the background of a
tower cab: one second, looped by the screen while the alert shows: three short 2.9 kHz
beeps (square-ish, a little 5.8 kHz edge) with soft starts and ends, then a pause, at about
-11 dBFS peak: clearly heard in the background of the cab.

  python tools/make_alert_sound.py
"""
import math
import os
import struct
import wave

RATE = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "package", "SimObjects", "Airplanes", "vatflow_tower_cab",
                   "common", "sound", "vatflow_windshear.wav")


def main():
    beeps = [(0.00, 0.11), (0.17, 0.11), (0.34, 0.11)]      # start, length (s) within the 1 s loop
    n = RATE
    data = []
    for i in range(n):
        t = i / RATE
        v = 0.0
        for start, length in beeps:
            if start <= t < start + length:
                u = t - start
                env = min(1.0, u / 0.006, (length - u) / 0.006)
                x = 2 * math.pi * 2900 * u
                v = env * (math.sin(x) + 0.3 * math.sin(3 * x) + 0.12 * math.sin(2 * x))
        data.append(int(max(-1, min(1, v / 1.42 * 0.28)) * 32767))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with wave.open(OUT, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", s) for s in data))
    print("Wrote", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
