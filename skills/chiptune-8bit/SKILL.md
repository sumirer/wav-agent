---
name: 8bit 芯片音乐
description: 红白机 / GameBoy 风格的方波音乐与音效，包含音阶、和弦与脉冲波用法
---

# 8bit 芯片音乐

## 音色规则
老式芯片只有脉冲波、三角波和噪声三个声道，必须严格遵守：

- **旋律**：`waveform: "pulse"`，`pulseWidth` 取 0.25 或 0.125（占空比越小音色越"细"越有年代感）。
- **低音**：`waveform: "triangle"`，低频铺底，不要用 sine（芯片上没有）。
- **打击乐**：`waveform: "noise"` 配合极短的 amplitudeCurve，不要用 lowpass（芯片上也没有）。
- **允许的效果**：bitcrush（4~8 bit）、轻微 distortion。**不要使用 reverb 和 delay**，会立刻失去芯片味。
- 声像：单声道输出（channels: 1）最还原。

## 音阶换算（A4 = 440Hz）
| 音名 | 频率 | 音名 | 频率 |
| --- | --- | --- | --- |
| C4 | 261.6 | C5 | 523.3 |
| D4 | 293.7 | D5 | 587.3 |
| E4 | 329.6 | E5 | 659.3 |
| F4 | 349.2 | F5 | 698.5 |
| G4 | 392.0 | G5 | 784.0 |
| A4 | 440.0 | A5 | 880.0 |
| B4 | 493.9 | B5 | 987.8 |

## 编曲结构
用多个 layer 表达多个"声道"，每个 layer 用 startTime / endTime 控制它出现的时段：

- 主旋律层：0.5~1.5s
- 副旋律（三度或五度叠加）：略微错开 20~40ms 制造合唱感
- 低音层：每 0.25s 一个音符，用 amplitudeCurve 断奏
- 打击层：在 1/4 拍位置放极短的 noise

## 硬性要求
- `channels: 1`，`normalize: true`。
- 每个音符层都要有 envelope：`{attack: 0.005, decay: 0.08, sustain: 0.5, release: 0.08}` 是安全起点。
- 节拍按 120~150 BPM 计算，1 拍 = 60/BPM 秒，写 startTime 时直接用这个换算。
- 生成前先用一句话说明你选了什么调式和节奏，再调用工具。
