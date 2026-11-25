"""Render a narrated walkthrough. Usage: python render.py <output-directory>."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import wave

from PIL import Image, ImageDraw, ImageFont

SCENES = [
    (
        "Two different races",
        "Prefill reads the whole prompt. Decode predicts one new token at a time. An engine can win one race and lose the other. We time both, with fresh caches and the same model weights.",
        ["PREFILL", "DECODE"],
    ),
    (
        "Send work to the right experts",
        "Each position calls eight experts. In a long prompt, neighboring positions can ask for different experts. Grouping the requests by expert lets the GPU read the same packed weights for many positions. The inverse index puts each result back where it belongs.",
        ["ROUTE", "GROUP", "RESTORE"],
    ),
    (
        "Fit the tile to the work",
        "A GPU matrix tile is fast when its rows are full. But expert groups have uneven lengths. The engine uses a smaller matrix tile for the final few rows. It computes the same routed experts without paying for as many empty slots.",
        ["64 rows", "16 rows", "8 rows"],
    ),
    (
        "Keep intermediate values nearby",
        "The expansion kernel computes the gate and the up projection together, applies the activation, and writes only the result. Later, another kernel combines the eight expert outputs, applies the short causal filter, and adds the residual. Fewer round trips to memory; no experts skipped.",
        ["EXPAND + ACTIVATE", "CONTRACT", "MIX + FIR + ADD"],
    ),
    (
        "Prove it end to end",
        "Microbenchmarks tell us what to try, not what to ship. We alternate the independent engine and the reference, exclude cold runs, and score held-out continuations. A separate fifty-thousand-token run checks what changes after the prompt no longer fits in a short attention window.",
        ["SAME PROMPT", "FRESH CACHE", "HELD-OUT QUALITY"],
    ),
    (
        "Route indices, not copies",
        "The newer engine carries an index instead of making eight copies of a token row. Each expert reads the original row when its tile needs it, then writes its answer directly to the token and rank that requested it. During single-token four-bit decode, the same GPU dispatch can contract the experts, mix their answers, and update the filter history.",
        ["READ TOKEN ROW", "EXPERT TILE", "WRITE TOKEN + RANK"],
    ),
    (
        "One target still out of reach",
        "On the sixteen-token prompt, the engines start producing different words at token eighteen. To compare decode fairly, we must feed both engines the same tokens. At one thousand and eight tokens, decode is about thirty-eight percent faster, but prefill is only twenty-six percent faster. On fourteen held-out prompts, one of two hundred and twenty-four next-token choices differs. That is a quality check on these prompts, not a proof of identical outputs.",
        ["PREFILL", "DECODE"],
    ),
    (
        "At 50,000 tokens, the result flips",
        "Now move the same engine to fifty thousand tokens. On the observatory prompt, prefill reached two hundred twenty-seven tokens per second versus eighty-eight. But generating the next tokens was four percent slower than the reference. Both found the violet locker and agreed on all sixty-four predictions. The machine was paging. With both engines limited to the same unused memory pool, the gains changed to twenty-two percent for prefill and thirty-three percent for decode. Neither setting clears both targets.",
        ["PREFILL", "DECODE"],
    ),
    (
        "Two rows can carry 48 messages",
        "Between passes, each token sends forty-eight messages. But every message is just a different weighted sum of the same two source rows. Instead of writing forty-eight wide vectors, the fused engine keeps the two rows and forty-eight pairs of numbers. A gate rebuilds its own message when it needs it. The checkpoint's paired gate matrices also fit exactly in bfloat sixteen. We check that before packing them, and accumulate their products in float thirty-two.",
        ["SOURCE A", "SOURCE B", "GATE 7"],
    ),
    (
        "Keep a whole head together",
        "In attention, two groups used to calculate halves of a dot product, then exchange their results. Now a single group calculates the complete dot. Other groups work on different query rows. Nothing is skipped: at fifty thousand tokens, global attention still reads the full causal history. The test is the whole engine: on a thousand and eight tokens, matched-input replay measured twenty-nine percent faster prefill and thirty-six percent faster decode. Close, but not both thirty.",
        ["SPLIT DOT", "WHOLE DOT"],
    ),
    (
        "Give each tile more useful work",
        "The next change is in the attention projections, not the attention scores. A tile now handles sixty-four prompt positions and sixty-four output channels. Every block still reads the same packed four-bit weights, scales, and biases. The larger tile reuses each input across more products. On the thousand-token prompt, both orders of fixed-input replay cleared thirty percent in both phases. At sixteen thousand tokens prefill passed, but decode missed in the first run. This kernel does not run during single-token decode.",
        ["64 positions", "64 channels"],
    ),
    (
        "Why replay matters at 50,000 tokens",
        "Back to the fused engine, before the wider projection tiles. At fifty thousand tokens, the two engines first disagreed at output four. Timing their own continuations would then compare different work. In replay, both still predict and synchronize at every step, but the next input always comes from the reference trace. With equal unused-buffer caps, that measured thirty-two percent faster prefill and thirty-one percent faster decode. On a separate fifty-thousand-token ledger amendment, both predicted all six answer tokens. Neither result proves identical answers in general.",
        ["PREFILL", "DECODE"],
    ),
    (
        "Two gate decisions from one input",
        "A wider prompt tile cannot help when there is just one new token. So during decode, eight lanes split a sixty-four-value input between them. Each lane reads its eight values once and accumulates two answers: how much of the current state to keep and how much of a message to add. They combine the partial sums in single precision. The weights are packed only if they round-trip exactly. On the thousand-and-eight-token replay, this engine decoded forty-one percent faster than the reference. That number measures the whole engine, not the gate in isolation.",
        ["FORGET", "MESSAGE"],
    ),
    (
        "What the final engine demonstrated",
        "The same paired-gate engine cleared both targets at all four lengths, in both process orders, with matched inputs. At fifty thousand tokens the smaller decode gain was thirty point two seven percent: a narrow margin, not a guarantee. Both long suites used the same unused-buffer cap for both engines. On six new prompts written after the gate was frozen, seventy-two of seventy-four next-token choices matched. On a separate fifty-thousand-token correction, both got all six answer tokens. The result is faster inference under the tested conditions, not identical text on every prompt.",
        ["16", "1,008", "16,384", "50,000"],
    ),
]
BG = "#11151a"
PANEL = "#202932"
WHITE = "#f2f5f1"
MINT = "#94e6b7"
MUTED = "#acb8c0"
AMBER = "#f7c381"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def frame(i, title, labels):
    img = Image.new("RGB", (1280, 720), BG)
    d = ImageDraw.Draw(img)

    def text(x, y, s, size=26, color=WHITE, bold=False):
        d.text(
            (x, y), s, font=ImageFont.truetype(BOLD if bold else FONT, size), fill=color
        )

    def box(x, y, w, h, col=PANEL):
        d.rounded_rectangle((x, y, x + w, y + h), 12, fill=col)

    text(68, 54, "ENGINE NOTES    /    INKLING-2-MINI", 22, MINT, True)
    text(68, 119, title, 56, WHITE, True)
    if i == 0:
        for j, label in enumerate(labels):
            y = 260 + j * 145
            text(75, y, label, 27, MUTED, True)
            for k in range(11 if not j else 5):
                x = 320 + k * (64 if not j else 145)
                box(x, y - 5, 48, 48, MINT if not j else AMBER)
                if j and k < 4:
                    text(x + 63, y, "→", 30, MUTED)
        text(320, 490, "one prediction feeds the next", 24, MUTED)
    elif i == 1:
        colors = [MINT, AMBER, "#9dbaf9"]
        routes = [0, 1, 0, 2, 2, 1, 0, 2, 0, 1, 2, 1]
        for j, seq in enumerate((routes, sorted(routes), routes)):
            y = 245 + j * 99
            text(75, y, labels[j], 25, MUTED, True)
            for k, c in enumerate(seq):
                box(322 + k * 64, y - 2, 48, 40, colors[c])
    elif i == 2:
        for j, count in enumerate((64, 16, 6)):
            x = 100 + j * 405
            text(x, 235, labels[j], 30, MUTED, True)
            for k in range((64, 16, 8)[j]):
                box(
                    x + k % 8 * 30,
                    298 + k // 8 * 25,
                    24,
                    19,
                    MINT if k < count else PANEL,
                )
        text(
            75, 552, "Three example groups: 64, 16, and 6 live rows.", 26, WHITE
        )
    elif i == 8:
        for j, label in enumerate(labels[:2]):
            y = 235 + j * 90
            box(76, y, 240, 64)
            text(104, y + 16, label, 25, MINT, True)
            d.line((322, y + 32, 410, 312), fill=MUTED, width=3)
        box(410, 270, 450, 84)
        text(433, 290, "message = a × A + b × B", 30, WHITE, True)
        d.line((861, 312, 942, 312), fill=MUTED, width=3)
        box(945, 277, 205, 68)
        text(978, 295, labels[2], 27, AMBER, True)
        text(78, 452, "Keep 48 pairs of coefficients, not 48 full vectors.", 32, WHITE)
        text(78, 526, "No message or gate is dropped.", 26, MUTED)
    elif i == 9:
        for j, label in enumerate(labels):
            y = 238 + j * 100
            text(76, y + 10, label, 24, MUTED, True)
            if j == 0:
                box(300, y, 185, 56); box(500, y, 185, 56)
                text(324, y + 12, "channels 1–64", 20, WHITE)
                text(511, y + 12, "channels 65–128", 20, WHITE)
                text(726, y + 10, "→  exchange partial sums", 25, AMBER)
            else:
                box(300, y, 385, 56, MINT)
                text(350, y + 10, "all 128 channels", 26, BG, True)
                text(726, y + 10, "→  one score", 25, WHITE)
        text(76, 493, "1,008-token fixed-input replay: +28.8% prefill  /  +36.0% decode", 28, WHITE)
        text(76, 550, "Packaged fused engine vs MLX-LM, warm BAAB.", 24, MUTED)
    elif i == 10:
        for j in range(8):
            for k in range(8):
                box(100 + k * 32, 248 + j * 32, 26, 26, MINT)
        text(97, 533, "Each square: 8 × 8 products", 24, MUTED)
        text(455, 256, "64 prompt positions × 64 channels", 35, WHITE, True)
        text(455, 325, "Step through 32 input channels at a time.", 27, MUTED)
        text(455, 392, "Same 4-bit weights, scales, and biases.", 27, MUTED)
        text(455, 492, "1,008 tokens  /  matched replay", 26, WHITE, True)
        text(455, 541, "Prefill: +30.08% ABBA, +31.65% BAAB", 26, MINT)
    elif i == 11:
        text(75, 213, "Fused engine  /  same reference tokens fed to both arms", 28, MUTED)
        for j, (label, gain, rate) in enumerate(zip(labels, ("+32.32%", "+30.78%"), ("393.24 vs 297.18 tok/s", "29.60 vs 22.64 tok/s"), strict=True)):
            y = 287 + j * 99
            box(75, y, 1110, 74)
            text(100, y + 19, label, 28, WHITE, True)
            text(380, y + 18, rate, 30, WHITE)
            text(897, y + 18, gain, 32, MINT, True)
        text(75, 504, "Prediction 4 differed. Both still processed identical decode inputs.", 27, WHITE)
        text(75, 558, "M4 Pro, 1,024-token chunks; 512 MiB unused allocator cap on both.", 24, MUTED)
    elif i == 12:
        text(76, 216, "64 inputs split across eight lanes", 30, WHITE, True)
        for lane in range(8):
            x = 76 + lane * 145
            box(x, 277, 128, 63)
            text(x + 13, 291, f"{8*lane}–{8*lane+7}", 26, MINT)
        for j, label in enumerate(labels):
            x = 76 + j * 568
            box(x, 395, 540, 73)
            text(x + 18, 414, label + "  /  FP32 sum", 27, WHITE, True)
        text(76, 532, "1,008 tokens: 41.60 vs 29.45 decode tokens/s (matched ABBA)", 29, MINT)
    elif i == 13:
        text(75, 198, "Smaller measured gain across the two process orders", 29, MUTED)
        for x, label in ((85, "Prompt tokens"), (530, "Prefill"), (860, "Decode")):
            text(x, 263, label, 24, MUTED, True)
        for j, (length, pre, dec) in enumerate(zip(labels, (36.31, 32.80, 34.15, 33.95), (42.42, 41.26, 37.16, 30.27), strict=True)):
            y = 302 + j * 55
            box(75, y, 1115, 49)
            text(85, y + 7, length, 27, WHITE)
            text(530, y + 7, f"+{pre:.2f}%", 27, MINT, True)
            text(860, y + 7, f"+{dec:.2f}%", 27, MINT, True)
        text(75, 556, "Long runs: 512 MiB unused pool per arm. Short runs: default.", 25, MUTED)
    elif i == 7:
        text(75, 218, "Direct engine vs MLX-LM   /   warm median tokens per second", 27, MUTED)
        for j, (metric, rates, gain) in enumerate(zip(labels, ("226.75  vs  87.84", "7.77  vs  8.11"), ("+158.1%", "−4.2%"), strict=True)):
            y = 292 + 100 * j
            box(75, y, 1100, 76)
            text(100, y + 20, metric, 28, MUTED, True)
            text(395, y + 17, rates, 34, WHITE, True)
            text(900, y + 17, gain, 34, MINT if not j else AMBER, True)
        text(76, 500, "Default allocator above; both engines produced the same 64 tokens.", 25, MUTED)
        text(76, 550, "512 MiB unused pool for both: +22.3% prefill  /  +33.0% decode", 25, WHITE)
    elif i == 6:
        text(75, 210, "1,008-token prompt / gain over MLX-LM", 27, MUTED)
        for j, (label, gain) in enumerate(zip(labels, (25.8, 37.6), strict=True)):
            y = 302 + j * 100
            text(75, y, label, 26, WHITE, True)
            box(280, y, gain * 18, 38, AMBER if j == 0 else MINT)
            text(1040, y, f"+{gain:.1f}%", 26, WHITE, True)
        d.line((820, 278, 820, 474), fill=WHITE, width=3)
        text(790, 488, "30% target", 24, MUTED)
    else:
        for j, label in enumerate(labels):
            x = 75 + j * 395
            box(x, 277, 350, 130)
            text(x + 20, 291, f"0{j + 1}", 23, MINT)
            text(x + 20, 343, label, 25, WHITE, True)
        text(
            75,
            490,
            "Write the activated tensor, not the expanded pair."
            if i == 3
            else ("Keep the eight-expert reduction in its original rank order." if i == 5 else "Compare warm prefill and decode separately."),
            30,
            MUTED,
        )
    for j in range(len(SCENES)):
        box(70 + j * (940 // len(SCENES)), 648, 940 // len(SCENES) - 12, 5, MINT if j <= i else PANEL)
    text(1080, 632, f"{i + 1:02d}  /  {len(SCENES):02d}", 24, MUTED)
    return img


def audio(text, path):
    if path.exists() and path.stat().st_size > 44:
        return
    req = urllib.request.Request(
        "https://api.vogent.ai/api/tts",
        data=json.dumps(
            {"text": text, "voiceId": "60a373ab-cea3-44a4-8577-808247d2d189"}
        ).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["VOGENT_API_KEY"],
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
    with wave.open(io.BytesIO(raw)) as source:
        pcm = source.readframes(source.getnframes())
        params = source.getparams()
    tmp = path.with_suffix(".part")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(pcm)
    tmp.replace(path)


def main():
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    clips = []
    for i, (title, script, labels) in enumerate(SCENES):
        wav = out / (hashlib.sha256(script.encode()).hexdigest()[:12] + ".wav")
        audio(script, wav)
        img = out / f"scene-{i}.png"
        frame(i, title, labels).save(img)
        clip = out / f"scene-{i}.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-loglevel",
                "error",
                "-y",
                "-loop",
                "1",
                "-framerate",
                "12",
                "-i",
                str(img),
                "-i",
                str(wav),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-threads",
                "2",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                str(clip),
            ],
            check=True,
        )
        clips.append(clip)
    (out / "clips.txt").write_text("".join(f"file '{c.name}'\n" for c in clips))
    subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(out / "clips.txt"),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(out / "inkling-engine.mp4"),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
