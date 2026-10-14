"""
Writes placement/cab_fan.wav: a quiet, seamless 30 s loop of ventilation fan noise
(soft broadband air rush plus a faint motor hum) that tower_place.py plays while the
cab is placed. The loop is built in the frequency domain, so it repeats without a click.

  python tools/make_fan_sound.py
"""

import os
import wave

import numpy as np

RATE = 22050
SECONDS = 30
LEVEL_DBFS = -28.0     # quiet: background fan, not a feature


def main():
    n = RATE * SECONDS
    rng = np.random.default_rng(7)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1.0 / RATE)
    # air rush: pinkish, rolled off above ~1.5 kHz and below ~60 Hz
    shape = 1.0 / np.sqrt(np.maximum(f, 20.0))
    shape *= 1.0 / (1.0 + (f / 1500.0) ** 2)
    shape *= (f / 60.0) ** 2 / (1.0 + (f / 60.0) ** 2)
    air = np.fft.irfft(spec * shape, n)
    air /= np.abs(air).max()
    t = np.arange(n) / RATE
    # motor / blade hum: whole number of cycles in the loop, so it is seamless too
    hum = 0.10 * np.sin(2 * np.pi * 120 * t) + 0.05 * np.sin(2 * np.pi * 240 * t)
    sig = air + hum
    sig *= 10 ** (LEVEL_DBFS / 20) / np.abs(sig).max()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "placement", "cab_fan.wav")
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((sig * 32767).astype("<i2").tobytes())
    print("wrote", os.path.normpath(out))


if __name__ == "__main__":
    main()
